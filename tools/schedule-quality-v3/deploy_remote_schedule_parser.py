#!/usr/bin/env python3
"""Safely replace the parser used by one already-running LaoJi uvicorn.

This script is intended to be copied to the target host and run as the same
Unix user that owns the service. It deliberately refuses to guess a process,
force-kill a service, or touch any port other than the requested uvicorn.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def read_cmdline(pid: int) -> str:
    return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace").strip()


def read_cwd(pid: int) -> str:
    return os.path.realpath(f"/proc/{pid}/cwd")


def read_environment(pid: int) -> dict[str, str]:
    result: dict[str, str] = {}
    for entry in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
        if b"=" not in entry:
            continue
        key, value = entry.split(b"=", 1)
        result[key.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
    return result


def established_connections(port: int) -> list[str]:
    try:
        completed = subprocess.run(
            ["ss", "-tnp"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return []
    marker = f":{port}"
    return [
        line.strip()
        for line in completed.stdout.splitlines()
        if "ESTAB" in line and marker in line
    ]


def wait_process_exit(pid: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.25)
    raise RuntimeError(f"旧服务 PID {pid} 未在 {timeout:.0f}s 内退出，未强制杀进程")


def stop_process(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    wait_process_exit(pid)


def start_service(*, backend: Path, environment: dict[str, str], port: int, log_path: Path) -> int:
    python = backend / ".venv/bin/python3.11"
    if not python.is_file():
        python = Path(sys.executable)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = log_path.open("ab")
    process = subprocess.Popen(
        [
            str(python),
            "-m",
            "uvicorn",
            "app.laoji.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
        ],
        cwd=backend,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )
    log.close()
    return process.pid


def wait_health(port: int, timeout: float = 30.0) -> dict:
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.monotonic() + timeout
    last_error: str | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                body = response.read().decode("utf-8", "replace")
                payload = json.loads(body)
                if response.status == 200:
                    return payload
                last_error = f"HTTP {response.status}"
        except (OSError, ValueError) as exc:
            last_error = str(exc)
        time.sleep(0.5)
    raise RuntimeError(f"健康检查超时: {last_error or 'unknown error'}")


def sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--backend", type=Path, required=True)
    parser.add_argument("--source-temp", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--port", type=int, default=18035)
    parser.add_argument("--log", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    backend = args.backend.resolve()
    target = args.target.resolve()
    source_temp = args.source_temp.resolve()
    backup = args.backup.resolve()
    if read_cwd(args.pid) != str(backend):
        raise SystemExit(f"PID {args.pid} 工作目录不匹配: {read_cwd(args.pid)}")
    cmdline = read_cmdline(args.pid)
    if "uvicorn" not in cmdline or str(args.port) not in cmdline:
        raise SystemExit(f"PID {args.pid} 命令不匹配: {cmdline}")
    if not source_temp.is_file() or not target.is_file():
        raise SystemExit("源文件或目标文件不存在")
    active = established_connections(args.port)
    if active:
        raise SystemExit(f"端口 {args.port} 仍有活动连接: {active[0]}")

    old_environment = read_environment(args.pid)
    old_hash = sha256(target)
    new_hash = sha256(source_temp)
    backup.parent.mkdir(parents=True, exist_ok=True)
    if backup.exists():
        if sha256(backup) != old_hash:
            raise SystemExit(f"已有备份与当前源码不一致，拒绝使用: {backup}")
    else:
        shutil.copy2(target, backup)
    os.replace(source_temp, target)

    old_stopped = False
    new_pid: int | None = None
    try:
        stop_process(args.pid)
        old_stopped = True
        new_pid = start_service(
            backend=backend,
            environment=old_environment,
            port=args.port,
            log_path=args.log.resolve(),
        )
        health = wait_health(args.port)
        print(json.dumps({
            "status": "deployed",
            "old_pid": args.pid,
            "new_pid": new_pid,
            "old_source_sha256": old_hash,
            "new_source_sha256": new_hash,
            "backup": str(backup),
            "health": health,
        }, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        if new_pid is not None:
            try:
                stop_process(new_pid)
            except Exception:
                pass
        shutil.copy2(backup, target)
        if old_stopped:
            restored_pid = start_service(
                backend=backend,
                environment=old_environment,
                port=args.port,
                log_path=args.log.resolve(),
            )
            try:
                wait_health(args.port)
            except Exception as restore_error:
                raise RuntimeError(f"部署失败且回滚健康检查失败: {restore_error}") from exc
            print(json.dumps({
                "status": "rolled_back",
                "reason": str(exc),
                "restored_pid": restored_pid,
                "restored_source_sha256": sha256(target),
                "backup": str(backup),
            }, ensure_ascii=False, sort_keys=True))
        raise


if __name__ == "__main__":
    raise SystemExit(main())
