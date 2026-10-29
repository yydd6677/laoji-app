"""Trace real summary input/generation/verification; private outputs only.

No phone activation, production task, source store or user summary is changed.
Source coverage and fact support are distinct; neither is a quality pass rate.
"""
from __future__ import annotations

import argparse
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def main(args):
    if args.runtime_pid:
        environment = Path(f"/proc/{args.runtime_pid}/environ").read_text().split("\0")
        os.environ.update(dict(item.split("=", 1) for item in environment if "=" in item))
    if args.module_dir:
        import app.services
        app.services.__path__.insert(0, str(args.module_dir.resolve()))
        for name in ("summary_v3_evidence", "summary_v3_generator"):
            path = args.module_dir / f"{name}.py"
            if path.exists():
                spec = importlib.util.spec_from_file_location(f"app.services.{name}", path)
                module = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = module
                setattr(app.services, name, module)
                spec.loader.exec_module(module)
    from app.services import summary_v3_generator as generator
    import app
    # Candidate modules live outside app/. Keep the explicit prompt owner at
    # the active runtime unless this private probe selects a candidate prompt.
    if args.module_dir or args.prompt:
        generator._PROMPT_PATH = args.prompt or Path(app.__file__).parent / "prompts" / "meeting_facts_v3_system.txt"
    from app.services.vnext_summary_chapter_pipeline import build_chapter_evidence_package
    evidence = json.loads(args.evidence.read_text())
    items = [{"source_type": "transcript", "source_id": row["segmentId"],
              "content": row["text"], "content_sha256": "sha256:" + hashlib.sha256(row["text"].encode()).hexdigest(),
              "start_ms": row.get("startMs"), "end_ms": row.get("endMs"),
              "speaker": row.get("speaker")} for row in evidence["transcript"]]
    if evidence.get("manualNote"):
        text = evidence["manualNote"]
        items.append({"source_type": "manual_note", "source_id": "manual-note",
                      "content": text, "content_sha256": "sha256:" + hashlib.sha256(text.encode()).hexdigest()})
    captures = []
    original = generator.call_llm
    def call(*a, **kw):
        start = time.monotonic()
        row = {"operation": kw.get("telemetry_operation"),
               "input": json.loads(a[2])}
        try:
            raw = original(*a, **kw)
            row["raw"] = raw
            return raw
        except Exception as error:
            row["error_type"] = type(error).__name__
            raise
        finally:
            row["wall_ms"] = round((time.monotonic() - start) * 1000)
            captures.append(row)
    generator.call_llm = call
    started = time.monotonic()
    package = build_chapter_evidence_package({"items": items})
    result = {"input_kind": evidence.get("inputKind", "actual_android_asr_and_note"),
              "original_rows": len(items), "packed_sources": len(package.sources),
              "coverage": package.coverage, "input": package.model_payload()}
    try:
        response, count = generator.generate_model_response(package)
        result["model_calls"] = count
        result["expanded_response"] = response.model_dump(mode="json")
        source_map = package.source_map()
        validation = []
        for fact in response.facts:
            citations = [generator._verified_source(reference, source_map) for reference in fact.sources]
            quote = " ".join(c.quote for c in citations if c is not None)
            validation.append({"fact_id": fact.fact_id, "sources_valid": all(c is not None for c in citations),
                "numeric_valid": generator._numeric_claims_supported(fact.content, quote),
                "temporal_valid": generator._temporal_claims_supported(fact.content, quote),
                "owner_valid": fact.fact_type != "action" or generator._owner_claims_supported(
                    fact.content, quote, [c for c in citations if c is not None])})
        result["validation"] = validation
        result["document"] = generator.verify_model_response(response, package).model_dump(mode="json")
    except Exception as error:
        result["error"] = getattr(error, "code", type(error).__name__)
        result["cause_type"] = type(error.__cause__).__name__ if error.__cause__ else None
    result["calls"] = captures
    result["wall_ms"] = round((time.monotonic() - started) * 1000)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"wall_ms": result["wall_ms"], "packed_sources": len(package.sources),
        "model_calls": len(captures), "model_facts": len(result.get("expanded_response", {}).get("facts", [])),
        "verified_facts": len(result.get("document", {}).get("facts", [])), "error": result.get("error")}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-pid", type=int)
    parser.add_argument("--module-dir", type=Path)
    parser.add_argument("--prompt", type=Path)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    main(parser.parse_args())
