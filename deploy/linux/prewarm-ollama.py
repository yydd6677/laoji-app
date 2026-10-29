#!/usr/bin/env python3
"""Wait for the private Ollama endpoint and keep its required models warm."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request


BASE_URL = os.getenv("LAOJI_OLLAMA_BASE_URL", "http://127.0.0.1:21434").rstrip("/")
GENERATION_MODEL = os.getenv("LAOJI_GENERATION_MODEL", "qwen3.5:9b")
EMBEDDING_MODEL = os.getenv("LAOJI_EMBEDDING_MODEL", "qwen3-embedding:0.6b")
LLM_PROVIDER = os.getenv("LAOJI_LLM_PROVIDER", "ollama").strip().lower()
PREWARM_GENERATION = LLM_PROVIDER in {"ollama", "local"}
REQUIRE_GENERATION_GPU = os.getenv("LAOJI_REQUIRE_GENERATION_GPU", "").strip().lower() in {
    "1", "true", "yes", "on",
}


def _generation_context_length() -> int:
    # Match llm_provider.canonical_generation_num_ctx(): a different context
    # creates another 9B runner and can evict the GPU-resident one on the
    # first real schedule or summary request.
    raw = os.getenv(
        "LAOJI_GENERATION_NUM_CTX",
        os.getenv("MEETING_SUMMARY_NUM_CTX", "16384"),
    )
    try:
        value = int(raw)
    except ValueError:
        value = 16384
    return min(16384, max(4096, value))


def request(path: str, payload: dict | None = None, timeout: float = 300.0) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as response:
        return json.load(response)


def main() -> None:
    deadline = time.monotonic() + 120
    while True:
        try:
            tags = request("/api/tags", timeout=5)
            break
        except (OSError, ValueError, urllib.error.URLError):
            if time.monotonic() >= deadline:
                raise SystemExit("Ollama did not become ready within 120 seconds")
            time.sleep(1)

    required_models = [EMBEDDING_MODEL]
    if PREWARM_GENERATION:
        required_models.insert(0, GENERATION_MODEL)
    available = {str(item.get("name") or "") for item in tags.get("models", [])}
    missing = [name for name in required_models if name not in available]
    if missing:
        raise SystemExit("Missing LaoJi resident models: " + ", ".join(missing))

    if PREWARM_GENERATION:
        request(
            "/api/generate",
            {
                "model": GENERATION_MODEL,
                "prompt": "只回复：就绪",
                "stream": False,
                "keep_alive": -1,
                "options": {
                    "num_ctx": _generation_context_length(),
                    "temperature": 0,
                    "num_predict": 8,
                },
            },
        )

    # Readiness and long-summary evidence already request the small CPU
    # embedding runner. Keep prewarm on that same shape so it cannot reserve
    # scarce GPU0 VRAM ahead of the interactive 9B generator.
    embedding = request(
        "/api/embed",
        {
            "model": EMBEDDING_MODEL,
            "input": ["老记服务预热"],
            "dimensions": 256,
            "truncate": True,
            "keep_alive": -1,
            "options": {"num_ctx": 2048, "num_gpu": 0},
        },
    )
    if not embedding.get("embeddings"):
        raise SystemExit("Embedding prewarm returned no vector")

    resident = {
        str(item.get("name") or ""): item
        for item in request("/api/ps", timeout=10).get("models", [])
        if isinstance(item, dict)
    }
    not_resident = [name for name in required_models if name not in resident]
    if not_resident:
        raise SystemExit("LaoJi models did not remain resident: " + ", ".join(not_resident))
    if PREWARM_GENERATION and REQUIRE_GENERATION_GPU:
        generation = resident[GENERATION_MODEL]
        if int(generation.get("size_vram") or 0) <= 0:
            raise SystemExit("LaoJi generation model loaded on CPU; retry after GPU discovery")
        if int(generation.get("context_length") or 0) != _generation_context_length():
            raise SystemExit("LaoJi generation model context does not match production")


if __name__ == "__main__":
    main()
