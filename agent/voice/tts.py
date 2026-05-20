"""
voice/tts.py — Text-to-Speech con Piper TTS o Edge TTS
"""
import subprocess
import tempfile
import os
import sys
import sounddevice as sd
import soundfile as sf
import numpy as np
from pathlib import Path

# Ensure agent root is importable
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import load_config


class PiperTTS:
    def __init__(self):
        cfg = load_config()["tts"]
        self.voice = cfg.get("voice", "es_ES-mls-medium")
        self.rate = cfg.get("rate", 1.0)
        self.piper_path = self._find_piper()
        self.model_path = self._find_model()
        print(f"[TTS] Piper listo con voz '{self.voice}'.")

    def _find_piper(self) -> str:
        candidates = [
            r"C:\piper\piper.exe",
            Path.home() / "piper" / "piper.exe",
            Path(__file__).parents[1] / "piper" / "piper.exe",
        ]
        for path in candidates:
            if Path(path).exists():
                return str(path)
        raise FileNotFoundError(
            "No se encontró piper.exe. Ejecutá setup.bat para instalarlo."
        )

    def _find_model(self) -> str:
        model_file = f"{self.voice}.onnx"
        candidates = [
            Path.home() / "piper" / "models" / model_file,
            Path(__file__).parents[1] / "piper" / "models" / model_file,
            r"C:\piper\models" / Path(model_file),
        ]
        for path in candidates:
            if Path(path).exists():
                return str(path)
        raise FileNotFoundError(
            f"No se encontró el modelo {model_file}. Ejecutá setup.bat para descargarlo."
        )

    def generate(self, text: str) -> tuple[np.ndarray, int]:
        """Sintetiza texto y retorna (audio_data, samplerate) sin reproducir."""
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            proc = subprocess.run(
                [self.piper_path, "--model", self.model_path, "--output_file", tmp_path],
                input=text.encode("utf-8"),
                capture_output=True,
                timeout=15,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"Piper error: {proc.stderr.decode()}")
            data, samplerate = sf.read(tmp_path)
            return data, samplerate
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    def speak(self, text: str) -> None:
        if not text.strip():
            return
        print(f"[TTS] '{text[:70]}'" if len(text) > 70 else f"[TTS] '{text}'")
        data, samplerate = self.generate(text)
        sd.play(data, samplerate)
        sd.wait()


class EdgeTTS:
    def __init__(self):
        import edge_tts  # noqa: F401
        cfg = load_config()["tts"]
        self.voice = cfg.get("voice", "es-AR-ElenaNeural")
        rate_mult = float(cfg.get("rate", 1.0))
        pct = int((rate_mult - 1.0) * 100)
        self.rate = f"+{pct}%" if pct >= 0 else f"{pct}%"
        print(f"[TTS] Edge TTS listo — voz '{self.voice}', velocidad {self.rate}.")

    def generate(self, text: str) -> tuple[np.ndarray, int]:
        """Sintetiza texto y retorna (audio_data, samplerate) sin reproducir."""
        import asyncio
        import edge_tts

        async def _gen():
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                tmp_path = tmp.name
            communicate = edge_tts.Communicate(text, self.voice, rate=self.rate)
            await communicate.save(tmp_path)
            return tmp_path

        tmp_path = asyncio.run(_gen())
        try:
            data, sr = sf.read(tmp_path)
            return data, sr
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    def speak(self, text: str) -> None:
        """Sintetiza y reproduce, además streams la amplitud al dashboard."""
        import threading
        import time
        import requests as req

        if not text.strip():
            return

        print(f"[TTS] '{text[:70]}'" if len(text) > 70 else f"[TTS] '{text}'")

        data, sr = self.generate(text)

        # Mono
        mono = data.mean(axis=1) if len(data.shape) > 1 else data

        # Stream amplitud al dashboard a 20 fps
        fps = 20
        chunk = max(1, sr // fps)
        amplitudes = [
            min(1.0, float(np.sqrt(np.mean(mono[i:i + chunk] ** 2))) * 12)
            for i in range(0, len(mono), chunk)
        ]

        def _stream():
            interval = 1 / fps
            for amp in amplitudes:
                try:
                    req.post("http://localhost:7777/waveform",
                             json={"amplitude": amp}, timeout=0.05)
                except Exception:
                    pass
                time.sleep(interval)

        threading.Thread(target=_stream, daemon=True).start()
        sd.play(data, sr)
        sd.wait()


def get_tts():
    cfg = load_config()["tts"]
    engine = cfg.get("engine", "piper")
    if engine == "piper":
        return PiperTTS()
    elif engine == "edge-tts":
        return EdgeTTS()
    else:
        raise ValueError(f"Motor TTS desconocido: {engine}")
