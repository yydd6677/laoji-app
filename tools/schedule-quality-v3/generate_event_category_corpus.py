#!/usr/bin/env python3
"""Generate an authored, balanced event-category classification corpus.

The labels are written from the case template and category precedence below;
the generator never imports or calls either parser.  This keeps the corpus
independent from the implementation under test.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT / "event-category-corpus.jsonl"
DEFAULT_MANIFEST = ROOT / "event-category-manifest.json"
CATEGORIES = ("工作", "学习", "健康", "生活", "社交", "出行", "财务", "重要", "其他")
PHRASES = {
    "工作": ("项目评审", "客户合同沟通", "接口联调", "版本发布复核"),
    "学习": ("复习算法", "培训课程", "课程作业", "阅读文献"),
    "健康": ("预约体检", "跑步训练", "复诊买药", "练习瑜伽"),
    "生活": ("买菜", "取快递", "整理衣柜", "修空调"),
    "社交": ("朋友聚餐", "生日聚会", "看电影", "和同学见面"),
    "出行": ("高铁出发", "旅行签证", "航班值机", "办理租车"),
    "财务": ("缴水电费", "报销发票", "还信用卡", "支付房租"),
    "重要": ("紧急版本发布", "截止提交材料", "必须回滚风险", "重要客户决策"),
    "其他": ("记录灵感", "看看展览", "整理收藏卡片", "想一个新点子"),
}
LOCATION_HINTS = {
    "工作": "项目会议室",
    "学习": "图书馆",
    "健康": "健身房",
    "生活": "家里",
    "社交": "咖啡店",
    "出行": "机场",
    "财务": "银行",
    "重要": "董事会议室",
    "其他": "公园",
}
TRADITIONAL = {
    "项目评审": "項目評審",
    "复习算法": "復習算法",
    "预约体检": "預約體檢",
    "买菜": "買菜",
    "朋友聚餐": "朋友聚餐",
    "高铁出发": "高鐵出發",
    "缴水电费": "繳水電費",
    "紧急版本发布": "緊急版本發布",
    "记录灵感": "記錄靈感",
}
ORAL_PREFIXES = ("明天上午九点安排", "请明天上午九点安排", "嗯，明天上午九点安排", "明天上午九点帮我记下")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def case(index: int, text: str, expected: str, scenario: str, *, layer: str = "both") -> dict[str, Any]:
    day = date(2026, 8, 4) + timedelta(days=index % 20)
    return {
        "case_id": f"CAT-{index:04d}",
        "text": text,
        "reference_datetime": f"{day.isoformat()}T08:00:00+08:00",
        "timezone": "Asia/Shanghai",
        "expected_category": expected,
        "scenario": scenario,
        "layer": layer,
        "label_source": "authored_metadata_v1",
        "input_sha256": sha256_text(text),
    }


def build_cases() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 1
    for category in CATEGORIES:
        phrases = PHRASES[category]
        other = CATEGORIES[(CATEGORIES.index(category) + 1) % len(CATEGORIES)]
        for slot, phrase in enumerate(phrases):
            prefix = ORAL_PREFIXES[slot % len(ORAL_PREFIXES)]
            rows.append(case(index, f"{prefix}{phrase}", category, "title_domain")); index += 1
            rows.append(case(index, f"明天下午三点安排一个事项，备注写{phrase}", category, "body_domain")); index += 1
            rows.append(case(index, f"明天上午九点安排{PHRASES[other][slot % 4]}，分类设为{category}", category, "explicit_category_override")); index += 1
            rows.append(case(index, f"明天上午九点安排{phrase}，地点在{LOCATION_HINTS[other]}", category, "title_precedes_location")); index += 1
            alias = TRADITIONAL.get(phrase, phrase)
            rows.append(case(index, f"嗯，明天上午九点，安排{alias}", category, "asr_traditional")); index += 1
            rows.append(case(index, f"2026年8月{10 + slot}日全天安排{phrase}", category, "all_day_domain")); index += 1
        # One explicit "other" directive per category tests the fallback bucket
        # and verifies that a user override can deliberately suppress keywords.
        rows.append(case(index, f"明天上午九点安排{phrases[0]}，类型设成其他", "其他", "explicit_other_override")); index += 1

    # Precedence cases: immediate relative reminders are intentionally important
    # even when the activity itself belongs to another domain.
    for category in CATEGORIES[:-1]:
        rows.append(case(index, f"15分钟后提醒我{PHRASES[category][0]}", "重要", "relative_reminder_priority")); index += 1
    for category in ("工作", "学习", "健康", "生活", "社交", "出行", "财务", "其他"):
        rows.append(case(index, f"明天上午九点安排{PHRASES[category][0]}，这件事很紧急", "重要", "urgency_priority")); index += 1

    # Genuine fallback and body-only conflicts.
    for phrase in ("记录灵感", "看看展览", "整理收藏卡片", "想一个新点子", "发呆一会儿", "观察天气"):
        rows.append(case(index, f"明天上午九点记录{phrase}", "其他", "fallback_other")); index += 1
    rows.append(case(index, "明天上午九点安排一个事项，地点在健身房", "其他", "body_location_only")); index += 1
    rows.append(case(index, "明天上午九点安排一个事项，备注写朋友聚餐", "社交", "body_note_only")); index += 1
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    args = parser.parse_args()
    rows = build_cases()
    if len({row["text"] for row in rows}) != len(rows):
        raise SystemExit("duplicate category corpus text")
    if any(row["label_source"] != "authored_metadata_v1" for row in rows):
        raise SystemExit("non-authored label")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
    counts = {category: sum(row["expected_category"] == category for row in rows) for category in CATEGORIES}
    manifest = {
        "schema_version": 1,
        "corpus": str(output),
        "total": len(rows),
        "unique_inputs": len({row["text"] for row in rows}),
        "category_counts": counts,
        "scenarios": sorted({row["scenario"] for row in rows}),
        "label_source": "authored_metadata_v1",
        "generator": "generate_event_category_corpus.py",
        "independent_oracle": True,
        "precedence": ["explicit_category_override", "relative_reminder_priority", "urgency_priority", "title_domain", "body_domain", "other"],
    }
    Path(args.manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
