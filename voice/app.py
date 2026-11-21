"""StroyCo horror — service voix.

/tts : texte -> WAV (Piper, sur CPU, voix française)
/stt : audio (webm/ogg/mp4) -> texte (faster-whisper, GPU si dispo, sinon CPU)
Aucun fichier n'est écrit : l'audio reçu reste en mémoire et disparaît après la réponse.
"""
import io
import os
import threading
import wave

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from faster_whisper import WhisperModel
from piper import PiperVoice

try:
    from piper import SynthesisConfig
except ImportError:  # anciennes versions de piper-tts
    SynthesisConfig = None

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")
PIPER_MODEL = os.getenv("PIPER_MODEL", "/models/voice.onnx")
SPEECH_SPEED = float(os.getenv("PIPER_LENGTH_SCALE", "1.2"))  # > 1 = plus lent, plus inquiétant

app = FastAPI()


def load_whisper() -> WhisperModel:
    try:
        m = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE, download_root="/models/whisper")
        print(f"[voice] Whisper {WHISPER_MODEL} sur {WHISPER_DEVICE} ({WHISPER_COMPUTE})", flush=True)
        return m
    except Exception as e:  # pas de GPU, pilote trop ancien, etc.
        print(f"[voice] GPU indisponible ({e}) -> repli CPU", flush=True)
        return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root="/models/whisper")


whisper = load_whisper()
voice = PiperVoice.load(PIPER_MODEL)
stt_lock = threading.Lock()
tts_lock = threading.Lock()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/tts")
async def tts(req: Request):
    data = await req.json()
    text = str(data.get("text", "")).strip()[:220]
    if not text:
        raise HTTPException(400, "texte vide")
    buf = io.BytesIO()
    with tts_lock, wave.open(buf, "wb") as wf:
        if hasattr(voice, "synthesize_wav"):
            cfg = SynthesisConfig(length_scale=SPEECH_SPEED) if SynthesisConfig else None
            voice.synthesize_wav(text, wf, syn_config=cfg)
        else:
            voice.synthesize(text, wf, length_scale=SPEECH_SPEED)
    return Response(buf.getvalue(), media_type="audio/wav")


@app.post("/stt")
async def stt(req: Request):
    body = await req.body()
    if not body or len(body) > 2_000_000:
        raise HTTPException(400, "audio invalide")
    try:
        with stt_lock:
            segments, _ = whisper.transcribe(
                io.BytesIO(body),
                language="fr",
                beam_size=1,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
    except Exception as e:
        print(f"[voice] échec transcription : {e}", flush=True)
        text = ""
    return {"text": text[:300]}
