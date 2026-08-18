#!/usr/bin/env python3
"""Verify and materialize the LaoJi vNext Stage 0 exit evidence.

The verifier reads only the local frozen artifacts and a Git archive of the
Stage 0 tag.  It does not connect to production, start services, or inspect
user content.  The generated inventory contains paths, counts, hashes and
schema metadata only.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
BASELINE_REF = "vnext-stage0-1.1.10-118"
BASELINE_VERSION = "1.1.10"
BASELINE_VERSION_CODE = 118
APK_RELATIVE = Path("artifacts/vnext-stage0/release/laoji-1.1.10-118.apk")
MANIFEST_RELATIVE = Path("tools/app-update/latest.json")
DATABASES = (
    Path("artifacts/vnext-stage0/db/local.db"),
    Path("artifacts/vnext-stage0/db/schedule.db"),
    Path("artifacts/vnext-stage0/db/speaker_voiceprints.db"),
)
DEFAULT_INVENTORY = Path("docs/vnext-stage0/CURRENT-TO-TARGET-20260818.json")


def _run(command: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return completed.stdout.strip()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def _safe_archive(ref: str, destination: Path) -> None:
    archive = subprocess.run(
        ["git", "archive", "--format=tar", ref, "services/laoji-api", "services/laoji-asr", "contracts/vnext"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
        for member in bundle.getmembers():
            target = (destination / member.name).resolve()
            if destination.resolve() not in target.parents and target != destination.resolve():
                raise RuntimeError("unsafe archive member")
        bundle.extractall(destination, filter="data")


def _source_inventory(root: Path, relative: Path) -> dict[str, Any]:
    base = root / relative
    files = [
        path for path in base.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and ".pytest_cache" not in path.parts
        and not path.name.endswith((".pyc", ".pyo"))
    ]
    aggregate = hashlib.sha256()
    total = 0
    for path in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
        data = path.read_bytes()
        relative_name = path.relative_to(root).as_posix()
        aggregate.update(relative_name.encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(hashlib.sha256(data).digest())
        total += len(data)
    return {
        "path": relative.as_posix(),
        "file_count": len(files),
        "bytes": total,
        "aggregate_sha256": aggregate.hexdigest(),
    }


def _route_target(path: str) -> tuple[str, str]:
    lowered = path.lower()
    if "/device/v2" in lowered:
        return "device-v2-domain-router", "retain-versioned"
    if any(token in lowered for token in ("auth", "account", "session", "password")):
        return "legacy-account-compatibility", "drain-then-delete-stage5"
    if "schedule" in lowered:
        return "schedule-mention-graph", "bridge-then-delete-legacy-parser-stage5"
    if any(token in lowered for token in ("summary", "summaries")):
        return "facts-v3-task-handler", "bridge-and-drain"
    if any(token in lowered for token in ("question", "questions")):
        return "question-q2-handler", "bridge-and-drain"
    if any(token in lowered for token in ("recording", "upload", "audio", "transcript")):
        return "media-transcript-domain", "bridge-and-drain"
    if any(token in lowered for token in ("speaker", "voiceprint")):
        return "speaker-overlay-domain", "bridge-and-drain"
    if any(token in lowered for token in ("share", "public")):
        return "device-scoped-share-domain", "replace-account-share-stage5"
    if "location" in lowered:
        return "location-proxy", "retain"
    return "meeting-device-compatibility", "map-to-versioned-handler"


def _routes(root: Path) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    service = root / "services/laoji-api"
    for source in sorted(service.rglob("*.py")):
        try:
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        except (SyntaxError, UnicodeDecodeError):
            continue
        prefixes: dict[str, str] = {}
        for node in tree.body:
            if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
                continue
            if not isinstance(node.value.func, ast.Name) or node.value.func.id != "APIRouter":
                continue
            prefix = next((item.value.value for item in node.value.keywords
                           if item.arg == "prefix" and isinstance(item.value, ast.Constant)
                           and isinstance(item.value.value, str)), "")
            for target in node.targets:
                if isinstance(target, ast.Name):
                    prefixes[target.id] = prefix
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                method = decorator.func.attr.upper()
                if method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "WEBSOCKET"}:
                    continue
                if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
                    continue
                declared = decorator.args[0].value
                if not isinstance(declared, str):
                    continue
                owner_name = decorator.func.value.id if isinstance(decorator.func.value, ast.Name) else ""
                full_path = f"{prefixes.get(owner_name, '')}{declared}"
                target, action = _route_target(full_path)
                result.append({
                    "method": method,
                    "path": full_path or "/",
                    "source": source.relative_to(root).as_posix(),
                    "target": target,
                    "action": action,
                })
    return sorted(result, key=lambda item: (item["path"], item["method"], item["source"]))


def _table_target(database: str, table: str) -> tuple[str, str, str]:
    name = table.lower()
    if database == "schedule.db" and any(token in name for token in ("user", "auth", "session", "password", "deletion")):
        return "retired-account-domain", "drain-export-delete-stage5", "account"
    if database == "schedule.db":
        return "mobile-schedule-canonical", "one-time-import-then-retire", "device"
    if database == "speaker_voiceprints.db":
        return "mobile-speaker-profile-or-encrypted-overlay", "one-time-import-then-retire", "device"
    if name.startswith("device_") or "tombstone" in name or "deletion" in name:
        return "device-authority-and-purge", "retain-versioned-or-drain-legacy", "device"
    if any(token in name for token in ("recording", "r2_upload", "media_clip")):
        return "recording-asset-generation", "migrate-current-then-drain", "meeting"
    if any(token in name for token in ("transcript", "segment")):
        return "immutable-transcript-revision", "migrate-current-then-drain", "meeting"
    if "speaker" in name:
        return "speaker-overlay", "migrate-current-then-drain", "meeting"
    if "question" in name:
        return "question-q2", "legacy-read-only-then-delete-stage5", "meeting"
    if "summary_v3" in name:
        return "facts-v3-artifact", "retain-versioned", "meeting"
    if any(token in name for token in ("summary", "final_summaries", "period_summaries")):
        scope = "unresolved_global" if "orphan" in name else "meeting"
        return "legacy-summary-compatibility", "bridge-drain-delete-stage5", scope
    if any(token in name for token in ("operation", "outbox", "sync")):
        return "legacy-operation-drain", "stop-new-write-drain-delete-stage5", "meeting"
    if any(token in name for token in ("meeting", "attachment", "marker", "manual_note", "tag", "occurrence", "action")):
        return "mobile-meeting-canonical", "one-time-import-or-retain-history", "meeting"
    return "versioned-legacy-compatibility", "retain-until-capability-barrier", "unresolved_global"


def _database_inventory(path: Path) -> dict[str, Any]:
    absolute = ROOT / path
    with sqlite3.connect(f"file:{absolute}?mode=ro", uri=True) as connection:
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        if integrity != "ok":
            raise RuntimeError(f"snapshot integrity failed: {absolute.name}")
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        mapped = []
        for table in tables:
            quoted = table.replace('"', '""')
            rows = int(connection.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0])
            foreign_keys = len(connection.execute(f'PRAGMA foreign_key_list("{quoted}")').fetchall())
            target, action, purge_scope = _table_target(absolute.name, table)
            mapped.append({
                "table": table,
                "rows": rows,
                "foreign_keys": foreign_keys,
                "target": target,
                "action": action,
                "purge_scope": purge_scope,
            })
    return {
        "name": absolute.name,
        "bytes": absolute.stat().st_size,
        "sha256": _sha256_file(absolute),
        "integrity": integrity,
        "tables": mapped,
        "restore_order": [item["table"] for item in mapped],
    }


def _restore_smoke(database: Path, directory: Path) -> None:
    source = ROOT / database
    restored = directory / database.name
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_db:
        with sqlite3.connect(restored) as restored_db:
            source_db.backup(restored_db)
    def signature(path: Path) -> tuple[list[tuple[str, str]], list[tuple[str, int]]]:
        with sqlite3.connect(path) as connection:
            schema = [(str(row[0]), str(row[1])) for row in connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )]
            counts = []
            for name, _sql in schema:
                quoted = name.replace('"', '""')
                counts.append((name, int(connection.execute(
                    f'SELECT COUNT(*) FROM "{quoted}"'
                ).fetchone()[0])))
        return schema, counts

    with sqlite3.connect(restored) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchone()
    if not result or result[0] != "ok":
        raise RuntimeError(f"restore integrity failed: {database.name}")
    if signature(source) != signature(restored):
        raise RuntimeError(f"restore schema/row signature mismatch: {database.name}")


def _verify_artifacts() -> dict[str, Any]:
    apk = ROOT / APK_RELATIVE
    manifest_path = ROOT / MANIFEST_RELATIVE
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    digest = _sha256_file(apk)
    if manifest.get("version_name") != BASELINE_VERSION:
        raise RuntimeError("baseline version_name mismatch")
    if int(manifest.get("version_code", -1)) != BASELINE_VERSION_CODE:
        raise RuntimeError("baseline version_code mismatch")
    if int(manifest.get("size_bytes", -1)) != apk.stat().st_size:
        raise RuntimeError("baseline APK size mismatch")
    if str(manifest.get("sha256", "")).removeprefix("sha256:") != digest:
        raise RuntimeError("baseline APK hash mismatch")
    tracked = set(_run(["git", "ls-files"]).splitlines())
    forbidden = {
        APK_RELATIVE.as_posix(),
        *(path.as_posix() for path in DATABASES),
    }
    leaked = sorted(forbidden & tracked)
    if leaked:
        raise RuntimeError(f"frozen private artifacts are tracked: {leaked}")
    return {
        "version_name": BASELINE_VERSION,
        "version_code": BASELINE_VERSION_CODE,
        "apk_path": APK_RELATIVE.as_posix(),
        "apk_bytes": apk.stat().st_size,
        "apk_sha256": digest,
        "manifest_path": MANIFEST_RELATIVE.as_posix(),
        "manifest_sha256": _sha256_file(manifest_path),
    }


def _verify_archived_build(archive_root: Path) -> dict[str, str]:
    environment = dict(os.environ)
    environment.update({
        "ENV": "local",
        "DATABASE_URL": f"sqlite+aiosqlite:///{(archive_root / 'stage0-import.db').as_posix()}",
        "PYTHONPATH": str(archive_root / "services/laoji-api"),
    })
    api_output = _run(
        [sys.executable, "-c", "import app.main; print('api_import=ok')"],
        cwd=archive_root,
        env=environment,
    )
    asr_environment = dict(os.environ)
    asr_environment["PYTHONPATH"] = str(archive_root / "services/laoji-asr")
    asr_output = _run(
        [sys.executable, "-c", "import server; print('asr_import=ok')"],
        cwd=archive_root,
        env=asr_environment,
    )
    contract_output = _run(
        [sys.executable, str(archive_root / "contracts/vnext/generate.py"), "--check"],
        cwd=archive_root,
        env=environment,
    )
    return {
        "api_import": api_output.splitlines()[-1],
        "asr_import": asr_output.splitlines()[-1],
        "contracts": contract_output.splitlines()[-1],
    }


def _inventory(ref: str) -> dict[str, Any]:
    commit = _run(["git", "rev-list", "-n", "1", ref])
    artifacts = _verify_artifacts()
    current_contract_environment = dict(os.environ)
    current_contract_environment["PYTHONPATH"] = str(ROOT / "services/laoji-api")
    current_contract_check = _run(
        [sys.executable, str(ROOT / "contracts/vnext/generate.py"), "--check"],
        env=current_contract_environment,
    ).splitlines()[-1]
    with tempfile.TemporaryDirectory(prefix="laoji-stage0-") as raw_directory:
        directory = Path(raw_directory)
        archive_root = directory / "source"
        archive_root.mkdir()
        _safe_archive(ref, archive_root)
        build = _verify_archived_build(archive_root)
        restore_root = directory / "restore"
        restore_root.mkdir()
        for database in DATABASES:
            _restore_smoke(database, restore_root)
        services = [
            _source_inventory(archive_root, Path("services/laoji-api")),
            _source_inventory(archive_root, Path("services/laoji-asr")),
        ]
        routes = _routes(archive_root)
    databases = [_database_inventory(path) for path in DATABASES]
    return {
        "schema_version": 1,
        "baseline": {
            **artifacts,
            "git_tag": ref,
            "git_commit": commit,
            "production_mutation": False,
        },
        "source_import": {
            "services": services,
            "build_import_check": build,
            "credential_files_included": False,
        },
        "contracts": {
            "revision": "vnext-1",
            "manifest": "contracts/vnext/generated/manifest.json",
            "baseline_tag_check": build["contracts"],
            "current_branch_check": current_contract_check,
        },
        "databases": databases,
        "routes": routes,
        "workers": [
            {
                "source": "services/laoji-api/app/workers/summary_tasks.py",
                "target": "versioned-generic-task-handler",
                "action": "drain-legacy-delete-stage5",
            }
        ],
        "restore": {
            "tool": "tools/vnext/sqlite_snapshot.py",
            "smoke": "all snapshots restored with integrity_check=ok",
            "platforms": ["linux", "windows"],
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", default=BASELINE_REF)
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    parser.add_argument("--write-inventory", action="store_true")
    parser.add_argument("--check-inventory", action="store_true")
    args = parser.parse_args(argv)
    inventory = _inventory(args.baseline_ref)
    rendered = _canonical(inventory)
    inventory_path = ROOT / args.inventory
    if args.write_inventory:
        inventory_path.parent.mkdir(parents=True, exist_ok=True)
        inventory_path.write_text(rendered, encoding="utf-8")
    if args.check_inventory:
        if not inventory_path.is_file() or inventory_path.read_text(encoding="utf-8") != rendered:
            print("stage0_inventory_out_of_date")
            return 1
    print(
        "stage0_exit=verified "
        f"tables={sum(len(item['tables']) for item in inventory['databases'])} "
        f"routes={len(inventory['routes'])} "
        f"services={len(inventory['source_import']['services'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
