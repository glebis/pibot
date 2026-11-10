"""Synthetic-only tests; no model generation, downloads or audio playback."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("kokoro_read_aloud", Path(__file__).with_name("kokoro-read-aloud.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class SpeechTests(unittest.TestCase):
    def test_check_does_not_read_stdin_or_generate(self):
        output = io.StringIO()
        with patch.object(helper, "readiness", return_value={"available": False, "backend": "say", "reason": "model_files_missing"}), patch.object(helper, "synthesize_and_play") as synth, patch.object(sys, "stdin", Mock(read=Mock(side_effect=AssertionError("stdin consumed")))), contextlib.redirect_stdout(output):
            self.assertEqual(helper.main(["--check"]), 0)
        self.assertIn('"model_files_missing"', output.getvalue())
        synth.assert_not_called()

    def test_missing_models_exec_say_without_consuming_or_exposing_stdin(self):
        with patch.object(helper, "readiness", return_value={"available": False}), patch.object(helper.os, "execv") as execute, patch.object(sys, "stdin", Mock(read=Mock(side_effect=AssertionError("stdin consumed")))):
            self.assertEqual(helper.main([]), 0)
        execute.assert_called_once_with("/usr/bin/say", ["/usr/bin/say", "-f", "-"])

    def test_kokoro_failure_never_falls_back_or_exposes_exception(self):
        error = io.StringIO()
        with patch.object(helper, "readiness", return_value={"available": True}), patch.object(helper, "synthesize_and_play", side_effect=ValueError("private utterance")), patch.object(sys, "stdin", io.StringIO("private utterance")), patch.object(helper.os, "execv") as execute, contextlib.redirect_stderr(error):
            self.assertEqual(helper.main([]), 1)
        execute.assert_not_called()
        self.assertNotIn("private utterance", error.getvalue())

    def test_maximum_text_accepts_the_transport_newline(self):
        text = "x" * helper.MAX_TEXT
        with patch.object(helper, "readiness", return_value={"available": True}), patch.object(helper, "synthesize_and_play") as synth, patch.object(sys, "stdin", io.StringIO(text + "\n")):
            self.assertEqual(helper.main([]), 0)
        synth.assert_called_once_with(text)

    def test_long_input_is_rejected_before_generation(self):
        with patch.object(helper, "readiness", return_value={"available": True}), patch.object(helper, "synthesize_and_play") as synth, patch.object(sys, "stdin", io.StringIO("x" * (helper.MAX_TEXT + 1))), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(helper.main([]), 1)
        synth.assert_not_called()

    def test_chunking_keeps_all_phonemes_even_for_overlong_words(self):
        text = "a" * 1200 + " " + "b" * 400
        chunks = list(helper.phoneme_chunks(text))
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(len(c) <= helper.MAX_PHONEMES for c in chunks))

    def test_stop_terminates_only_owned_player(self):
        owned = helper.Playback()
        player = Mock()
        player.poll.return_value = None
        owned.player = player
        with self.assertRaises(helper.SpeechStopped):
            owned.interrupt(None, None)
        player.terminate.assert_called_once()
        player.kill.assert_not_called()
        self.assertIsNone(owned.player)
        owned.interrupt(None, None)
        player.terminate.assert_called_once()

    def test_stop_escalates_only_stuck_owned_player(self):
        owned = helper.Playback()
        player = Mock()
        player.poll.return_value = None
        player.wait.side_effect = [subprocess.TimeoutExpired("afplay", 2), 0]
        owned.player = player
        owned.stop_player()
        player.kill.assert_called_once()

    def test_synthesis_uses_private_wavs_and_cleans_on_playback_failure(self):
        import numpy as np
        kokoro = Mock()
        kokoro.voices = {"af_heart": object()}
        kokoro.tokenizer.phonemize.return_value = "a" * 1000
        kokoro.create.return_value = (np.zeros(5), 24000)
        module = types.SimpleNamespace(Kokoro=Mock(return_value=kokoro))
        player = Mock()
        player.wait.return_value = 1
        player.poll.return_value = 1
        paths = []
        original_open = helper.os.open
        def opened(path, flags, *args):
            paths.append((Path(path), args[0] if args else None))
            return original_open(path, flags, *args)
        with patch.dict(sys.modules, {"kokoro_onnx": module}), patch.object(helper, "voice_id", return_value="af_heart"), patch.object(helper.subprocess, "Popen", return_value=player), patch.object(helper.os, "open", side_effect=opened), patch.object(helper, "trash") as cleanup:
            with self.assertRaisesRegex(RuntimeError, "playback failed"):
                helper.synthesize_and_play("Synthetic speech")
        cleanup.assert_called_once()
        directory = cleanup.call_args.args[0]
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        wav_path, mode = next((path, mode) for path, mode in paths if path.suffix == ".wav")
        self.assertEqual(mode, 0o600)
        self.assertEqual(wav_path.stat().st_mode & 0o777, 0o600)
        self.assertLessEqual(len(kokoro.create.call_args.args[0]), 480)

    def test_successful_synthesis_keeps_all_long_input_chunks(self):
        import numpy as np
        kokoro = Mock()
        kokoro.voices = {"af_heart": object()}
        kokoro.tokenizer.phonemize.return_value = "a" * 1200
        kokoro.create.return_value = (np.zeros(5), 24000)
        module = types.SimpleNamespace(Kokoro=Mock(return_value=kokoro))
        player = Mock()
        player.wait.return_value = 0
        with patch.dict(sys.modules, {"kokoro_onnx": module}), patch.object(helper, "voice_id", return_value="af_heart"), patch.object(helper.subprocess, "Popen", return_value=player) as launch, patch.object(helper, "trash") as cleanup:
            helper.synthesize_and_play("Synthetic speech")
        self.assertEqual("".join(call.args[0] for call in kokoro.create.call_args_list), "a" * 1200)
        self.assertEqual(launch.call_count, 3)
        cleanup.assert_called_once()

    def test_trash_does_not_use_shell_or_utterance(self):
        with patch.object(helper.subprocess, "run") as execute:
            helper.trash(Path("/tmp/synthetic-private-dir"))
        self.assertEqual(execute.call_args.args[0], ["/usr/bin/trash", "/tmp/synthetic-private-dir"])
        self.assertNotIn("shell", execute.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
