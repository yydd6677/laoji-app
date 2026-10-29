"""Minimal isolated realtime API. No import/summary/retention worker runs.

Uses a copied registration/token store to validate the emulator's real bearer.
All control writes, audio spools and speaker payloads go to a private copy.
"""
import argparse
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--runtime-pid", type=int, required=True)
parser.add_argument("--database-copy", type=Path, required=True)
parser.add_argument("--port", type=int, default=18023)
args = parser.parse_args()
for row in Path(f"/proc/{args.runtime_pid}/environ").read_bytes().split(b"\0"):
    key, sep, value = row.partition(b"=")
    if sep:
        os.environ[key.decode()] = value.decode()
root = args.database_copy.resolve().parent
assert args.database_copy.is_file()
os.environ.update(DATABASE_URL=f"sqlite+aiosqlite:///{args.database_copy.resolve()}",
    VNEXT_REALTIME_SPOOL_PATH=str(root / "test-realtime-spool"),
    VNEXT_SPEAKER_SPOOL_PATH=str(root / "test-speaker-spool"),
    LOCAL_DEVICE="cpu", R2_ENABLED="false")
from fastapi import FastAPI
from app.api.device_v2_realtime import router
from app.services.vnext_task_health import task_runtime_snapshot
app = FastAPI()
app.include_router(router, prefix="/api")


@app.get("/task-health")
def health():
    return task_runtime_snapshot()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port)
