# CUDA 12 + cuDNN 9 : requis par CTranslate2 4.x (faster-whisper). Pilote NVIDIA hôte >= 550.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip3 install -r requirements.txt

# Voix Piper (française). Autres voix : https://huggingface.co/rhasspy/piper-voices/tree/main/fr/fr_FR
ARG PIPER_VOICE=fr/fr_FR/tom/medium/fr_FR-tom-medium
RUN mkdir -p /models/whisper \
 && curl -fsSL -o /models/voice.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/${PIPER_VOICE}.onnx" \
 && curl -fsSL -o /models/voice.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/${PIPER_VOICE}.onnx.json"

COPY app.py .
EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
