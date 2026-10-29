import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("live_health_probe", Path(__file__).with_name("probe_live_provider_health.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def test_old_cached_empty_telemetry_fails_checks_instead_of_crashing():
    checks = probe.health_checks([None, None], {"queue": {"depth": 0, "active": None, "last": None},
        "inference": {"last_by_operation": {}}}, probe_before=1, probe_after=1)
    assert not checks["active_reader_observed"] and not checks["latest_review_visible"]
    assert not checks["fresh_inference_visible"]
    assert checks["availability_probe_not_repeated"] and checks["final_queue_idle"]


def test_fresh_reader_and_review_are_required_without_reprobing():
    after = {"queue": {"depth": 0, "active": None, "last": {"operation": "question.q2.evidence.v3"}},
        "inference": {"last_by_operation": {"question.q2.reader.v2": {}, "question.q2.evidence.v3": {}}}}
    observed = ["question.q2.reader.v2", "question.q2.evidence.v3"]
    assert all(probe.health_checks(observed, after, probe_before=1, probe_after=1).values())
    assert not probe.health_checks(observed, after, probe_before=1, probe_after=2)["availability_probe_not_repeated"]
