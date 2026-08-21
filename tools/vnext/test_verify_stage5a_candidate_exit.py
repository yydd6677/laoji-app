from __future__ import annotations

import json
from pathlib import Path
import tarfile

from verify_stage5a_candidate_exit import _server_package


def test_server_package_rejects_database_and_secret_names(tmp_path: Path) -> None:
    payload = tmp_path / "local.db"
    payload.write_text("not a database", encoding="utf-8")
    package = tmp_path / "candidate.tar.gz"
    with tarfile.open(package, "w:gz") as archive:
        archive.add(payload, arcname="candidate/data/local.db")

    report = _server_package(package)

    assert report["passed"] is False
    assert report["forbidden_member_names"] == ["candidate/data/local.db"]


def test_server_package_accepts_tracked_source_archive(tmp_path: Path) -> None:
    payload = tmp_path / "contract.json"
    payload.write_text(json.dumps({"schema_version": 1}), encoding="utf-8")
    package = tmp_path / "candidate.tar.gz"
    with tarfile.open(package, "w:gz") as archive:
        archive.add(payload, arcname="candidate/contracts/contract.json")

    report = _server_package(package)

    assert report["passed"] is True
    assert report["member_count"] == 1
