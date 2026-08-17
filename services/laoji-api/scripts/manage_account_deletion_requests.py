#!/usr/bin/env python3
"""Review and process LaoJi account-deletion requests from an operator terminal."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(BACKEND_ROOT / ".env")

from app.database import async_session  # noqa: E402
from app.services import laoji_auth_service as auth  # noqa: E402
from app.services.account_deletion_operator import (  # noqa: E402
    complete_account_deletion_request,
)


def _exact_confirmation(request_id: str, confirmation: str) -> None:
    if confirmation != request_id:
        raise ValueError("--confirm 必须与删除请求 ID 完全一致")


def _print_json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


async def _complete(args: argparse.Namespace) -> None:
    _exact_confirmation(args.request_id, args.confirm)
    if not args.identity_verified:
        raise ValueError("处理前必须完成身份核验并传入 --identity-verified")
    async with async_session() as db:
        report = await complete_account_deletion_request(
            args.request_id,
            db,
            identity_verified=True,
            resume=args.resume,
        )
    _print_json(asdict(report))


def _reject(args: argparse.Namespace) -> None:
    _exact_confirmation(args.request_id, args.confirm)
    _print_json(auth.reject_account_deletion_request(args.request_id))


def _list(args: argparse.Namespace) -> None:
    _print_json(auth.list_account_deletion_requests(args.status, args.limit))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="老记账号删除申请处理工具。不要在完成线下身份核验前执行 complete。"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="列出删除申请")
    list_parser.add_argument(
        "--status",
        choices=("pending", "processing", "completed", "rejected", "all"),
        default="pending",
    )
    list_parser.add_argument("--limit", type=int, default=100)

    reject_parser = subparsers.add_parser("reject", help="拒绝并清除申请中的个人信息")
    reject_parser.add_argument("request_id")
    reject_parser.add_argument("--confirm", required=True, metavar="REQUEST_ID")

    complete_parser = subparsers.add_parser("complete", help="删除已核验账号的全部服务端数据")
    complete_parser.add_argument("request_id")
    complete_parser.add_argument("--confirm", required=True, metavar="REQUEST_ID")
    complete_parser.add_argument("--identity-verified", action="store_true")
    complete_parser.add_argument(
        "--resume",
        action="store_true",
        help="仅在确认上一次处理进程已经停止后恢复 processing 请求",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "list":
            _list(args)
        elif args.command == "reject":
            _reject(args)
        else:
            asyncio.run(_complete(args))
    except (ValueError, RuntimeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
