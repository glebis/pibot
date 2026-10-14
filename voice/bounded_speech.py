"""Reserve actual outbound speech-provider payloads before sending them."""
import asyncio
from pipecat.frames.frames import ErrorFrame
from pipecat.services.deepgram.stt import DeepgramSTTService, EventType
from pipecat.services.deepgram.tts import DeepgramTTSService
from costs import TTS_MAX_UTF8_BYTES

class SpeechBudget:
    def __init__(self,duration):
        self.audio_remaining=int(duration)*16000*2
        self.text_remaining=TTS_MAX_UTF8_BYTES
    def audio(self,payload):
        if len(payload)>self.audio_remaining:return False
        self.audio_remaining-=len(payload);return True
    def text(self,value):
        count=len(value.encode('utf8'))
        if count>self.text_remaining:return False
        self.text_remaining-=count;return True

class BoundedSTT(DeepgramSTTService):
    def __init__(self,*,budget,**kwargs):
        self.budget=budget
        super().__init__(sample_rate=16000,**kwargs)
    async def run_stt(self,audio):
        if not self.budget.audio(audio):
            yield ErrorFrame(error='Speech input budget reached',fatal=True);return
        async for frame in super().run_stt(audio):yield frame
    async def _connection_handler(self):
        # Installed Pipecat1.0.0 normally reconnects indefinitely. A single
        # connection avoids multiplying any provider minimum billable duration.
        try:
            async with self._client.listen.v1.connect(**self._build_connect_kwargs()) as connection:
                self._connection=connection
                connection.on(EventType.MESSAGE,self._on_message)
                connection.on(EventType.ERROR,self._on_error)
                keepalive=self.create_task(self._keepalive_handler())
                try:await connection.start_listening()
                finally:await self.cancel_task(keepalive)
        except asyncio.CancelledError:raise
        except Exception:await self.push_frame(ErrorFrame(error='Speech connection ended',fatal=True))
        finally:self._connection=None

class BoundedTTS(DeepgramTTSService):
    def __init__(self,*,budget,**kwargs):
        self.budget=budget;super().__init__(**kwargs)
    async def run_tts(self,text,context_id):
        if not self.budget.text(text):
            yield ErrorFrame(error='Speech output budget reached',fatal=True);return
        async for frame in super().run_tts(text,context_id):yield frame
