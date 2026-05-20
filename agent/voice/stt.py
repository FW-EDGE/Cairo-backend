"""
voice/stt.py — Speech-to-Text con faster-whisper
"""
import sys
from collections import deque
from pathlib import Path

from faster_whisper import WhisperModel
import numpy as np
import sounddevice as sd

# Ensure agent root is importable
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import load_config


class WhisperSTT:
    def __init__(self):
        cfg = load_config()["stt"]
        model_size = cfg.get("model", "base")
        print(f"[STT] Cargando faster-whisper '{model_size}'...")
        self.model = WhisperModel(model_size, device="cpu", compute_type="int8")
        self.language      = cfg.get("language", "es")
        self.sample_rate   = 16000
        self.threshold     = cfg.get("silence_threshold", 0.015)
        self.silence_secs  = cfg.get("silence_duration", 0.4)
        self.pre_timeout   = cfg.get("pre_speech_timeout", 10.0)
        self.max_duration  = cfg.get("max_duration", 30.0)
        self.beam_size     = cfg.get("beam_size", 1)
        print("[STT] Listo.")

    def record_until_silence(self) -> np.ndarray | None:
        """
        Fase 1 — espera hasta detectar voz (hasta pre_timeout segundos).
                  Mantiene un pre-buffer de 300ms para no cortar el inicio de palabras.
        Fase 2 — graba hasta que hay silencio prolongado o se alcanza max_duration.
        Retorna None si no se detecta voz.
        """
        chunk_size          = int(self.sample_rate * 0.1)   # 100 ms por chunk
        silence_chunks_need = max(1, round(self.silence_secs / 0.1))
        pre_max             = int(self.pre_timeout  / 0.1)
        speech_max          = int(self.max_duration / 0.1)

        # Pre-buffer circular: guarda los últimos 300ms antes de que empiece la voz.
        # Esto evita cortar el ataque de la primera sílaba.
        PRE_BUFFER_SIZE = 3  # 3 × 100ms = 300ms
        pre_buffer = deque(maxlen=PRE_BUFFER_SIZE)

        chunks        = []
        silent_chunks = 0
        speech_found  = False

        with sd.InputStream(samplerate=self.sample_rate, channels=1, dtype="float32") as stream:
            # ── Fase 1: esperar que empiece la voz ──────────────────
            print("[STT] Esperando voz...")
            for _ in range(pre_max):
                chunk, _ = stream.read(chunk_size)
                rms = float(np.sqrt(np.mean(chunk ** 2)))
                pre_buffer.append(chunk)
                if rms >= self.threshold:
                    speech_found = True
                    # Incluir el pre-buffer para no perder el inicio
                    chunks.extend(pre_buffer)
                    print("[STT] Voz detectada, grabando...")
                    break

            if not speech_found:
                return None

            # ── Fase 2: grabar hasta silencio ───────────────────────
            for _ in range(speech_max):
                chunk, _ = stream.read(chunk_size)
                rms = float(np.sqrt(np.mean(chunk ** 2)))
                chunks.append(chunk)
                if rms < self.threshold:
                    silent_chunks += 1
                    if silent_chunks >= silence_chunks_need:
                        break
                else:
                    silent_chunks = 0

        return np.concatenate(chunks, axis=0).flatten()

    def transcribe(self, audio: np.ndarray) -> str:
        segments, _ = self.model.transcribe(
            audio,
            language=self.language,
            beam_size=self.beam_size,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=200),
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
        )
        text = " ".join(seg.text for seg in segments).strip()
        print(f"[STT] '{text}'")
        return text

    def listen(self) -> str:
        audio = self.record_until_silence()
        if audio is None:
            return ""
        return self.transcribe(audio)
