"""Offline read-aloud helper. Utterances are accepted only on stdin."""
from __future__ import annotations

import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import wave

MAX_TEXT = 16000
MAX_PHONEMES = 480
VOICE = re.compile(r"^[a-z]{2}_[a-z0-9_]{1,48}$")


class SpeechStopped(BaseException):
    pass


def model_paths():
    cache = Path.home() / ".cache" / "kokoro-onnx"
    return cache / "kokoro-v1.0.onnx", cache / "voices-v1.0.bin"


def readiness():
    model, voices = model_paths()
    if not model.is_file() or not voices.is_file() or model.stat().st_size == 0 or voices.stat().st_size == 0:
        return {"available": False, "backend": "say", "reason": "model_files_missing"}
    if importlib.util.find_spec("kokoro_onnx") is None or importlib.util.find_spec("numpy") is None:
        return {"available": False, "backend": "say", "reason": "runtime_missing"}
    return {"available": True, "backend": "kokoro"}


def voice_id():
    selected = os.environ.get("KOKORO_VOICE_ID", "af_heart")
    if not VOICE.fullmatch(selected):
        raise ValueError("Invalid voice selection")
    control = Path.home() / ".pipecat-mcp-server" / "kokoro_voice"
    try:
        fd = os.open(control, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022 and info.st_size <= 128:
                value = stream.read(129).strip()
                if VOICE.fullmatch(value):
                    selected = value
    except (OSError, UnicodeError):
        pass
    return selected


def phoneme_chunks(phonemes):
    """Keep every phoneme, including overlong words, below ONNX's token limit."""
    while len(phonemes) > MAX_PHONEMES:
        cut = phonemes.rfind(" ", 0, MAX_PHONEMES + 1)
        if cut < MAX_PHONEMES // 2:
            cut = MAX_PHONEMES
        chunk, phonemes = phonemes[:cut], phonemes[cut:]
        if chunk.strip():
            yield chunk
    if phonemes.strip():
        yield phonemes


def trash(directory):
    if directory is not None:
        subprocess.run(["/usr/bin/trash", str(directory)], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=True)


class Playback:
    def __init__(self):
        self.player = None
        self.stopped = False
        self.starting = False

    def stop_player(self):
        player, self.player = self.player, None
        if player is not None and player.poll() is None:
            player.terminate()
            try:
                player.wait(timeout=2)
            except subprocess.TimeoutExpired:
                player.kill()
                player.wait(timeout=2)

    def interrupt(self, _signum, _frame):
        if self.stopped:
            return
        self.stopped = True
        self.stop_player()
        if not self.starting:
            raise SpeechStopped()


def synthesize_and_play(text):
    # Kokoro debug messages can contain utterances/phonemes. Keep them disabled.
    logging.disable(logging.CRITICAL)
    from loguru import logger
    logger.remove()
    from kokoro_onnx import Kokoro
    import numpy as np

    owned = Playback()
    previous = {sig: signal.signal(sig, owned.interrupt) for sig in (signal.SIGTERM, signal.SIGINT)}
    directory = None
    try:
        model, voices = model_paths()
        kokoro = Kokoro(str(model), str(voices))
        selected = voice_id()
        if selected not in kokoro.voices:
            raise ValueError("Unavailable voice selection")
        languages = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr", "h": "hi", "i": "it", "j": "ja", "p": "pt", "z": "zh"}
        language = languages.get(selected[0], "en-us")
        phonemes = kokoro.tokenizer.phonemize(text, language)
        directory = Path(tempfile.mkdtemp(prefix="pibot-kokoro-"))
        for index, chunk in enumerate(phoneme_chunks(phonemes)):
            samples, rate = kokoro.create(chunk, voice=selected, lang=language, is_phonemes=True)
            audio = directory / f"part-{index}.wav"
            fd = os.open(audio, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                with wave.open(stream, "wb") as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(int(rate))
                    output.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
            # Defer raising until the newly spawned child is recorded as owned.
            owned.starting = True
            try:
                owned.player = subprocess.Popen(["/usr/bin/afplay", str(audio)], stdin=subprocess.DEVNULL,
                                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            finally:
                owned.starting = False
            if owned.stopped:
                owned.stop_player()
                raise SpeechStopped()
            if owned.player.wait() != 0:
                raise RuntimeError("Local playback failed")
            owned.player = None
    finally:
        try:
            owned.stop_player()
            trash(directory)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv not in ([], ["--check"]):
        print("Unsupported speech request.", file=sys.stderr)
        return 1
    try:
        state = readiness()
        if argv == ["--check"]:
            print(json.dumps(state))
            return 0
        if not state["available"]:
            # Preserve stdin and process ownership; never forward utterances in argv.
            os.execv("/usr/bin/say", ["/usr/bin/say", "-f", "-"])
            return 0
        text = sys.stdin.read(MAX_TEXT + 2)
        if text.endswith("\n"):
            text = text[:-1]
        if len(text) > MAX_TEXT:
            raise ValueError("Utterance too long")
        if not text.strip():
            return 0
        synthesize_and_play(text)
        return 0
    except SpeechStopped:
        return 0
    except Exception:
        print("Local Kokoro speech failed. Check its cached model and audio output.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
