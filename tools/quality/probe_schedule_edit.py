"""Small, frozen engineering probe, not a natural-language quality benchmark.

Runs the candidate service once per input against its configured real provider;
records exact proposals and strict field expectations without publishing them.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from app.schemas.schedule_edit import ScheduleEditRequest, ScheduleEditModelObservation
from app.services import llm_provider
from app.services import schedule_edit_service
from app.services import schedule_graph_service



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--cases", required=True, help="Frozen, individually authored diagnostic inputs; no built-in six-case loop")
    parser.add_argument("--ids", nargs="+", help="Inspect a bounded subset without changing the frozen case file")
    parser.add_argument("--initial", action="store_true", help="Observe initial model date semantics, not the app's local/model route")
    parser.add_argument("--replay", help="Replay saved raw observations with zero network inference; keeps failed expectations unchanged")
    args = parser.parse_args()
    cases_path = Path(args.cases)
    cases_bytes = cases_path.read_bytes()
    import hashlib
    cases_sha256 = hashlib.sha256(cases_bytes).hexdigest()
    cases = json.loads(cases_bytes)
    saved = json.loads(Path(args.replay).read_text(encoding="utf-8")) if args.replay else None
    if saved and saved.get("cases_sha256") != cases_sha256:
        parser.error("saved observations do not match the frozen case file")
    replay = {row["case"]: row for row in saved["cases"]} if saved else None
    if args.ids:
        unknown = set(args.ids) - {case["id"] for case in cases}
        if unknown:
            parser.error("unknown diagnostic IDs: " + ",".join(sorted(unknown)))
        cases = [case for case in cases if case["id"] in args.ids]
    if any(case.get("natural_benchmark") is not False or case.get("source_kind") != "engineer_authored" for case in cases):
        parser.error("raw observation capture is restricted to explicitly authored diagnostic inputs")
    original_call = llm_provider.call_llm
    from app.schemas import schedule_edit
    from app.services import schedule_parser_service
    source_sha256 = {module.__name__: hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
        for module in (schedule_edit, schedule_edit_service, schedule_parser_service, schedule_graph_service, llm_provider)}
    rows = []
    for sequence, case in enumerate(cases, 1):
        name, utterance, expected = case["id"], case["text"], case["expected"]
        if replay is not None and (name not in replay or replay[name]["input"]["utterance"] != utterance):
            parser.error("saved observation input mismatch: " + name)
        precision = case.get("precision", "exact")
        request = ScheduleEditRequest.model_validate({
            "schema_version": 1, "client_request_id": f"schedule-edit-probe:{sequence}",
            "draft_id": f"probe-draft-{sequence}", "base_revision": 7, "input_sequence": sequence,
            "reference_datetime": case.get("reference_datetime", "2026-10-28T18:00:00+08:00"),
            "timezone": case.get("timezone", "Asia/Shanghai"),
            "mode": case.get("mode", "patch"), "utterance": utterance, "draft": {
                "title": "整理资料", "start_date": "2026-10-29", "end_date": None,
                "time": {"precision": precision, "period": "night" if precision == "period" else None,
                    "start_time": "09:23" if precision == "exact" else None, "end_time": None},
                "location": "手动地点", "notes": "用户手动备注", "category": "其他",
                "recurrence": {"repeat": "once", "interval": 1, "weekdays": [], "until_date": None},
                "reminder_minutes": 10 if precision == "exact" else None,
            },
        })
        if case.get("draft_overrides"):
            body = request.model_dump(); body["draft"].update(case["draft_overrides"])
            request = ScheduleEditRequest.model_validate(body)
        started = time.perf_counter()
        # This probe contains authored inputs only. Capture here, never in
        # production logging, so a schema/normalization defect is traceable to
        # its actual observation rather than guessed from a final patch.
        observations = []
        request_attempts = 0
        def capture(*args, **kwargs):
            nonlocal request_attempts
            if replay is None:
                request_attempts += 1
            raw = replay[name]["model_observations"][len(observations)] if replay is not None else original_call(*args, **kwargs)
            observations.append(raw)
            return raw
        llm_provider.call_llm = capture
        initial_call = schedule_parser_service.call_ollama
        if args.initial:
            schedule_parser_service.call_ollama = capture
        try:
            if args.initial:
                parsed = schedule_parser_service.parse_schedule_text_sync(utterance,
                    reference_datetime=request.reference_datetime.isoformat(), timezone_name=request.timezone, model_only=True)
                graph = schedule_graph_service.produce_schedule_graph(utterance, request.reference_datetime,
                    request.timezone, parsed=parsed)
                output = graph.model_dump(mode="json")
                passed = all(output["slots"].get(key) == value for key, value in expected.items())
            else:
                output = schedule_edit_service.edit_schedule(request).model_dump()
                changes = {item["field"]: item["value"] for item in output["changes"]}
                passed = output["status"] == expected if isinstance(expected, str) else (
                    output["status"] == "patch" and changes in (expected if isinstance(expected, list) else [expected]))
            row = {"case": name, "input": request.model_dump(mode="json"), "expected": expected,
                "output": output, "passed": passed}
        except Exception as error:
            row = {"case": name, "input": request.model_dump(mode="json"), "expected": expected,
                "error_type": type(error).__name__, "passed": False}
            causes = []
            cause = error
            while cause is not None:
                detail = {"type": type(cause).__name__, "code": str(cause) if isinstance(cause, schedule_edit_service.ScheduleEditInvalid) else None}
                if hasattr(cause, "errors"):
                    detail["fields"] = [{"path": item["loc"], "type": item["type"]} for item in cause.errors()]
                causes.append(detail)
                cause = cause.__cause__
            row["error_causes"] = causes
        finally:
            llm_provider.call_llm = original_call
            schedule_parser_service.call_ollama = initial_call
        row["model_observations"] = observations
        row["model_call_count"] = len(observations)
        if len(observations) == 1 and not args.initial:
            try:
                observed = ScheduleEditModelObservation.model_validate_json(observations[0])
                schedule_edit_service._compile_temporal(request, observed)
            except schedule_edit_service._TemporalAmbiguous as error:
                row["temporal_error"] = str(error)
            except (TypeError, ValueError):
                pass  # The service already reports protocol failure above.
        row["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
        row.update(corpus_role="authored_boundary", natural_benchmark=False,
            source_kind="engineer_authored", source_license="internal-diagnostic",
            label_source="frozen_manual_protocol_expectations_before_inference")
        row["route"] = "diagnostic_forced_model" if args.initial else "current_draft_model"
        # A transport failure is still an attempted provider request, not a
        # rule-only result. Completed raw responses remain a separate count.
        row["model_attempted"] = request_attempts > 0
        row["provider_request_attempts"] = request_attempts
        row["model_success"] = replay is None and "error_type" not in row
        row["observation_valid"] = "error_type" not in row
        row["fallback_used"] = False
        row["real_model_call_count"] = len(observations) if replay is None else 0
        row["model_observation_replayed"] = replay is not None
        rows.append(row)
        Path(args.output).write_text(json.dumps({"evidence": "saved observation replay, zero real inference" if replay is not None else "isolated real model engineering probe",
            "promotion_eligible": False, "cases": rows,
            "cases_sha256": cases_sha256,
            "producer_revision": schedule_edit_service.PRODUCER_REVISION,
            "prompt_sha256": hashlib.sha256(schedule_edit_service.SYSTEM_PROMPT.encode()).hexdigest(),
            "source_sha256": source_sha256,
            "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "scope": "initial_observation" if args.initial else "current_draft_edit",
            "replay_source_sha256": hashlib.sha256(Path(args.replay).read_bytes()).hexdigest() if replay is not None else None,
            "inference": llm_provider._inference_telemetry_snapshot()}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: row[key] for key in ("case", "passed", "elapsed_ms")}), flush=True)


if __name__ == "__main__":
    main()
