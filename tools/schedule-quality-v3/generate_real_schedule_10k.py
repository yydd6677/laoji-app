#!/usr/bin/env python3
"""Generate an independently labelled, semantically diverse 10k corpus.

The corpus is deliberately separate from the historical deterministic corpus.
Labels are authored from the case metadata before any HTTP request is made;
the generator never imports the schedule parser or derives an expectation from
an observed response.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
CORPUS_PATH = ROOT / "schedule-real-10k.jsonl"
MANIFEST_PATH = ROOT / "schedule-real-10k-manifest.json"
TOTAL = 10_000
EVENT_COUNT = 1_000
VARIANTS_PER_EVENT = 10
MAX_ATOM_USES = 10

# These combinations yield 1,000 meaningful event concepts.  The numeric
# indices are metadata only; no index is included in user-visible text.
ACTIONS = (
    "讨论", "确认", "检查", "整理", "评审", "复盘", "规划", "更新", "准备", "核对",
    "提交", "验收", "跟进", "沟通", "学习", "预约", "办理", "购买", "维护", "安排",
)
OBJECTS = (
    "供应商合同", "移动端性能", "季度预算", "客户反馈", "版本发布", "课程作业", "体检报告", "差旅行程",
    "项目风险", "招聘计划", "数据口径", "营销方案", "仓储盘点", "安全演练", "产品需求", "服务告警",
    "专利材料", "培训计划", "回款进度", "设备维护", "研究样本", "采购清单", "接口文档", "测试报告",
    "员工排班", "展会物料", "房屋租约", "家庭账单", "孩子课程", "旅行签证", "车辆保养", "药品清单",
    "阅读计划", "运动训练", "客户拜访", "门店巡查", "供应链方案", "数据备份", "安全证书", "产品定价",
    "年度总结", "季度复盘", "社群活动", "志愿服务", "早餐采购", "园区报修", "水电缴费", "保险续期",
    "照片归档", "密码更换", "设备借用", "会议材料",
)

POLITENESS = ("请", "麻烦", "劳烦", "能否", "帮我", "请帮忙", "烦请", "有空请", "还请", "请替我")
MANNERS = ("顺手", "提前", "先", "直接", "一并", "顺便", "尽快", "另外", "优先", "稍后")
ORAL_VERBS = ("安排", "记下", "排进日程", "加到日历", "登记", "留个时间", "记一笔", "排个安排", "放进日程", "建个日程")

CONNECTOR_NOUNS = ("主题", "事项", "日程", "计划", "任务", "活动", "安排", "内容", "工作", "会议")
CONNECTOR_VERBS = ("是", "定为", "写成", "记为", "叫作", "安排为", "记录成", "就写", "名称为", "定名为")
CONNECTOR_MODIFIERS = ("这次", "本次", "今天", "该项", "当前", "接下来", "新的", "这件", "下一个", "待办")

LOCATION_ROOTS = (
    "青松", "云杉", "银杏", "梧桐", "玉兰", "海棠", "芙蓉", "桂花", "紫藤", "栀子",
    "晨光", "星河", "远山", "清泉", "知行", "致远", "明德", "博雅", "启明", "望海",
    "听潮", "映月", "和风", "朗月", "长安", "江南", "云水", "松涛", "竹影", "荷风",
    "飞鸟", "归帆", "北辰", "南风", "东篱", "西岭", "中庭", "澄明", "守正", "笃行",
    "融汇", "新知", "远航", "同心", "致和", "嘉禾", "安澜", "景行", "问道", "观澜",
)
LOCATION_SUFFIXES = (
    "大厅", "东厅", "西厅", "南厅", "北厅", "报告厅", "培训室", "讨论室", "洽谈室", "会客室",
    "一号室", "二号室", "三号室", "四号室", "五号室", "开放区", "阅读区", "路演厅", "接待室", "工作间",
)

WEEKDAYS = "一二三四五六日"
BASE_REFERENCE = datetime(2026, 8, 3, 9, 0)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def event_seeds() -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for action_index, action in enumerate(ACTIONS):
        for object_index, obj in enumerate(OBJECTS[:50]):
            result.append({
                "event_concept_key": f"event:{action_index:02d}:{object_index:02d}",
                "title": f"{action}{obj}",
            })
    assert len(result) == EVENT_COUNT
    assert len({item["title"] for item in result}) == EVENT_COUNT
    return result


def date_expression(slot: int, *, end: bool = False) -> tuple[str, str]:
    anchor = date(2026, 8, 2) if end else date(2026, 8, 1)
    value = anchor + timedelta(days=slot)
    expression = f"{value.year}年{value.month}月{value.day}{'号' if end else '日'}"
    return f"date:{'end' if end else 'start'}:{slot:04d}", expression


def date_value(slot: int, *, end: bool = False) -> str:
    anchor = date(2026, 8, 2) if end else date(2026, 8, 1)
    return (anchor + timedelta(days=slot)).isoformat()


def time_expression(slot: int) -> tuple[str, str, str, str]:
    # Use a broad but valid set of clock values.  The HTTP service accepts the
    # numeric HH:MM form consistently, and each value is a different semantic
    # time rather than a tracking suffix.
    minute_of_day = (7 * 60 + slot) % (24 * 60)
    hour, minute = divmod(minute_of_day, 60)
    value = f"{hour:02d}:{minute:02d}"
    end_minute = (minute_of_day + 60) % (24 * 60)
    end_hour, end_minute_part = divmod(end_minute, 60)
    end_value = f"{end_hour:02d}:{end_minute_part:02d}"
    return f"time:{slot:04d}", value, end_value, f"time:{slot:04d}"


def location_expression(slot: int) -> tuple[str, str]:
    root = LOCATION_ROOTS[slot // len(LOCATION_SUFFIXES)]
    suffix = LOCATION_SUFFIXES[slot % len(LOCATION_SUFFIXES)]
    value = f"{root}{suffix}"
    return f"location:{slot:04d}", value


def oral_expression(slot: int) -> tuple[str, str]:
    p = POLITENESS[slot // 100]
    m = MANNERS[(slot // 10) % 10]
    v = ORAL_VERBS[slot % 10]
    value = f"{p}{m}{v}"
    return f"oral:{slot:04d}", value


def connector_expression(slot: int) -> tuple[str, str]:
    modifier = CONNECTOR_MODIFIERS[slot // 100]
    noun = CONNECTOR_NOUNS[(slot // 10) % 10]
    verb = CONNECTOR_VERBS[slot % 10]
    value = f"，{modifier}{noun}{verb}"
    return f"connector:{slot:04d}", value


def reference_datetime(event_index: int) -> str:
    value = BASE_REFERENCE + timedelta(days=event_index % 365, minutes=event_index % 60)
    return value.isoformat(timespec="seconds") + "+08:00" if value.tzinfo is None else value.isoformat(timespec="seconds")


def reminder_expression(slot: int) -> tuple[str, str, int]:
    minutes = slot + 1
    return f"reminder:{slot:04d}", f"，提前{minutes}分钟提醒", minutes


def expected_event(
    title: str,
    start_date: str,
    start_time: str | None,
    end_time: str | None,
    *,
    end_date: str | None = None,
    event_type: str = "once",
    is_all_day: bool = False,
    location: str | None = None,
    reminder_minutes: int | None = None,
    needs_clarification: bool = False,
) -> dict[str, Any]:
    return {
        "title": title,
        "event_type": event_type,
        "start_date": start_date,
        "end_date": end_date,
        "start_time": start_time,
        "end_time": end_time,
        "is_all_day": is_all_day,
        "location": location,
        "reminder_minutes": reminder_minutes,
        "needs_clarification": needs_clarification,
    }


def make_case(index: int, seeds: list[dict[str, str]]) -> dict[str, Any]:
    event_index, variant = divmod(index, VARIANTS_PER_EVENT)
    slot = index % EVENT_COUNT
    seed = seeds[event_index]
    title = seed["title"]
    date_key, start_date_text = date_expression(slot)
    end_date_key, end_date_text = date_expression(slot, end=True)
    time_key, start_time, end_time, _ = time_expression(slot)
    location_key, location = location_expression(slot)
    oral_key, oral = oral_expression(slot)
    connector_key, connector = connector_expression(slot)
    reminder_key, reminder_text, reminder_minutes = reminder_expression(slot)
    reference = reference_datetime(event_index)
    family: str
    expected: dict[str, Any] | None
    text: str
    date_key_used = date_key
    time_key_used = time_key
    location_key_used: str | None = location_key
    correction_key: str | None = None

    if variant == 0:
        family = "explicit_timed_location"
        text = f"{oral}，{start_date_text}{start_time}{connector}{title}，地点在{location}{reminder_text}"
        expected = expected_event(title, date_value(slot), start_time, end_time, location=location, reminder_minutes=reminder_minutes)
    elif variant == 1:
        family = "explicit_timed_no_location"
        text = f"{oral}，{start_date_text}{start_time}{connector}{title}{reminder_text}"
        location_key_used = None
        expected = expected_event(title, date_value(slot), start_time, end_time, reminder_minutes=reminder_minutes)
    elif variant == 2:
        family = "all_day_location"
        text = f"{oral}，{start_date_text}全天{connector}{title}，地点在{location}"
        time_key_used = None
        expected = expected_event(title, date_value(slot), None, None, is_all_day=True, location=location, reminder_minutes=None)
    elif variant == 3:
        family = "date_range"
        text = f"{oral}，从{start_date_text}到{end_date_text}{start_time}{connector}{title}，地点在{location}"
        date_key_used = f"range:{date_key}:{end_date_key}"
        expected = expected_event(title, date_value(slot), start_time, end_time, end_date=date_value(slot, end=True), location=location, reminder_minutes=15)
    elif variant == 4:
        family = "weekly_recurrence"
        weekday = WEEKDAYS[date.fromisoformat(date_value(slot)).weekday()]
        text = f"{oral}，从{start_date_text}起每周{weekday}{start_time}{connector}{title}"
        expected = expected_event(title, date_value(slot), start_time, end_time, event_type="weekly", reminder_minutes=15)
    elif variant == 5:
        family = "relative_minutes"
        offset = slot + 1
        relative_key = f"relative:{offset:04d}"
        text = f"{oral}，{offset}分钟后{connector}{title}"
        target = datetime.fromisoformat(reference) + timedelta(minutes=offset)
        expected = expected_event(title, target.date().isoformat(), target.strftime("%H:%M"), (target + timedelta(hours=1)).strftime("%H:%M"), reminder_minutes=15)
        date_key_used = relative_key
        time_key_used = relative_key
    elif variant == 6:
        family = "missing_date_clarification"
        text = f"{oral}，提醒我在{start_time}处理{title}{reminder_text}"
        expected = expected_event(title, "", start_time, end_time, reminder_minutes=reminder_minutes, needs_clarification=True)
        date_key_used = f"missing-date:{slot:04d}"
    elif variant == 7:
        family = "uncertain_location_clarification"
        text = f"{oral}，{start_date_text}{start_time}{connector}{title}，地点可能在{location}"
        expected = expected_event(title, date_value(slot), start_time, end_time, location=None, reminder_minutes=15, needs_clarification=True)
        location_key_used = f"uncertain:{location_key}"
    elif variant == 8:
        family = "date_time_correction"
        correction_date_key, correction_date_text = date_expression((slot + 400) % EVENT_COUNT, end=True)
        correction_time_key, correction_time, correction_end_time, _ = time_expression((slot + 400) % EVENT_COUNT)
        text = f"{oral}，原定{start_date_text}{start_time}，改成{correction_date_text}{correction_time}{connector}{title}"
        expected = expected_event(title, date_value((slot + 400) % EVENT_COUNT, end=True), correction_time, correction_end_time, reminder_minutes=15)
        correction_key = f"correction:{date_key}:{correction_date_key}:{time_key}:{correction_time_key}"
        date_key_used = correction_key
        time_key_used = correction_key
    else:
        family = "explicit_negative_control"
        text = f"不要创建{start_date_text}{start_time}{connector}{title}"
        expected = None
        location_key_used = None
        reminder_key = None

    payload = {
        "case_id": f"REAL10K-{index + 1:05d}",
        "text": text,
        "reference_datetime": reference,
        "timezone": "Asia/Shanghai",
        "family": family,
        "variant": variant,
        "event_concept_key": seed["event_concept_key"],
        "oral_style_key": oral_key,
        "connector_key": connector_key,
        "date_expression_key": date_key_used,
        "time_expression_key": time_key_used,
        "location_key": location_key_used,
        "reminder_expression_key": reminder_key,
        "correction_intent_key": correction_key,
        "template_signature": f"{family}:frame:{slot:04d}",
        "expected_outcome": "not_schedule" if expected is None else "needs_clarification" if expected.get("needs_clarification") else "complete",
        "expected": expected,
        "label_source": "authored_metadata_v1",
        "source_type": "authored_semantic_seed",
        "input_sha256": sha256_text(json.dumps({"text": text, "reference_datetime": reference, "timezone": "Asia/Shanghai"}, ensure_ascii=False, sort_keys=True)),
    }
    semantic = {
        "event": seed["event_concept_key"],
        "variant": variant,
        "text_semantics": expected,
        "date_expression": date_key_used,
        "time_expression": time_key_used,
        "location": location_key_used,
    }
    payload["semantic_signature"] = sha256_text(json.dumps(semantic, ensure_ascii=False, sort_keys=True))
    return payload


def audit(corpus: list[dict[str, Any]]) -> dict[str, Any]:
    keys = (
        "event_concept_key", "oral_style_key", "connector_key", "date_expression_key",
        "time_expression_key", "location_key", "reminder_expression_key", "correction_intent_key",
        "template_signature", "semantic_signature",
    )
    counts: dict[str, Counter[str]] = {}
    violations: list[dict[str, Any]] = []
    for key in keys:
        counter = Counter(str(item[key]) for item in corpus if item.get(key) not in (None, ""))
        counts[key] = counter
        for value, count in counter.items():
            if count > MAX_ATOM_USES:
                violations.append({"key": key, "value": value, "count": count})
    distinct = {item["text"] for item in corpus}
    semantic_distinct = {item["semantic_signature"] for item in corpus}
    return {
        "total": len(corpus),
        "text_unique": len(distinct) == len(corpus),
        "semantic_unique": len(semantic_distinct) == len(corpus),
        "max_atom_count": {key: max(counter.values(), default=0) for key, counter in counts.items()},
        "distinct_atom_count": {key: len(counter) for key, counter in counts.items()},
        "violations": violations,
        "passed": len(corpus) == TOTAL and len(distinct) == TOTAL and len(semantic_distinct) == TOTAL and not violations,
    }


def generate() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    seeds = event_seeds()
    corpus = [make_case(index, seeds) for index in range(TOTAL)]
    report = audit(corpus)
    if not report["passed"]:
        raise SystemExit(json.dumps(report, ensure_ascii=False, indent=2))
    return corpus, report


def main() -> int:
    corpus, report = generate()
    text = "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in corpus)
    CORPUS_PATH.write_text(text, encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "dataset_version": "schedule-real-10k-v1",
        "evidence_type": "real_http_per_case_pending",
        "label_source": "authored_metadata_v1",
        "independent_oracle": True,
        "remote_service": True,
        "total": TOTAL,
        "max_atom_uses": MAX_ATOM_USES,
        "corpus_sha256": sha256_text(text),
        "generator_sha256": sha256_text(Path(__file__).read_text(encoding="utf-8")),
        "audit": report,
        "controlled_keys": [
            "event_concept_key", "oral_style_key", "connector_key", "date_expression_key",
            "time_expression_key", "location_key", "reminder_expression_key", "correction_intent_key",
            "template_signature", "semantic_signature",
        ],
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "corpus": str(CORPUS_PATH), "manifest": str(MANIFEST_PATH), "audit": report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
