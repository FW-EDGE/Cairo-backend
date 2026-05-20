"""
main.py — Punto de entrada de CAIRO

Modos:
  realtime: true  → GPT-4o Realtime API (audio directo, ~1s latencia)
  realtime: false → Pipeline clásico STT → LLM → TTS (~4-6s latencia)

Configurar en config.yaml bajo la clave `realtime.enabled`.
"""
import re
import queue
import threading
import requests as _requests
import sounddevice as sd

from config import load_config


# ── Notificaciones al dashboard ────────────────────────────────────────────────

def _notify(status: str, last_input: str = "", last_response: str = ""):
    try:
        _requests.post(
            "http://localhost:7777/state",
            json={"status": status, "last_input": last_input, "last_response": last_response},
            timeout=0.3,
        )
    except Exception:
        pass


def _start_heartbeat():
    """Pulsa /heartbeat cada 5 segundos mientras CAIRO está corriendo."""
    import time, threading

    def _beat():
        while True:
            try:
                _requests.post("http://localhost:7777/heartbeat", timeout=0.3)
            except Exception:
                pass
            time.sleep(5)

    t = threading.Thread(target=_beat, daemon=True)
    t.start()


def _log(message: str):
    try:
        _requests.post("http://localhost:7777/log", json={"message": message}, timeout=0.3)
    except Exception:
        pass


# ── TTS streaming (modo clásico) ───────────────────────────────────────────────

_SENTENCE_RE = re.compile(r'(?<=[.!?…])\s+')


def _split_sentences(text: str) -> list[str]:
    """Parte el texto en oraciones, agrupando las muy cortas con la siguiente."""
    raw    = [s.strip() for s in _SENTENCE_RE.split(text.strip()) if s.strip()]
    merged: list[str] = []
    buf    = ""
    for s in raw:
        buf = (buf + " " + s).strip() if buf else s
        if len(buf) >= 12:
            merged.append(buf)
            buf = ""
    if buf:
        if merged:
            merged[-1] += " " + buf
        else:
            merged.append(buf)
    return merged


def speak_streaming(tts, text: str) -> None:
    """
    Reproduce el texto oración por oración con overlap:
    mientras suena la oración N, ya se genera la N+1.
    """
    if not text.strip():
        return

    sentences = _split_sentences(text)

    if len(sentences) <= 1:
        tts.speak(text)
        return

    audio_q: queue.Queue = queue.Queue(maxsize=2)

    def generator():
        for sent in sentences:
            try:
                audio_q.put(tts.generate(sent))
            except Exception as e:
                print(f"[TTS] Error generando: {e}")
        audio_q.put(None)

    def player():
        while True:
            item = audio_q.get()
            if item is None:
                break
            data, sr = item
            sd.play(data, sr)
            sd.wait()

    gen_t  = threading.Thread(target=generator, daemon=True)
    play_t = threading.Thread(target=player,    daemon=True)
    gen_t.start()
    play_t.start()
    gen_t.join()
    play_t.join()


# ── Modo Realtime ──────────────────────────────────────────────────────────────


def _main_realtime(cfg: dict):
    """
    Modo Realtime: audio del micrófono va directo a GPT-4o vía WebSocket.
    No usa Whisper ni TTS local. Latencia ~500ms–1.5s.
    """
    from voice.realtime_client import CairoRealtime
    from agent import ALL_TOOLS, build_compact_drive_tree

    rt_cfg  = cfg.get("realtime", {})
    oai_cfg = cfg["llm"]["openai"]

    system_prompt = cfg["agent"]["system_prompt"]

    drive_context = build_compact_drive_tree()   # árbol compacto → contexto conversacional

    def on_state(status, last_input="", last_response=""):
        _notify(status, last_input, last_response)

    ww_cfg    = cfg.get("wake_word", {})
    wake_word = ww_cfg.get("word", "") if ww_cfg.get("enabled", False) else ""

    client = CairoRealtime(
        api_key       = oai_cfg["api_key"],
        system_prompt = system_prompt,
        tools         = ALL_TOOLS,
        on_state      = on_state,
        voice         = rt_cfg.get("voice", "verse"),
        temperature   = float(oai_cfg.get("temperature", 0.1)),
        context       = drive_context,
        wake_word     = wake_word,
    )

    _start_heartbeat()
    _log("CAIRO Realtime en línea.")
    print("\n[Cairo] Modo Realtime activado. Hablá cuando quieras.\n")
    try:
        client.run()   # bloquea; reconecta automáticamente si se cae
    finally:
        _notify("offline")


# ── Modo clásico (STT → LLM → TTS) ───────────────────────────────────────────

def _main_classic(cfg: dict):
    """Pipeline clásico. Usar como fallback si Realtime no está disponible."""
    import sys, time
    from agent import JarvisAgent
    from voice.stt import WhisperSTT
    from voice.tts import get_tts

    wake_cfg  = cfg.get("wake_word", {})
    use_wake  = wake_cfg.get("enabled", True)
    wake_word = wake_cfg.get("word", "cairo")

    _start_heartbeat()
    _notify("idle")
    _log("Iniciando sistemas (modo clásico)...")
    _log("Cargando Whisper STT...")
    stt = WhisperSTT()
    _log("Iniciando Engine TTS...")
    tts = get_tts()
    _log("Activando JarvisAgent Core...")
    agent = JarvisAgent()
    _log("CAIRO en línea.")
    tts.speak("Cairo en línea")

    print(f"\n[Cairo] Lista. Escuchando...\n")
    if use_wake:
        print(f"[Modo] Decí '{wake_word}' para activar.")

    QUIT_PHRASES  = {"salir", "apagarse", "cerrar"}
    CLOSE_SESSION = {"chau", "adiós", "cerrar canal", "hasta luego"}
    RESET_PHRASE  = "limpiar historial"

    def contiene_wake(texto: str) -> bool:
        return wake_word.lower() in texto.lower()

    session_active   = False
    last_interaction = 0.0
    SESSION_TIMEOUT  = 120

    try:
        while True:
            try:
                now = time.time()

                if session_active and (now - last_interaction > SESSION_TIMEOUT):
                    print("[CAIRO] Sesión cerrada por inactividad.")
                    _log("Canal cerrado (timeout)")
                    session_active = False

                if use_wake and not session_active:
                    print(f"[Esperando '{wake_word}'...]")
                    _notify("idle")
                    texto_raw = stt.listen()
                    if not contiene_wake(texto_raw):
                        continue
                    session_active   = True
                    last_interaction = time.time()
                    user_input = texto_raw.lower().replace(wake_word.lower(), "").strip()
                    if not user_input:
                        _notify("listening")
                        user_input = stt.listen()
                else:
                    _notify("listening")
                    user_input = stt.listen()

                if not user_input.strip():
                    continue

                last_interaction = time.time()
                print(f"\n[Vos] {user_input}")

                if any(p in user_input.lower() for p in CLOSE_SESSION):
                    resp = "Entendido, cierro el canal. Hasta luego."
                    _notify("speaking", last_response=resp)
                    tts.speak(resp)
                    session_active = False
                    _notify("idle")
                    continue

                if any(p in user_input.lower() for p in QUIT_PHRASES):
                    tts.speak("Hasta luego.")
                    sys.exit(0)

                if RESET_PHRASE in user_input.lower():
                    resp = agent.reset_history()
                    _notify("speaking", last_response=resp)
                    tts.speak(resp)
                    _notify("idle")
                    continue

                _notify("thinking", last_input=user_input)
                t0 = time.time()
                print("[Cairo] Pensando...")
                response = agent.chat(user_input)
                print(f"[Cairo] {response}  [{time.time()-t0:.1f}s]\n")

                _notify("speaking", last_input=user_input, last_response=response)
                speak_streaming(tts, response)
                _notify("idle")

            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"[Error] {e}")
                tts.speak("Hubo un error, podés repetir?")
                _notify("idle")
                time.sleep(1)
    finally:
        _notify("offline")
        tts.speak("Hasta luego.")
        print("[Cairo] Cerrando.")


# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    cfg = load_config()

    use_realtime = cfg.get("realtime", {}).get("enabled", False)

    print("=" * 50)
    print("  CAIRO — Agente de voz")
    print(f"  Modo: {'Realtime API' if use_realtime else 'Clásico (STT→LLM→TTS)'}")
    print("=" * 50)

    if use_realtime:
        _main_realtime(cfg)
    else:
        _main_classic(cfg)


if __name__ == "__main__":
    main()
