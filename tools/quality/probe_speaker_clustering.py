"""Real CAM++ smoke probe; labeled clips are not a full diarization benchmark.

Run in the deployed API environment. No profiles, DB writes or GPU use. The
label is an evaluation grouping supplied by the operator, never model input.
"""
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

import numpy as np


async def main(args):
    environment = Path(f"/proc/{args.runtime_pid}/environ").read_text().split("\0")
    os.environ.update(dict(item.split("=", 1) for item in environment if "=" in item))
    os.environ["LAOJI_CAMPPLUS_DEVICE"] = "cpu"
    import torch
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    from app.asr.model_manager import ModelManager, SpeakerEmbeddingExtractor
    from app.services import vnext_speaker_pipeline as baseline
    spec = importlib.util.spec_from_file_location("speaker_candidate", args.candidate)
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)
    manager = ModelManager.get_instance()
    await manager.initialize()
    extractor = SpeakerEmbeddingExtractor(manager.get_camp_model(), device="cpu")
    rows, vectors, labels = [], {}, {}
    began = time.monotonic()
    for index, path in enumerate(sorted(args.input.glob("*.pcm"))):
        data = path.read_bytes()
        key = path.stem
        duration = len(data) * 1000 // 32000
        vectors[key] = candidate._unit_embedding(extractor.extract_from_bytes(data))
        labels[key] = key.split("-")[0]
        rows.append({"stable_segment_key": key, "source_start_ms": index * 5000,
                     "source_end_ms": index * 5000 + duration})
    report = {"boundary": "two visible presenters, short separate clips; not DER or same-room robustness",
              "count": len(rows), "model_revision": manager.camp_model_revision,
              "embedding_wall_ms": round((time.monotonic() - began) * 1000), "pair_scores": [], "paths": {}}
    for i, left in enumerate(rows):
        for right in rows[i + 1:]:
            a, b = left["stable_segment_key"], right["stable_segment_key"]
            report["pair_scores"].append({"same_presenter": labels[a] == labels[b],
                                          "cosine": round(float(vectors[a] @ vectors[b]), 4)})
    for name, module in [("baseline", baseline), ("candidate", candidate)]:
        assignments = module.assign_speaker_overlay(rows, vectors, [])
        lookup = {r["stable_segment_key"]: r["speaker_cluster_id"] for r in assignments}
        correct = total = 0
        for i, left in enumerate(rows):
            for right in rows[i + 1:]:
                a, b = left["stable_segment_key"], right["stable_segment_key"]
                total += 1; correct += ((lookup[a] == lookup[b]) == (labels[a] == labels[b]))
        report["paths"][name] = {"clusters": len(set(lookup.values())), "pair_correct": correct,
            "pair_total": total, "anonymous": all(r["speaker_profile_id"] is None for r in assignments),
            "reverse_order_identical": module.assign_speaker_overlay(list(reversed(rows)), vectors, []) == assignments}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-pid", type=int, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
