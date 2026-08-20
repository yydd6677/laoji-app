from probe_vnext_global_mixed_load import (
    distribution,
    due_offsets,
    sanitize_summary,
    sanitize_upload,
)
import probe_device_v2_upload


def test_due_offsets_excludes_end_boundary() -> None:
    assert due_offsets(600, 60) == [float(value) for value in range(0, 600, 60)]
    assert due_offsets(20, 7) == [0.0, 7.0, 14.0]
    assert due_offsets(600, 300, 30) == [30.0, 330.0]


def test_distribution_uses_interpolated_p95() -> None:
    assert distribution([1, 2, 3, 4]) == {
        "count": 4,
        "p50": 2.5,
        "p95": 3.8,
        "max": 4,
    }


def test_upload_sanitizer_drops_media_path() -> None:
    result = sanitize_upload({
        "media": "/private/meeting-name.mp4",
        "source_sha256": "sha256:" + "a" * 64,
        "task_state": "succeeded",
    }, held=False)
    assert "media" not in result
    assert result["lane"] == "import_asr"


def test_summary_sanitizer_drops_source_and_content() -> None:
    result = sanitize_summary({
        "sample_sha256": "sha256:" + "b" * 64,
        "source": "private source",
        "summary": {
            "state": "success",
            "overview": "private summary",
            "citation_count": 2,
            "citation_exact_match_count": 2,
        },
        "cleanup": {"state": "confirmed"},
    })
    assert "source" not in result
    assert "overview" not in result
    assert result["citations"] == result["citations_exact"] == 2


def test_purge_wait_reexecutes_until_cleanup_is_confirmed(monkeypatch) -> None:
    states = iter(("running", "confirmed"))
    calls = []

    def fake_request(url, **kwargs):
        calls.append((url, kwargs.get("method")))
        return 200, {"state": next(states)}

    monkeypatch.setattr(probe_device_v2_upload, "json_request", fake_request)
    monkeypatch.setattr(probe_device_v2_upload.time, "sleep", lambda _value: None)
    result = probe_device_v2_upload.execute_purge_and_wait(
        "http://127.0.0.1/device/v2",
        "capability",
        "secret",
        request_prefix="test",
    )
    assert result["state"] == "confirmed"
    assert calls == [
        ("http://127.0.0.1/device/v2/purge-capabilities/capability/execute", "POST"),
        ("http://127.0.0.1/device/v2/purge-capabilities/capability/execute", "POST"),
    ]
