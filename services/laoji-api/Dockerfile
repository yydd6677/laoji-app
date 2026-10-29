ARG CUDA_IMAGE=nvidia/cuda:13.0.0-cudnn-runtime-ubuntu24.04
FROM ${CUDA_IMAGE}

ENV VIRTUAL_ENV=/opt/laoji/venv \
    PATH=/opt/laoji/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    libsndfile1 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv "$VIRTUAL_ENV" \
    && python -m pip install --no-cache-dir --upgrade pip

WORKDIR /app

ARG PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cu130
ARG TORCH_VERSION=2.11.0
COPY requirements-compact.txt ./
RUN python -m pip install --no-cache-dir \
      --index-url "$PYTORCH_INDEX_URL" \
      "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}" \
    && python -m pip install --no-cache-dir -r requirements-compact.txt

COPY . .

RUN useradd --create-home --uid 10001 laoji \
    && chown -R laoji:laoji /app
USER laoji

EXPOSE 18020

# This image contains no credentials. Inject the same private environment used
# by the systemd topology and publish the container only on host loopback.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "18020", "--workers", "1", "--ws-ping-interval", "25", "--ws-ping-timeout", "300"]
