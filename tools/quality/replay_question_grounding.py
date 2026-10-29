"""Replay saved real Q2 model calls through the current deterministic owners.

Never calls a provider or treats replay equality as semantic acceptance. This
separates generation omission, pre-review filtering and post-review loss
without spending another model call or retaining source text in the report.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import sys
from unittest.mock import patch


def evidence_sources(reader, evidence):
    sources = [{"source_type": "transcript", "source_id": row["segmentId"],
        "source_revision_id": evidence["transcriptRevisionId"],
        "content_sha256": reader._sha256_text(row["text"]), "text": row["text"]}
        for row in evidence["transcript"]]
    if evidence.get("manualNote"):
        text = evidence["manualNote"]
        sources.append({"source_type": "manual_note", "source_id": "manual-note",
            "source_revision_id": str(evidence["manualNoteRevision"]),
            "content_sha256": reader._sha256_text(text), "text": text})
    return sources


def replay_row(reader, verifier, sources, row):
    calls = iter(row["calls"])
    consumed = []
    before_review, after_review = [], []
    generated = []
    review_rows = {}

    def replay(phase):
        def call(*args, **kwargs):
            try:
                saved = next(calls)
            except StopIteration as error:
                raise RuntimeError("uncaptured_model_call") from error
            if saved["phase"] != phase or "raw" not in saved:
                raise RuntimeError("captured_call_order_or_result_mismatch")
            consumed.append(phase)
            if phase == "reader":
                parsed = json.loads(saved["raw"])
                clauses = reader._model_clauses(parsed.get("clauses"))
                if clauses is not None:
                    generated.extend(clauses)
            else:
                review_rows.update(json.loads(saved["raw"]))
            return saved["raw"]
        return call

    def no_network(*args, **kwargs):
        raise RuntimeError("uncaptured_embedding_or_provider_call")

    original_review = verifier.verify_claims
    def review(question, claims, context):
        before_review.extend(claims)
        retained = original_review(question, claims, context)
        after_review.extend(retained)
        return retained

    expected = row.get("result")
    if not isinstance(expected, dict):
        raise ValueError("successful_captured_result_required")
    payload = {"schema_version": 2, "contract_revision": reader.CONTRACT_REVISION,
        "provider_revision": reader.PROVIDER_REVISION, "snapshot_id": expected["snapshot_id"],
        "source_stream_verified": True, "source_fingerprint": reader._source_fingerprint(sources),
        "sources": sources, "question": row["question"]}
    with ExitStack() as stack:
        for owner, name, value in (
            (reader, "call_llm", replay("reader")), (verifier, "call_llm", replay("review")),
            (reader, "verify_claims", review),
            (reader, "model_revision", lambda: expected["model_revision"]),
            (reader, "embed_texts", no_network), (reader, "embed_texts_cached", no_network),
        ):
            stack.enter_context(patch.object(owner, name, value))
        actual = reader.read_q2(payload)
    if next(calls, None) is not None:
        raise RuntimeError("captured_model_calls_not_consumed")
    retained_ids = {claim["clause_id"] for claim in after_review}
    final_ids = {claim["clause_id"] for claim in actual["clauses"]}
    review_rejections = []
    for i, claim in enumerate(before_review):
        key = f"c{i + 1}"
        assessment = review_rows.get(key, {})
        bundles = claim["citations"]
        selected = [bundle for j, bundle in enumerate(bundles)
                    if assessment.get("citations", {}).get(f"e{j + 1}") is True]
        identities = {tuple(cite.get(k) for k in ("source_type", "source_id", "source_revision_id",
            "content_sha256", "source_start_utf8", "source_end_utf8", "quote"))
            for bundle in selected for cite in bundle.get("_members", [bundle])}
        if claim["clause_id"] not in retained_ids:
            review_rejections.append({"clause_id": claim["clause_id"],
                "model_supported": assessment.get("supported"),
                "selected_member_count": len(identities),
                "over_public_citation_bound": len(identities) > 8,
                "duplicate_of": assessment.get("duplicate_of")})
    return {"envelope_matches_saved": actual == expected,
        "answer_kind": actual["answer_kind"], "saved_call_count": len(consumed),
        "generated_clauses": len(generated), "before_review_clauses": len(before_review),
        "after_review_clauses": len(after_review), "final_clauses": len(actual["clauses"]),
        "removed_before_review": [f"c{i + 1}" for i in range(len(generated))
                                  if f"c{i + 1}" not in {c["clause_id"] for c in before_review}],
        "review_rejections": review_rejections,
        "removed_after_review": sorted(retained_ids - final_ids)}


def main(args):
    from app.services import vnext_question_reader as reader, question_evidence_verifier as verifier
    sources = evidence_sources(reader, json.loads(args.evidence.read_text()))
    results = [replay_row(reader, verifier, sources, json.loads(line))
               for line in args.captures.read_text().splitlines() if line.strip()]
    report = {"boundary": "captured-model deterministic replay, not semantic quality or a live request",
              "cases": len(results), "all_envelopes_match": all(r["envelope_matches_saved"] for r in results),
              "results": results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    args.output.chmod(0o600)
    print(json.dumps({k: v for k, v in report.items() if k != "results"}))
    return 0 if report["all_envelopes_match"] else 2


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "laoji-api"))
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    raise SystemExit(main(parser.parse_args()))
