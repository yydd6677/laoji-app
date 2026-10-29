"""Real configured-provider probe. SRT is reference input, never ASR truth.

Each row retains the actual generation/review output for content inspection;
no automatic 'quality passed' label is inferred from HTTP/schema success.
Run from the API runtime with PYTHONPATH pointing at its app directory.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import time


def main(args):
    if args.runtime_pid:
        import os
        # Reproduce the active systemd runtime, including drop-in overrides;
        # the .env file alone can still contain an obsolete provider choice.
        environment = Path(f"/proc/{args.runtime_pid}/environ").read_text().split("\0")
        os.environ.update(dict(item.split("=", 1) for item in environment if "=" in item))
    if args.module_dir:
        import app.services
        # Candidate-owned modules stay in the private candidate directory;
        # never copy an experimental dependency into production to import it.
        app.services.__path__.insert(0, str(args.module_dir.resolve()))
        for name in ("llm_provider", "question_source_windows", "question_evidence_verifier", "vnext_question_reader"):
            path = args.module_dir / f"{name}.py"
            if not path.exists():
                continue
            spec = importlib.util.spec_from_file_location(f"app.services.{name}", path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            setattr(app.services, name, module)
            spec.loader.exec_module(module)
    from app.services import vnext_question_reader as reader
    from app.services.llm_provider import configured_provider, GENERATION_MODEL
    print(json.dumps({"provider": configured_provider(), "generation_model": GENERATION_MODEL}), flush=True)
    captures = []
    selections = []
    original_select = reader._select_model_sources
    def select(*a, **kw):
        selected, complete = original_select(*a, **kw)
        selections.append({"complete": complete, "selected_rows": len(selected),
                           "source_ids": [s["source_id"] for s in selected]})
        return selected, complete
    reader._select_model_sources = select
    def observe(owner, phase):
        original = owner.call_llm
        def call(*a, **kw):
            start = time.monotonic()
            capture = {"phase": phase, "operation": kw.get('telemetry_operation')}
            try:
                raw = original(*a, **kw)
                capture["raw"] = raw
                return raw
            except Exception as error:
                capture["error_type"] = type(error).__name__
                raise
            finally:
                capture["wall_ms"] = round((time.monotonic() - start) * 1000)
                if args.trace_input:
                    capture["input"] = json.loads(a[2])
                captures.append(capture)
        owner.call_llm = call
    observe(reader, "reader")
    if hasattr(reader, "plan_question"):
        from app.services import question_query_plan
        observe(question_query_plan, "plan")
    if args.module_dir or hasattr(reader, "verify_claims"):
        from app.services import question_evidence_verifier
        observe(question_evidence_verifier, "review")
    if args.evidence:
        evidence = json.loads(args.evidence.read_text())
        sources = [{"source_type": "transcript", "source_id": row["segmentId"],
                    "source_revision_id": evidence["transcriptRevisionId"],
                    "content_sha256": reader._sha256_text(row["text"]), "text": row["text"]}
                   for row in evidence["transcript"]]
        if evidence.get("manualNote"):
            text = evidence["manualNote"]
            sources.append({"source_type": "manual_note", "source_id": "manual-note",
                            "source_revision_id": str(evidence["manualNoteRevision"]),
                            "content_sha256": reader._sha256_text(text), "text": text})
        input_kind = evidence.get("inputKind", "actual_android_asr_and_note")
    else:
        texts = []
        for block in re.split(r"\n\s*\n", args.srt.read_text().replace("\r", "").strip()):
            rows = block.splitlines()
            if len(rows) >= 3 and "-->" in rows[1]:
                texts.append("".join(rows[2:]))
        sources = [{"source_type": "transcript", "source_id": f"ref-{i}",
                    "source_revision_id": "reference-subtitles", "content_sha256": reader._sha256_text(text), "text": text}
                   for i in range(0, len(texts), 5) if (text := "".join(texts[i:i + 5]))]
        input_kind = "imperfect_srt_reference"
    questions = json.loads(args.questions.read_text()) if args.questions else [
        "这段会议主要讲了哪些内容？", "What are the main points of this meeting?",
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as output:
        for question in questions:
            captures.clear()
            selections.clear()
            row = {"question": question, "input_kind": input_kind, "source_count": len(sources),
                   "provider": configured_provider(), "generation_model": GENERATION_MODEL}
            start = time.monotonic()
            try:
                result = reader.read_q2({"schema_version": 2, "contract_revision": reader.CONTRACT_REVISION,
                    "provider_revision": reader.PROVIDER_REVISION, "snapshot_id": "quality-probe",
                    "source_stream_verified": True, "source_fingerprint": reader._source_fingerprint(sources),
                    "sources": sources, "question": question})
                row.update(result=result)
            except Exception as error:
                row.update(error=getattr(error, "code", type(error).__name__),
                           cause=str(error.__cause__) if error.__cause__ else None)
            row.update(wall_ms=round((time.monotonic() - start) * 1000), calls=list(captures),
                       selections=list(selections))
            output.write(json.dumps(row, ensure_ascii=False) + "\n"); output.flush()
            print(json.dumps({"question": question, "wall_ms": row["wall_ms"], "error": row.get("error")}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--srt", type=Path)
    inputs.add_argument("--evidence", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--module-dir", type=Path)
    parser.add_argument("--questions", type=Path)
    parser.add_argument("--runtime-pid", type=int)
    parser.add_argument("--trace-input", action="store_true", help="Private evaluation files only; includes source text")
    main(parser.parse_args())
