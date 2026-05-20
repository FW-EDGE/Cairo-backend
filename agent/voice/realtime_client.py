"""
voice/realtime_client.py — GPT-4o Realtime API client para CAIRO

Elimina completamente el pipeline STT → LLM → TTS.
El audio del micrófono va directo al modelo y la respuesta llega
como audio en tiempo real, con latencia típica de 500ms–1.5s.
"""
import asyncio
import base64
import json
import queue
import threading
from typing import Callable

import numpy as np
import sounddevice as sd
import websockets
import requests as _req

# Modelo Realtime y parámetros de audio
REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17"
MIC_RATE     = 24000               # Hz — la API exige PCM16 a 24 kHz
MIC_CHUNK    = int(MIC_RATE * 0.05)  # 50 ms por chunk de micrófono

# Tiempo que el mic permanece bloqueado DESPUÉS de que termina el audio de Cairo.
# Evita que el VAD capture el eco residual o el ruido de sala.
MIC_COOLDOWN = 1.5   # segundos

# Alucinaciones conocidas de Whisper en audio silencioso o de baja calidad.
# Whisper las genera cuando recibe silencio, eco o ruido de fondo.
_WHISPER_HALLUCINATIONS = {
    "subtítulos realizados por la comunidad de amara.org",
    "subtítulos por la comunidad de amara.org",
    "cc por antarctica films argentina",
    "amara.org",
    "gracias por ver el video",
    "gracias por ver",
    "suscríbete al canal",
    "subtítulos en español",
    "transcripción automática",
}


# ── Reproductor de audio streaming ────────────────────────────────────────────

class _StreamPlayer:
    """
    Reproduce audio PCM16 en tiempo real usando el callback de OutputStream.
    Los chunks se encolan y el callback de sounddevice los consume sin gaps.

    Sentinel: player.mark_done(cb) encola un None. Cuando ese None sale
    por el parlante, llama cb() — así el unmute ocurre en el momento exacto.
    """

    def __init__(self, sample_rate: int = 24000, block_size: int = 1200):
        self._sr      = sample_rate
        self._bs      = block_size
        self._q: "queue.Queue[np.ndarray | None]" = queue.Queue(maxsize=500)
        self._res     = np.array([], dtype=np.int16)
        self._stream: sd.OutputStream | None = None
        self._on_done: "Callable | None" = None
        self.playing  = False

    def _callback(self, outdata, frames, _time, _status):
        out = np.zeros(frames, dtype=np.int16)
        pos = 0

        if len(self._res) > 0:
            take = min(len(self._res), frames)
            out[pos:pos + take] = self._res[:take]
            self._res = self._res[take:]
            pos += take

        while pos < frames:
            try:
                chunk = self._q.get_nowait()
                if chunk is None:
                    cb = self._on_done
                    self._on_done = None
                    if cb:
                        cb()
                    break
                take = min(len(chunk), frames - pos)
                out[pos:pos + take] = chunk[:take]
                if take < len(chunk):
                    self._res = np.concatenate([self._res, chunk[take:]])
                pos += take
            except queue.Empty:
                break

        outdata[:, 0] = out

    def start(self):
        if self.playing:
            return
        self._stream = sd.OutputStream(
            samplerate=self._sr,
            channels=1,
            dtype="int16",
            blocksize=self._bs,
            callback=self._callback,
        )
        self._stream.start()
        self.playing = True

    def feed(self, pcm16_bytes: bytes):
        arr = np.frombuffer(pcm16_bytes, dtype=np.int16)
        try:
            self._q.put_nowait(arr)
        except queue.Full:
            pass

    def mark_done(self, on_complete: "Callable | None" = None):
        self._on_done = on_complete
        self._q.put(None)

    def stop(self):
        if not self.playing:
            return
        self._on_done = None
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break
        self._res = np.array([], dtype=np.int16)
        if self._stream:
            try:
                self._stream.abort()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        self.playing = False


# ── Conversión de tools LangChain → OpenAI Realtime ──────────────────────────

def _lc_tools_to_openai(tools: list) -> list[dict]:
    result = []
    for t in tools:
        if hasattr(t, "args_schema") and t.args_schema:
            raw    = t.args_schema.schema()
            params = {
                "type":       "object",
                "properties": raw.get("properties", {}),
            }
            if raw.get("required"):
                params["required"] = raw["required"]
        else:
            params = {"type": "object", "properties": {}}
        result.append({
            "type":        "function",
            "name":        t.name,
            "description": t.description,
            "parameters":  params,
        })
    return result


# ── Cliente principal ──────────────────────────────────────────────────────────

class CairoRealtime:
    """
    Cliente GPT-4o Realtime para CAIRO.
    Conecta el micrófono directamente al modelo via WebSocket.

    Anti-echo: mientras Cairo habla, _unmute_at se fija en el futuro.
    El callback del mic compara monotonic() < _unmute_at y si es True
    no envía nada al servidor. Cuando el playback termina (sentinel),
    _unmute_at = monotonic() + MIC_COOLDOWN. Sin booleanos, sin race conditions.
    """

    def __init__(
        self,
        api_key:       str,
        system_prompt: str,
        tools:         list,
        on_state:      Callable[[str, str, str], None] | None = None,
        voice:         str   = "verse",
        temperature:   float = 0.6,
        context:       str   = "",
        wake_word:     str   = "",
    ):
        self._api_key  = api_key
        self._prompt   = system_prompt
        self._tools    = tools
        self._tool_map = {t.name: t for t in tools}
        self._state_cb = on_state or (lambda s, i, r: None)
        self._voice    = voice
        self._temp     = temperature
        self._context  = context
        self._wake_word = wake_word.lower().strip()

        self._unmute_at: float = 0.0
        self._active_until: float = 0.0
        self._active_window = 30.0  # segundos

    # ── Punto de entrada ───────────────────────────────────────────────────────

    def run(self):
        """Bloquea el hilo actual corriendo el loop de Realtime. Reconecta automáticamente."""
        import time
        while True:
            try:
                asyncio.run(self._main())
                print("[Realtime] Reconectando...")
            except KeyboardInterrupt:
                print("[Realtime] Cerrando.")
                break
            except Exception as e:
                print(f"[Realtime] Desconectado ({e}). Reconectando en 3s...")
                time.sleep(3)

    # ── Loop principal ─────────────────────────────────────────────────────────

    async def _main(self):
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "OpenAI-Beta":   "realtime=v1",
        }
        print("[Realtime] Conectando a GPT-4o Realtime API...")
        async with websockets.connect(
            REALTIME_URL,
            additional_headers=headers,
            max_size=None,
            ping_interval=20,
            ping_timeout=30,
        ) as ws:
            await self._configure(ws)
            if self._context:
                await self._inject_context(ws)
            print("[Realtime] CAIRO en linea — habla cuando quieras.")
            self._state_cb("idle", "", "")
            await asyncio.gather(
                self._mic_loop(ws),
                self._event_loop(ws),
            )

    # ── Configuración de sesión ────────────────────────────────────────────────

    async def _configure(self, ws):
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "modalities":                ["text", "audio"],
                "instructions":              self._prompt,
                "voice":                     self._voice,
                "input_audio_format":        "pcm16",
                "output_audio_format":       "pcm16",
                "input_audio_transcription": {"model": "whisper-1", "language": "es"},
                "turn_detection": {
                    "type":                "server_vad",
                    "threshold":           0.5,
                    "prefix_padding_ms":   300,
                    "silence_duration_ms": 500,
                },
                "tools":       _lc_tools_to_openai(self._tools),
                "tool_choice": "auto",
                "temperature": max(0.6, self._temp),
            },
        }))

    # ── Inyección de contexto grande ──────────────────────────────────────────

    async def _inject_context(self, ws):
        """
        Inyecta el árbol de Drive como dos mensajes separados:
        uno para Mi Drive y otro para Compartidos.
        """
        SPLIT_MARKER = "Compartidos conmigo:"
        ctx = self._context

        if SPLIT_MARKER in ctx:
            idx           = ctx.index(SPLIT_MARKER)
            mydrive_part  = ctx[:idx].rstrip()
            shared_part   = ctx[idx:]
        else:
            mydrive_part  = ctx
            shared_part   = ""

        chunks = [
            ("Mi Drive",            mydrive_part),
            ("Compartidos conmigo", shared_part),
        ] if shared_part else [
            ("Google Drive", mydrive_part),
        ]

        for title, chunk in chunks:
            if not chunk.strip():
                continue
            print(f"[Realtime] Inyectando contexto '{title}': {len(chunk)} chars...")
            await ws.send(json.dumps({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": (
                            f"Contexto de Google Drive — sección {title}. "
                            "Usalo para responder preguntas y buscar archivos. "
                            "No respondas a este mensaje.\n\n"
                            + chunk
                        ),
                    }],
                },
            }))
            await ws.send(json.dumps({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": f"Sección {title} cargada."}],
                },
            }))

        print(f"[Realtime] Contexto inyectado en {len(chunks)} sección(es).")

    # ── Streaming del micrófono ────────────────────────────────────────────────

    async def _mic_loop(self, ws):
        import time as _t
        loop = asyncio.get_event_loop()

        def callback(indata, frames, _time, _status):
            if _t.monotonic() < self._unmute_at:
                return
            pcm16 = (indata[:, 0] * 32767).astype(np.int16).tobytes()
            b64   = base64.b64encode(pcm16).decode()
            asyncio.run_coroutine_threadsafe(
                ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": b64})),
                loop,
            )

        with sd.InputStream(
            samplerate=MIC_RATE,
            channels=1,
            dtype="float32",
            blocksize=MIC_CHUNK,
            callback=callback,
        ):
            await asyncio.sleep(float("inf"))

    # ── Loop de eventos ────────────────────────────────────────────────────────

    async def _event_loop(self, ws):
        import time as _t

        loop            = asyncio.get_event_loop()
        player          = _StreamPlayer(MIC_RATE)
        resp_text       = ""
        input_text      = ""
        resp_sent       = False
        pending_cancel  = False

        async for raw in ws:
            ev = json.loads(raw)
            t  = ev.get("type", "")

            if t == "input_speech_started":
                if self._unmute_at > _t.monotonic() + 10:
                    print("[RT] input_speech_started ignorado (mic bloqueado)")
                    try:
                        await ws.send(json.dumps({"type": "input_audio_buffer.clear"}))
                    except Exception:
                        pass
                else:
                    print("[RT] Voz detectada")
                    self._state_cb("listening", "", "")
                    player.stop()
                    player = _StreamPlayer(MIC_RATE)
                    self._unmute_at = 0.0

            elif t == "input_speech_ended":
                self._state_cb("thinking", input_text, "")
                self._unmute_at = _t.monotonic() + 999.0
                resp_sent      = False
                pending_cancel = bool(self._wake_word) and (_t.monotonic() >= self._active_until)
                try:
                    await ws.send(json.dumps({"type": "input_audio_buffer.clear"}))
                except Exception:
                    pass

            elif t == "conversation.item.input_audio_transcription.completed":
                input_text = ev.get("transcript", "").strip()
                _lo = input_text.lower().strip(".,¿?!¡ ")
                _is_hallucination = (
                    not input_text
                    or len(_lo) <= 1
                    or any(h in _lo for h in _WHISPER_HALLUCINATIONS)
                )
                if _is_hallucination:
                    if input_text:
                        print(f"[RT] Alucinación filtrada: '{input_text}'")
                    input_text = ""
                    pending_cancel = False
                    try:
                        await ws.send(json.dumps({"type": "response.cancel"}))
                    except Exception:
                        pass
                if input_text:
                    print(f"[Vos] {input_text}")
                    if self._wake_word:
                        now      = _t.monotonic()
                        has_wake = self._wake_word in input_text.lower()
                        is_active = now < self._active_until

                        if has_wake or is_active:
                            self._active_until = now + self._active_window
                            remaining = int(self._active_until - now)
                            print(f"[RT] {'Wake word' if has_wake else 'Ventana activa'} — {remaining}s restantes")
                            pending_cancel = False
                        else:
                            print("[RT] Modo pasivo — cancelando respuesta")
                            pending_cancel = False
                            try:
                                await ws.send(json.dumps({"type": "response.cancel"}))
                            except Exception:
                                pass

            elif t == "response.audio.delta":
                chunk = base64.b64decode(ev["delta"])
                if not player.playing:
                    print("[RT] Cairo empieza a hablar — mic bloqueado")
                    player.start()
                    self._unmute_at = _t.monotonic() + 999.0
                    self._state_cb("speaking", input_text, "")
                    try:
                        await ws.send(json.dumps({"type": "input_audio_buffer.clear"}))
                    except Exception:
                        pass
                player.feed(chunk)

            elif t == "response.audio_transcript.delta":
                resp_text += ev.get("delta", "")

            elif t == "response.audio.done":
                if not player.playing:
                    print("[RT] response.audio.done sin audio — mic abierto")
                    self._unmute_at = 0.0
                else:
                    _play_done = asyncio.Event()

                    def _on_playback_done():
                        loop.call_soon_threadsafe(_play_done.set)

                    player.mark_done(_on_playback_done)

                    async def _post_playback(evt=_play_done):
                        await evt.wait()
                        print(f"[RT] Playback terminado — cooldown {MIC_COOLDOWN}s")
                        try:
                            await ws.send(json.dumps({"type": "input_audio_buffer.clear"}))
                        except Exception:
                            pass
                        self._unmute_at = _t.monotonic() + MIC_COOLDOWN
                        await asyncio.sleep(MIC_COOLDOWN)
                        self._unmute_at = 0.0
                        print("[RT] Mic abierto")

                    asyncio.ensure_future(_post_playback())

            elif t == "response.audio_transcript.done":
                resp_text = ev.get("transcript", resp_text).strip()
                if resp_text:
                    print(f"[Cairo] {resp_text}")
                    self._state_cb("speaking", input_text, resp_text)

            elif t == "response.done":
                resp_text  = ""
                input_text = ""
                self._state_cb("idle", "", "")
                if not player.playing and self._unmute_at > _t.monotonic() + 10:
                    print("[RT] response.done sin audio — mic abierto (fallback)")
                    self._unmute_at = 0.0

            elif t == "response.function_call_arguments.done":
                name    = ev.get("name", "")
                call_id = ev.get("call_id", "")
                try:
                    args = json.loads(ev.get("arguments", "{}"))
                except Exception:
                    args = {}

                print(f"[Tool] -> {name}({args})")
                result = await asyncio.get_event_loop().run_in_executor(
                    None, self._run_tool, name, args
                )
                print(f"[Tool] <- {str(result)[:120]}")

                await ws.send(json.dumps({
                    "type": "conversation.item.create",
                    "item": {
                        "type":    "function_call_output",
                        "call_id": call_id,
                        "output":  str(result),
                    },
                }))
                await ws.send(json.dumps({"type": "response.create"}))

            elif t == "error":
                err  = ev.get("error", {})
                code = err.get("code", "?")
                print(f"[Realtime] Error: {code} — {err.get('message', ev)}")
                if code == "session_expired":
                    print("[Realtime] Sesión expirada (60 min). Reconectando...")
                    await ws.close()
                    return

    # ── Ejecución de tools ─────────────────────────────────────────────────────

    def _run_tool(self, name: str, args: dict) -> str:
        tool = self._tool_map.get(name)
        if not tool:
            return f"Herramienta '{name}' no encontrada."
        try:
            return str(tool.invoke(args))
        except Exception as e:
            return f"Error ejecutando {name}: {e}"
