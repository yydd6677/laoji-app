"""Existing APK contract rejects inspectable packages with otherwise valid endpoints."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("apk_contract", Path(__file__).resolve().parents[1] / "verify_compact_apk_config.py")
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


def check(monkeypatch, debuggable):
    badging = "package: name='com.laoji.app' versionCode='42' versionName='0.1.0'\n"
    if debuggable:
        badging += "application-debuggable\n"
    monkeypatch.setattr(contract, "_aapt", lambda: Path("aapt"))
    monkeypatch.setattr(contract.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=0, stdout=badging, stderr=""))
    return contract._verify_native_version(Path("unused.apk"), {"version": "0.1.0", "android": {"versionCode": 42}})


def test_inspection_package_cannot_be_published(monkeypatch):
    assert any("禁止" in error for error in check(monkeypatch, True))


def test_normal_release_still_passes_manifest_boundary(monkeypatch):
    assert check(monkeypatch, False) == []
