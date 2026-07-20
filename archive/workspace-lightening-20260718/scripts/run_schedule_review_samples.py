#!/usr/bin/env python3
"""Run LaoJi review samples against a parse endpoint and flag likely issues."""

from __future__ import annotations

import argparse
import calendar
import concurrent.futures
import json
import random
import re
import statistics
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any


DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


CATEGORY_HINTS = {
    "work": "工作",
    "study": "学习",
    "health": "健康",
    "life": "生活",
    "social": "社交",
    "travel": "出行",
    "finance": "财务",
    "important": "重要",
}

CORE_FIELDS = [
    "title",
    "event_type",
    "start_date",
    "end_date",
    "start_time",
    "end_time",
    "is_all_day",
    "category",
    "reminder_minutes",
    "needs_clarification",
    "clarification_question",
    "location",
    "parse_source",
]

COMPLEX_SIGNAL_RE = re.compile(
    r"(不是|不对|说错|改成|最终|最后|更正|纠正|别弄错|以后面的为准|后面的为准|"
    r"不要保存|不要真的|只是测试|只是举例|不是日程|先别自动|晚点补|还没定|没想好|如果冲突)"
)
TIME_RE = re.compile(
    r"([01]?\d|2[0-3])[:：][0-5]\d|"
    r"(凌晨|早上|上午|中午|下午|晚上|晚间)?[0-9一二两三四五六七八九十]{1,3}点"
)
RELATIVE_TIME_RE = re.compile(
    r"(?:半(?:个)?小时|一刻钟|[0-9一二两三四五六七八九十]{1,3}"
    r"(?:分钟|(?:个)?小时|刻钟))(?:之后|以后|后)"
)
RECURRENCE_SIGNAL_RE = re.compile(
    r"(?:每天|每日|每(?:周|星期|礼拜)[一二三四五六日天1-7]|"
    r"每月[0-9一二两三四五六七八九十]{1,3}(?:号|日)|"
    r"每年[0-9一二两三四五六七八九十]{1,2}月"
    r"[0-9一二两三四五六七八九十]{1,3}(?:号|日))"
)
DATE_RANGE_SIGNAL_RE = re.compile(r"(?:到|至|直到|之间|[-—~～])")
LOCATION_UNCERTAINTY_RE = re.compile(r"地点(?:还)?(?:可能|没定|未定|不确定)")
VAGUE_NEXT_MONTH_RE = re.compile(r"(?:下个月|下月)(?![0-9一二两三四五六七八九十]{1,3}(?:号|日))")
LOCATION_PLACEHOLDER_RE = re.compile(r"^(?:未指定|未知|无|暂无|待定|不确定|没有|未提供|none|null)$", re.IGNORECASE)
TITLE_LEAK_RE = re.compile(
    r"(标题不|需要通知|别覆盖前面|不要漏掉前面日期|地点还可能变|"
    r"先不要和上周|如果下午被占|这件事和|主要确认|重点是|我处理|"
    r"给我安排|帮我设一下|加个待办)"
)
TITLE_TEMPORAL_LEAK_RE = re.compile(
    r"(?:今天|今日|明天|后天|大后天|月底|月末|下月底|下月末)|"
    r"(?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7]|"
    r"(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)|"
    r"(?:[01]?\d|2[0-3])[:：][0-5]\d|"
    r"(?:凌晨|早上|上午|中午|下午|晚上|晚间)?[0-9一二两三四五六七八九十]{1,3}点"
)
TITLE_META_LEAK_RE = re.compile(
    r"(声音可能有点小|(?:不要|别|不)漏(?:掉)?前面日期|别覆盖前面的安排|"
    r"日程里加一下|把这个放进日程|先按重日程记)"
)
CATEGORY_VALUES = {"工作", "学习", "健康", "生活", "社交", "出行", "财务", "重要", "其他"}

WEEKDAY_INDEX = {
    "一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5,
    "日": 6, "天": 6, "1": 0, "2": 1, "3": 2, "4": 3,
    "5": 4, "6": 5, "7": 6,
}
WEEKDAY_RE = re.compile(r"(?<!每)(下下|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])")
DATE_SIGNAL_RE = re.compile(
    r"(?:今天|今日|明天|后天|大后天)|"
    r"(?:(?:下下|下|本|这)?(?:周|星期|礼拜)[一二三四五六日天1-7])|"
    r"(?:下月底|下月末|月底|月末)|"
    r"(?:本月|这个月|下月|下个月)|"
    r"(?:(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,4}月"
    r"[0-9一二两三四五六七八九十]{1,4}(?:号|日))|"
    r"(?:[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2})|"
    r"(?:每天|每日|每周|每星期|每礼拜|每月|每年)"
)
AUDIT_DATE_TOKEN_RE = re.compile(
    r"(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,4}月"
    r"[0-9一二两三四五六七八九十]{1,4}(?:号|日)|"
    r"(?:下个月|下月|本月|这个月)[0-9一二两三四五六七八九十]{1,4}(?:号|日)|"
    r"(?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7]|"
    r"(?:下月底|下月末|月底|月末|大后天|后天|明天|今天|今日)"
)
MISSING_DATE_INTENT_RE = re.compile(
    r"(?:日期|哪天|哪一天).{0,10}(?:没想好|没定|未定|不确定|晚点补)|"
    r"(?:没想好|没定|未定|不确定|晚点补).{0,10}(?:日期|哪天|哪一天)"
)


def load_samples(path: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t", 5)
        if len(parts) != 6:
            raise ValueError(f"bad sample row: {line}")
        rows.append(
            {
                "id": parts[0],
                "group": parts[1],
                "category_hint": parts[2],
                "oral": parts[3],
                "noise": parts[4],
                "text": parts[5],
            }
        )
    return rows


def stratified_sample(
    rows: list[dict[str, str]],
    per_group: int | None,
    seed: int,
) -> list[dict[str, str]]:
    if per_group is None:
        return rows
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[row["group"]].append(row)
    rng = random.Random(seed)
    selected: list[dict[str, str]] = []
    for group in sorted(grouped):
        candidates = list(grouped[group])
        rng.shuffle(candidates)
        selected.extend(candidates[:per_group])
    return sorted(selected, key=lambda item: item["id"])


def select_sample_ids(
    rows: list[dict[str, str]],
    sample_ids: list[str],
) -> list[dict[str, str]]:
    if not sample_ids:
        return rows
    requested = set(sample_ids)
    selected = [row for row in rows if row["id"] in requested]
    found = {row["id"] for row in selected}
    missing = sorted(requested - found)
    if missing:
        raise ValueError(f"unknown sample ids: {','.join(missing)}")
    return selected


def percentile(values: list[int], percent: float) -> int:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(len(ordered) * percent + 0.999999) - 1))
    return ordered[index]


def duration_summary(values: list[int]) -> dict[str, int | float]:
    if not values:
        return {"count": 0, "min": 0, "median": 0, "mean": 0, "p90": 0, "p95": 0, "p99": 0, "max": 0}
    return {
        "count": len(values),
        "min": min(values),
        "median": statistics.median(values),
        "mean": round(statistics.mean(values), 2),
        "p90": percentile(values, 0.90),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
        "max": max(values),
    }


def schedule_gate_issues(
    report: dict[str, Any],
    *,
    max_rows_with_issues: int | None = None,
    max_case_ms: float | None = None,
    max_p95_ms: float | None = None,
    max_elapsed_ms: float | None = None,
    required_parse_sources: set[str] | None = None,
) -> list[str]:
    issues: list[str] = []
    rows_with_issues = int(report.get("rows_with_issues", 0))
    duration = report.get("duration_ms") or {}
    elapsed_ms = float(report.get("elapsed_ms", 0))
    if max_rows_with_issues is not None and rows_with_issues > max_rows_with_issues:
        issues.append(f"rows_with_issues:{rows_with_issues}>{max_rows_with_issues}")
    if max_case_ms is not None and float(duration.get("max", 0)) > max_case_ms:
        issues.append(f"max_case_ms:{duration.get('max', 0)}>{max_case_ms:g}")
    if max_p95_ms is not None and float(duration.get("p95", 0)) > max_p95_ms:
        issues.append(f"p95_ms:{duration.get('p95', 0)}>{max_p95_ms:g}")
    if max_elapsed_ms is not None and elapsed_ms > max_elapsed_ms:
        issues.append(f"elapsed_ms:{elapsed_ms:g}>{max_elapsed_ms:g}")
    if required_parse_sources:
        unexpected = sorted({
            str(row.get("parse_source"))
            for row in report.get("rows", [])
            if str(row.get("parse_source")) not in required_parse_sources
        })
        if unexpected:
            issues.append(f"unexpected_parse_sources:{','.join(unexpected)}")
    return issues


def post_parse(endpoint: str, text: str, timeout: float) -> tuple[dict[str, Any] | None, str | None]:
    body = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with DIRECT_OPENER.open(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8")
        return json.loads(payload), None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return None, f"HTTP {exc.code}: {detail[:300]}"
    except Exception as exc:  # noqa: BLE001 - diagnostics must keep going.
        return None, repr(exc)


def reminder_expected(text: str) -> int | None | str:
    if re.search(r"(不用提醒|不要提醒|无需提醒|不提醒)", text):
        return "none"
    if re.search(r"(开始时|到点|准时)提醒", text):
        return 0
    if "提前半小时提醒" in text:
        return 30
    exact = {
        "十": 10,
        "十五": 15,
        "二十": 20,
        "三十": 30,
        "两": 2,
        "二": 2,
        "一": 1,
    }
    match = re.search(r"提前([一二两三四五六七八九十十五二十三十0-9]{1,3})(分钟|小时|天)提醒", text)
    if not match:
        return None
    raw, unit = match.groups()
    value = int(raw) if raw.isdigit() else exact.get(raw)
    if value is None:
        return None
    if unit == "小时":
        value *= 60
    elif unit == "天":
        value *= 24 * 60
    return value


def expected_weekday_date(text: str) -> str | None:
    matches = list(WEEKDAY_RE.finditer(text))
    if not matches:
        return None
    match = matches[-1] if _contains_correction(text) else matches[0]
    prefix = match.group(1) or ""
    target_weekday = WEEKDAY_INDEX[match.group(2)]
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    if prefix == "下下":
        candidate = monday + timedelta(days=14 + target_weekday)
    elif prefix == "下":
        candidate = monday + timedelta(days=7 + target_weekday)
    elif prefix in {"本", "这"}:
        candidate = monday + timedelta(days=target_weekday)
    else:
        delta = target_weekday - today.weekday()
        if delta <= 0:
            delta += 7
        candidate = today + timedelta(days=delta)
    return candidate.isoformat()


def _contains_correction(text: str) -> bool:
    return bool(re.search(
        r"(不(?:额|呃|嗯|那个|可能)?是|不对|说(?:额|呃|嗯|那个|可能)?错|"
        r"改(?:额|呃|嗯|那个|可能)?成|最终|最后|更正|纠正|以后面的为准|后面的为准)",
        text,
    ))


def _cn_to_int(value: str) -> int:
    if value.isdigit():
        return int(value)
    digits = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if value == "十":
        return 10
    if "十" in value:
        left, right = value.split("十", 1)
        return (digits.get(left, 1) * 10) + digits.get(right, 0)
    number = 0
    for char in value:
        number = number * 10 + digits.get(char, 0)
    return number


def normalize_sparse_date_noise(text: str) -> str:
    filler = r"(?:额|呃|嗯|那个|可能|就是|差不多|先这样)"
    normalized = re.sub(
        rf"([0-9一二两三四五六七八九十]{{1,2}})\s*[，,]?(?:{filler})[，,]?\s*月",
        r"\1月",
        text,
    )
    normalized = re.sub(
        rf"([0-9一二两三四五六七八九十]{{1,2}}月[0-3]?)\s*[，,]?(?:{filler})[，,]?\s*([0-9])(?=号|日)",
        r"\1\2",
        normalized,
    )
    normalized = re.sub(rf"月\s*[，,]?(?:{filler})[，,]?\s*(底|末)", r"月\1", normalized)
    return normalized


def expected_single_date(text: str, today: date | None = None) -> str | None:
    if DATE_RANGE_SIGNAL_RE.search(text) and len(AUDIT_DATE_TOKEN_RE.findall(text)) >= 2:
        return None
    today = today or date.today()
    normalized = normalize_sparse_date_noise(text)
    candidates: list[tuple[int, date]] = []

    def add(position: int, year: int, month: int, day: int) -> None:
        try:
            candidates.append((position, date(year, month, day)))
        except ValueError:
            return

    for match in re.finditer(
        r"([0-9]{4})年([0-9一二两三四五六七八九十]{1,2})月"
        r"([0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        normalized,
    ):
        add(match.start(), int(match.group(1)), _cn_to_int(match.group(2)), _cn_to_int(match.group(3)))

    for match in re.finditer(
        r"(下个月|下月|本月|这个月)([0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        normalized,
    ):
        year, month = today.year, today.month
        if match.group(1) in {"下个月", "下月"}:
            year += int(month == 12)
            month = 1 if month == 12 else month + 1
        add(match.start(), year, month, _cn_to_int(match.group(2)))

    for match in re.finditer(
        r"(?<!年)([0-9一二两三四五六七八九十]{1,2})月"
        r"([0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        normalized,
    ):
        month, day = _cn_to_int(match.group(1)), _cn_to_int(match.group(2))
        year = today.year
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if candidate < today:
            candidate = date(year + 1, month, day)
        candidates.append((match.start(), candidate))

    relative_days = {"今天": 0, "今日": 0, "明天": 1, "后天": 2, "大后天": 3}
    for match in re.finditer(r"大后天|后天|明天|今天|今日", normalized):
        candidates.append((match.start(), today + timedelta(days=relative_days[match.group(0)])))

    for match in re.finditer(r"下月底|下月末|月底|月末", normalized):
        year, month = today.year, today.month
        if match.group(0).startswith("下"):
            year += int(month == 12)
            month = 1 if month == 12 else month + 1
        candidates.append((match.start(), date(year, month, calendar.monthrange(year, month)[1])))

    for match in WEEKDAY_RE.finditer(normalized):
        prefix = match.group(1) or ""
        target = WEEKDAY_INDEX[match.group(2)]
        monday = today - timedelta(days=today.weekday())
        if prefix == "下下":
            candidate = monday + timedelta(days=14 + target)
        elif prefix == "下":
            candidate = monday + timedelta(days=7 + target)
        elif prefix in {"本", "这"}:
            candidate = monday + timedelta(days=target)
        else:
            delta = target - today.weekday()
            candidate = today + timedelta(days=delta if delta > 0 else delta + 7)
        candidates.append((match.start(), candidate))

    for match in re.finditer(r"(?<![月0-9])([0-9一二两三四五六七八九十]{1,3})(?:号|日)", normalized):
        day = _cn_to_int(match.group(1))
        year, month = today.year, today.month
        if not 1 <= day <= calendar.monthrange(year, month)[1]:
            continue
        candidate = date(year, month, day)
        if candidate < today:
            year += int(month == 12)
            month = 1 if month == 12 else month + 1
            candidate = date(year, month, min(day, calendar.monthrange(year, month)[1]))
        candidates.append((match.start(), candidate))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    chosen = candidates[-1] if _contains_correction(normalized) else candidates[0]
    return chosen[1].isoformat()


def ambiguous_requires_clarification(text: str) -> bool:
    """Only missing dates block saving; a missing clock is an all-day event."""
    if MISSING_DATE_INTENT_RE.search(text):
        return True
    return DATE_SIGNAL_RE.search(text) is None


def clarification_is_supported(text: str, parsed: dict[str, Any]) -> bool:
    if DATE_SIGNAL_RE.search(text) is None:
        return True
    if MISSING_DATE_INTENT_RE.search(text) or LOCATION_UNCERTAINTY_RE.search(text):
        return True
    if VAGUE_NEXT_MONTH_RE.search(text):
        return True
    question = str(parsed.get("clarification_question") or "")
    if "跨年长日程" in question:
        return True
    if DATE_RANGE_SIGNAL_RE.search(text) and re.search(r"先后顺序|日期范围|起止日期", question):
        return True
    date_tokens = AUDIT_DATE_TOKEN_RE.findall(text)
    if len(date_tokens) >= 2 and DATE_RANGE_SIGNAL_RE.search(text) and not parsed.get("end_date"):
        return True
    return False


def same_day_range(text: str) -> bool:
    tokens = AUDIT_DATE_TOKEN_RE.findall(text)
    if len(tokens) < 2 or not DATE_RANGE_SIGNAL_RE.search(text):
        return False

    def canonical(token: str) -> str:
        return token.replace("日", "号").replace("今日", "今天")

    return canonical(tokens[0]) == canonical(tokens[1])


def issue_flags(
    sample: dict[str, str],
    parsed: dict[str, Any] | None,
    error: str | None,
    duration_ms: int,
) -> tuple[list[str], list[str]]:
    flags: list[str] = []
    review: list[str] = []
    text = sample["text"]
    group = sample["group"]
    hint = sample["category_hint"]

    if error:
        if group == "negative_or_control" and error.startswith("HTTP 422:"):
            return flags, review
        flags.append("parse_error")
        return flags, review
    if parsed is None:
        flags.append("parse_null")
        return flags, review

    source = parsed.get("parse_source")
    needs_clarification = bool(parsed.get("needs_clarification"))
    clarification_question = str(parsed.get("clarification_question") or "").strip()
    category = parsed.get("category")
    event_type = parsed.get("event_type")
    reminder_minutes = parsed.get("reminder_minutes")
    start_time = parsed.get("start_time")
    end_time = parsed.get("end_time")
    is_all_day = bool(parsed.get("is_all_day"))

    expected_category = CATEGORY_HINTS.get(hint)
    if expected_category and category != expected_category:
        review.append("category_hint_mismatch")

    if group == "negative_or_control":
        flags.append("negative_false_positive")

    if group == "ambiguous":
        clarification_required = ambiguous_requires_clarification(text)
        if clarification_required and not needs_clarification:
            flags.append("missing_date_without_clarification")
        elif not clarification_required and needs_clarification:
            flags.append("optional_time_forced_clarification")

    if group == "date_range" and not parsed.get("end_date") and not same_day_range(text):
        if needs_clarification:
            review.append("date_range_needs_review")
        else:
            flags.append("date_range_missing_without_clarification")

    if group == "recurring" and event_type == "once":
        flags.append("recurring_as_once")
    if group != "recurring" and event_type != "once":
        flags.append("non_recurring_as_recurrence")

    if start_time and not (TIME_RE.search(text) or RELATIVE_TIME_RE.search(text)):
        flags.append("unexpected_time_without_clock")
    if TIME_RE.search(text) and not start_time:
        flags.append("explicit_time_missing")

    safe_missing_date_rule = (
        group == "ambiguous"
        and needs_clarification
        and ambiguous_requires_clarification(text)
    )
    if COMPLEX_SIGNAL_RE.search(text) and source == "rules" and not safe_missing_date_rule:
        flags.append("complex_swallowed_by_rules")

    title = str(parsed.get("title") or "").strip()
    if not title or not parsed.get("start_date"):
        flags.append("missing_core_field")
    if TITLE_LEAK_RE.search(title):
        flags.append("title_instruction_leak")
    if TITLE_TEMPORAL_LEAK_RE.search(title):
        flags.append("title_temporal_leak")
    if TITLE_META_LEAK_RE.search(title):
        flags.append("title_meta_leak")
    if len(title) > 20:
        review.append("title_over_20_chars")
    if category not in CATEGORY_VALUES:
        flags.append("invalid_category")
    if (is_all_day and start_time) or (not is_all_day and not start_time):
        flags.append("all_day_time_inconsistent")
    if start_time and end_time == start_time:
        flags.append("zero_duration_timed_event")
    start_date = str(parsed.get("start_date") or "")
    end_date = str(parsed.get("end_date") or "")
    expected_date = expected_single_date(text)
    if event_type == "once" and group != "date_range" and expected_date and start_date != expected_date:
        flags.append("single_date_mismatch")
    if end_date and start_date and end_date <= start_date:
        flags.append("invalid_date_range")

    if needs_clarification and not clarification_is_supported(text, parsed):
        if "optional_time_forced_clarification" not in flags:
            flags.append("unsupported_clarification")
    if not needs_clarification and clarification_question:
        flags.append("clarification_state_inconsistent")

    location = str(parsed.get("location") or "").strip()
    if location and LOCATION_PLACEHOLDER_RE.fullmatch(location):
        flags.append("placeholder_location")

    expected_reminder = reminder_expected(text) if start_time else None
    if expected_reminder == "none" and reminder_minutes is not None:
        flags.append("no_reminder_not_respected")
    elif isinstance(expected_reminder, int) and reminder_minutes != expected_reminder:
        flags.append("reminder_mismatch")

    if duration_ms >= 3000:
        review.append("slow_call")

    return flags, review


def run_one(sample: dict[str, str], endpoint: str, timeout: float) -> dict[str, Any]:
    started = time.perf_counter()
    parsed, error = post_parse(endpoint, sample["text"], timeout)
    duration_ms = round((time.perf_counter() - started) * 1000)
    core = {field: parsed.get(field) for field in CORE_FIELDS if parsed is not None}
    flags, review_flags = issue_flags(sample, parsed, error, duration_ms)
    return {
        **sample,
        "duration_ms": duration_ms,
        "parse_source": parsed.get("parse_source") if parsed else None,
        "issues": flags,
        "review_flags": review_flags,
        "error": error,
        "parsed": core,
    }


def write_markdown(report: dict[str, Any], output: Path) -> None:
    rows = report["rows"]
    issue_counts = Counter(issue for row in rows for issue in row["issues"])
    review_counts = Counter(issue for row in rows for issue in row["review_flags"])
    lines = [
        "# LaoJi Schedule Review Diagnostics v2",
        "",
        f"- Input: `{report['input']}`",
        f"- Endpoint: `{report['endpoint']}`",
        f"- Total: {report['total']}",
        f"- Rows with issues: {report['rows_with_issues']}",
        f"- Rows needing review: {report['rows_with_review_flags']}",
        f"- Elapsed: {report['elapsed_ms']} ms",
        f"- Parse sources: `{report['parse_source_counts']}`",
        f"- Duration ms: `{report['duration_ms']}`",
        f"- Gate passed: `{report['gate_passed']}`",
        f"- Gate issues: `{report['gate_issues']}`",
        "",
        "## Issue Counts",
    ]
    for key, value in issue_counts.most_common():
        lines.append(f"- {key}: {value}")

    lines.extend(["", "## Review Flag Counts"])
    for key, value in review_counts.most_common():
        lines.append(f"- {key}: {value}")

    lines.extend(["", "## Group Issue Rates"])
    for group, stats in sorted(report["group_counts"].items()):
        rate = stats["issues"] / stats["total"] if stats["total"] else 0
        lines.append(f"- {group}: {stats['issues']}/{stats['total']} ({rate:.1%})")

    lines.extend(["", "## First 80 Issue Rows"])
    for row in [row for row in rows if row["issues"]][:80]:
        lines.extend(
            [
                f"### {row['id']} {row['group']}",
                f"- text: {row['text']}",
                f"- issues: `{row['issues']}`",
                f"- review: `{row['review_flags']}`",
                f"- source: `{row['parse_source']}`, duration: `{row['duration_ms']} ms`",
                f"- parsed: `{json.dumps(row['parsed'], ensure_ascii=False)}`",
            ]
        )
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--endpoint", default="http://127.0.0.1:18035/api/laoji/parse")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--samples-per-group", type=int)
    parser.add_argument("--sample-seed", type=int, default=20260712)
    parser.add_argument("--sample-id", action="append", default=[])
    parser.add_argument("--progress-every", type=int, default=25)
    parser.add_argument("--run-label", default="")
    parser.add_argument("--max-rows-with-issues", type=int)
    parser.add_argument("--max-case-ms", type=float)
    parser.add_argument("--max-p95-ms", type=float)
    parser.add_argument("--max-elapsed-ms", type=float)
    parser.add_argument("--require-parse-source", action="append", default=[])
    args = parser.parse_args()

    if args.max_rows_with_issues is not None and args.max_rows_with_issues < 0:
        parser.error("--max-rows-with-issues must be non-negative")
    for name in ["max_case_ms", "max_p95_ms", "max_elapsed_ms"]:
        value = getattr(args, name)
        if value is not None and value <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")

    samples = stratified_sample(load_samples(args.input), args.samples_per_group, args.sample_seed)
    samples = select_sample_ids(samples, args.sample_id)
    started = time.perf_counter()
    rows: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(run_one, sample, args.endpoint, args.timeout) for sample in samples]
        for future in concurrent.futures.as_completed(futures):
            rows.append(future.result())
            if args.progress_every > 0 and (
                len(rows) % args.progress_every == 0 or len(rows) == len(samples)
            ):
                print(f"[{len(rows)}/{len(samples)}] completed", flush=True)
    rows.sort(key=lambda item: item["id"])
    elapsed_ms = round((time.perf_counter() - started) * 1000)

    durations = [row["duration_ms"] for row in rows]
    group_counts: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "issues": 0})
    for row in rows:
        group_counts[row["group"]]["total"] += 1
        if row["issues"]:
            group_counts[row["group"]]["issues"] += 1

    route_durations: dict[str, list[int]] = defaultdict(list)
    for row in rows:
        route_durations[str(row["parse_source"])].append(row["duration_ms"])

    report = {
        "run_label": args.run_label,
        "input": str(args.input),
        "endpoint": args.endpoint,
        "workers": args.workers,
        "samples_per_group": args.samples_per_group,
        "sample_seed": args.sample_seed,
        "total": len(rows),
        "rows_with_issues": sum(1 for row in rows if row["issues"]),
        "rows_with_review_flags": sum(1 for row in rows if row["review_flags"]),
        "elapsed_ms": elapsed_ms,
        "parse_source_counts": dict(Counter(str(row["parse_source"]) for row in rows)),
        "issue_counts": dict(Counter(issue for row in rows for issue in row["issues"])),
        "review_flag_counts": dict(Counter(issue for row in rows for issue in row["review_flags"])),
        "group_counts": dict(group_counts),
        "duration_ms": duration_summary(durations),
        "duration_by_parse_source_ms": {
            source: duration_summary(values)
            for source, values in sorted(route_durations.items())
        },
        "rows": rows,
    }
    report["budgets"] = {
        "max_rows_with_issues": args.max_rows_with_issues,
        "max_case_ms": args.max_case_ms,
        "max_p95_ms": args.max_p95_ms,
        "max_elapsed_ms": args.max_elapsed_ms,
        "required_parse_sources": sorted(set(args.require_parse_source)),
    }
    report["gate_issues"] = schedule_gate_issues(
        report,
        max_rows_with_issues=args.max_rows_with_issues,
        max_case_ms=args.max_case_ms,
        max_p95_ms=args.max_p95_ms,
        max_elapsed_ms=args.max_elapsed_ms,
        required_parse_sources=set(args.require_parse_source),
    )
    report["gate_passed"] = not report["gate_issues"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(report, args.output.with_suffix(".md"))
    print(json.dumps({k: report[k] for k in ["total", "rows_with_issues", "rows_with_review_flags", "elapsed_ms", "parse_source_counts", "issue_counts", "review_flag_counts", "duration_ms", "gate_passed", "gate_issues"]}, ensure_ascii=False, indent=2))
    return 0 if report["gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
