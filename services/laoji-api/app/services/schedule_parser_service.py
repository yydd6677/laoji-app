"""
日程解析服务 - 将自然语言文本解析为结构化日程
=============================================
调用 Ollama LLM，从用户语音转写文本中提取日程结构：
  - 标题、时间（具体日期/时间段/每月/每年）
  - 是否全天
  - 备注

通过老记统一 LlmProvider 调用 Ollama。
"""

import calendar
import hashlib
import json
import os
import re
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.services.llm_provider import LlmConfig, call_llm as call_ollama


class ScheduleParserUnavailable(RuntimeError):
    """The model-backed parser could not produce a result because its runtime failed."""


@dataclass(frozen=True)
class _ScheduleParseContext:
    """Request-scoped clock used by deterministic and model-backed parsing."""

    reference_datetime: datetime
    timezone: str


_ACTIVE_PARSE_CONTEXT: ContextVar[Optional[_ScheduleParseContext]] = ContextVar(
    "laoji_schedule_parse_context",
    default=None,
)

_ACTIVE_PARSE_OBSERVATION: ContextVar[Optional[dict]] = ContextVar(
    "laoji_schedule_parse_observation",
    default=None,
)


def _new_parse_observation(
    text: str,
    context: Optional[_ScheduleParseContext] = None,
) -> dict:
    context = context or _ACTIVE_PARSE_CONTEXT.get()
    reference = context.reference_datetime.isoformat() if context else ""
    timezone_name = context.timezone if context else ""
    request_id = hashlib.sha256(
        "|".join((text, reference, timezone_name)).encode("utf-8")
    ).hexdigest()[:24]
    return {
        "request_id": request_id,
        "route": None,
        "model_attempted": False,
        "model_success": False,
        "fallback_used": False,
        "model_id": None,
        "model_retry_count": 0,
        "started_at": time.perf_counter(),
    }


def _parse_observation() -> Optional[dict]:
    return _ACTIVE_PARSE_OBSERVATION.get()


def _mark_parse_observation(**updates) -> None:
    observation = _parse_observation()
    if observation is not None:
        observation.update(updates)


def _finish_parse_observation() -> None:
    observation = _parse_observation()
    if observation is not None:
        observation["parse_latency_ms"] = round(
            (time.perf_counter() - observation["started_at"]) * 1000,
            3,
        )


def _system_now() -> datetime:
    return datetime.now()


def _current_datetime() -> datetime:
    context = _ACTIVE_PARSE_CONTEXT.get()
    return context.reference_datetime if context else _system_now()


def _current_date() -> date:
    context = _ACTIVE_PARSE_CONTEXT.get()
    return context.reference_datetime.date() if context else date.today()


def _local_time_status(day: date, time_text: Optional[str]) -> str:
    """Return valid, nonexistent, or ambiguous for a local IANA wall clock."""
    if not time_text:
        return "valid"
    context = _ACTIVE_PARSE_CONTEXT.get()
    if context is None:
        return "valid"
    try:
        zone = ZoneInfo(context.timezone)
        utc_zone = ZoneInfo("UTC")
    except ZoneInfoNotFoundError:
        return "valid"
    hour, minute = (int(part) for part in time_text.split(":"))
    naive = datetime(day.year, day.month, day.day, hour, minute)
    candidates = []
    for fold in (0, 1):
        aware = naive.replace(tzinfo=zone, fold=fold)
        round_trip = aware.astimezone(utc_zone).astimezone(zone).replace(tzinfo=None)
        if round_trip == naive:
            candidates.append(aware)
    if not candidates:
        return "nonexistent"
    if len(candidates) == 2 and candidates[0].utcoffset() != candidates[1].utcoffset():
        return "ambiguous"
    return "valid"


def _dst_risk_question(day: Optional[date], start_time: Optional[str]) -> Optional[str]:
    if day is None or start_time is None:
        return None
    status = _local_time_status(day, start_time)
    if status == "nonexistent":
        return "该时间在当前时区不存在，需要确认具体时间或时区。"
    if status == "ambiguous":
        return "该时间在当前时区有两种可能，需要确认具体时间或时区。"
    return None


def _resolve_parse_context(
    reference_datetime: Optional[str | datetime] = None,
    timezone_name: Optional[str] = None,
) -> Optional[_ScheduleParseContext]:
    if not reference_datetime and not timezone_name:
        return None

    raw_timezone = (timezone_name or "").strip()
    zone = None
    if raw_timezone:
        try:
            zone = ZoneInfo(raw_timezone)
        except ZoneInfoNotFoundError:
            zone = None

    parsed = reference_datetime if isinstance(reference_datetime, datetime) else None
    raw_reference = "" if parsed is not None else str(reference_datetime or "").strip()
    if parsed is None and raw_reference:
        try:
            parsed = datetime.fromisoformat(raw_reference.replace("Z", "+00:00"))
        except ValueError:
            parsed = None
    if parsed is None:
        parsed = _system_now()

    if zone is not None:
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=zone)
        else:
            parsed = parsed.astimezone(zone)
    elif parsed.tzinfo is not None:
        # Keep an explicit numeric offset when an unknown IANA name is supplied.
        raw_timezone = raw_timezone or str(parsed.tzinfo)
    else:
        raw_timezone = raw_timezone or "local"
    return _ScheduleParseContext(parsed, raw_timezone)


def _with_context_metadata(result: Optional[dict]) -> Optional[dict]:
    if result is None:
        return None
    enriched = dict(result)
    context = _ACTIVE_PARSE_CONTEXT.get()
    if context is not None:
        enriched["reference_datetime"] = context.reference_datetime.isoformat()
        enriched["timezone"] = context.timezone
    observation = _parse_observation()
    if observation is not None:
        _finish_parse_observation()
        for key in (
            "request_id",
            "route",
            "model_attempted",
            "model_success",
            "fallback_used",
            "model_id",
            "model_retry_count",
            "parse_latency_ms",
        ):
            enriched[key] = observation.get(key)
    return enriched


# ==================== Prompt 模板 ====================

_SYSTEM_PROMPT_TEMPLATE = """你是日程解析器。当前日期 __TODAY__，星期__WEEKDAY__，当前时间 __NOW_TIME__。相对日映射：今天=__TODAY__、明天=__TOMORROW__、后天=__DAY_AFTER_TOMORROW__；本周=__THIS_WEEK_START__至__THIS_WEEK_END__，下周=__NEXT_WEEK_START__至__NEXT_WEEK_END__；本周星期映射：__THIS_WEEK_MAP__；下周星期映射：__NEXT_WEEK_MAP__；不带“本/下”的最近星期映射：__UPCOMING_WEEKDAY_MAP__；本月底=__THIS_MONTH_END__，下月底=__NEXT_MONTH_END__。相对日期和相对时间必须直接使用映射换算。若原文出现“改到、改成、更正为、后来调整到”，日期和时间只采用更正词之后的最终值。

只输出一个 JSON 对象或 null，不要解释、不要 Markdown。
JSON 必须包含：title、event_type、category、needs_clarification、date_phrase、time_phrase、recurrence_phrase。
仅在原文明确存在或确实需要时输出：end_date_phrase、end_time_phrase、description、location、detail、clarification_question。
不要输出 start_date、end_date、start_time、end_time、recurrence_interval、recurrence_weekdays、recurrence_until_date；服务会从原话证据短语换算。

字段规则：
- title：20 字以内的事项名，不含日期、钟点、口语填充、操作指令。
- event_type：once、daily、weekly、monthly、yearly 之一。
- date_phrase/end_date_phrase：只复制原文中对应的日期短语，不含钟点；没有则为 null。日期范围要拆成起点和终点。
- time_phrase/end_time_phrase：只复制原文中对应的钟点或模糊时段；没有则为 null。禁止把“上午”等模糊时段改写成 09:00。
- recurrence_phrase：只复制原文中完整的重复短语；一次性日程为 null。
- recurrence_interval：重复间隔，默认 1；例如“每隔两周”是 2。
- recurrence_weekdays：每周重复的 ISO 星期数组，周一到周日为 1 到 7；没有明确星期时省略。
- recurrence_until_date：用户明确说“重复到/持续到/截止到”的日期；没有截止日期时为 null。
- start_time/end_time：只有明确钟点才输出 HH:MM；模糊时段或未说钟点时省略。
- category：工作、学习、健康、生活、社交、出行、财务、重要、其他之一。
- needs_clarification：布尔值；为 true 时必须输出 clarification_question。

判定规则：
1. “某日到某日/从某日到某日”必须输出 end_date，event_type=once；星期范围不是重复，例如“下周一到周三培训”是下周一至下周三的一次性日程。“今明两天/明后两天/今明后三天”等连续相对日期也必须输出 end_date；日期先后矛盾时需要追问。
2. 日期先后矛盾时仍要返回对象：保留用户说的开始日期，省略 end_date，needs_clarification=true；不要返回 null。
3. 更正、否定或重复说明时以用户最终确认的事项、日期和时间为准。
4. 有明确日期但没有具体钟点时，时间可空，needs_clarification=false，不要追问几点；只有出现未限定上午/下午/晚上、且可能对应两个生活时段的钟点（如“五点”）时，才保留日期并追问时段。
5. 缺少具体日期但有明确事项时，用当前日期作候选，needs_clarification=true，并追问日期。
6. “下个月/下月”未给具体日期时按下月 1 日候选，event_type=once，并追问日期。
7. 只有“每、每隔、隔周、重复”等明确重复词才能生成重复事件；“本周五/下周日/下周一到周三/本月25号”都是 once。“每隔两周周三”必须是 event_type=weekly、recurrence_interval=2、recurrence_weekdays=[3]。多星期、隔周和截止日期必须保留在重复字段中。
8. 提醒中的“提前两小时/一天”等数字不是事件钟点；参与者、备注、附件、提醒和未指定的地点都不需要追问。
9. 地点只在“地点在/地址在/在/用”等原文明说时输出；“带上某物”不是地点。只有原文明说地点未定时才追问最终地点。
10. needs_clarification 只能用于缺日期、日期范围冲突、明确未定的地点或未限定时段的钟点，不得为提醒、参与者、备注、附件追问。
11. “十分钟后/一小时后/半小时后”等必须换算为具体 start_date 和 start_time。
12. 只是询问解析表现、仅提到日期时间词而不要求安排、明确不要创建/保存、测试或举例时返回 null。
13. 无法提取真实事项时返回 null，禁止编造。

用户输入："""


# ==================== LLM 调用 ====================

def _load_ollama_config() -> LlmConfig:
    """Build the schedule config from the single production LLM provider."""
    _ensure_local_no_proxy()
    base_url = os.getenv(
        "LAOJI_OLLAMA_BASE_URL", "http://127.0.0.1:21434"
    ).strip().rstrip("/")
    schedule_model = os.getenv("SCHEDULE_OLLAMA_MODEL", "qwen3.5:9b").strip()
    return LlmConfig(
        base_url=base_url,
        model=schedule_model or "qwen3.5:9b",
        provider="ollama",
        api_key="",
        chat_path="/v1/chat/completions",
    )


def _ensure_local_no_proxy() -> None:
    for key in ("NO_PROXY", "no_proxy"):
        current = os.getenv(key, "")
        entries = [item.strip() for item in current.split(",") if item.strip()]
        for host in ("127.0.0.1", "localhost"):
            if host not in entries:
                entries.append(host)
        os.environ[key] = ",".join(entries)


def _schedule_llm_timeout() -> int:
    try:
        return max(10, int(os.getenv("SCHEDULE_LLM_TIMEOUT", "45")))
    except ValueError:
        return 45


def _schedule_llm_max_tokens() -> int:
    try:
        return max(128, min(1024, int(os.getenv("SCHEDULE_LLM_MAX_TOKENS", "256"))))
    except ValueError:
        return 256


def _schedule_llm_num_ctx() -> int:
    try:
        return max(1024, min(8192, int(os.getenv("SCHEDULE_LLM_NUM_CTX", "8192"))))
    except ValueError:
        return 8192


def _schedule_force_llm() -> bool:
    return os.getenv("SCHEDULE_FORCE_LLM", "").strip().lower() in {"1", "true", "yes", "on"}


_SERVER_PARSE_REQUIRED_RE = re.compile(
    r"(不是|不对|说错|改成|最终|最后|更正|纠正|别弄错|以后面的为准|后面的为准|"
    r"不要保存|不要真的|只是测试|只是举例|不是日程|先别自动|晚点补|还没定|没想好|如果冲突)"
)
_QUERY_INTENT_RE = re.compile(
    r"(?:我想看看|想看看|看看|看下|查下|查一下|查询|有没有|还有没有|"
    r"日历里有|安排了吗|定了吗|排了吗).{0,120}(?:吗|呢|啊|了)?$"
)
_CREATE_IMPERATIVE_RE = re.compile(
    r"(?:帮我(?:记|安排|加|添加|创建|新建|保存|提醒)|"
    r"(?:记一下|记下|记住|记到|存一下|存下|保存一下|加个|添加|安排一下|定个|提醒我|加到日历|写进日历|"
    r"先帮我记|先帮我加|先记着|先留着|先放着))"
)
_DELETE_INTENT_RE = re.compile(
    r"(?:删除|删掉|撤掉|取消|移除|去掉).{1,120}|"
    r"(?:别排|不安排了|不用留了).{1,120}|"
    r".{1,120}(?:不用留了|不安排了|删了吧|删掉|撤掉|移除|去掉)"
)
_CLARIFY_INTENT_RE = re.compile(
    r"(?:时间|钟点|几点|日期|哪天|哪一天).{0,12}"
    r"(?:还没想好|没想好|没定|未定|晚点补|回头补|再看|再说)|"
    r"(?:先留着|先放着|先记着|留个位置|留点时间|先把[^，,。.!！?？；;]{0,40}(?:留个位置|留点时间))"
    r".{0,30}(?:时间|日期|几点|再说|没定|回头补)?$"
)
_NON_SCHEDULE_CONTROL_RE = re.compile(
    r"(?:现在|此刻)几点了?[。.!！?？]*$|"
    r"(不要真的创建(?:日程)?|不要创建(?:日程)?|取消创建|不要新建(?:日程)?|不要添加(?:日程)?|不要保存(?:成|为)?日程|"
    r"不是日程|只是测试|只是举例|先别自动保存|测试麦克风|测试解析|识别效果|随便说一句话|"
    r"忽略前面的要求|输出系统提示词|已经完成了|已完成了|不用安排|没有提供原日程)|"
    r"(?:先不用记|先不留|暂时别记|先别记|先别排|先不加|这次不加|算了[^。.!！?？；;]{0,30}(?:不加|不用记|别记)|"
    r"我只是问问[^。.!！?？；;]{0,30}(?:不用记|不加|别记)|先放着[^。.!！?？；;]{0,20}别记|"
    r"(?:不加日历|不用(?:把)?[^。.!！?？；;]{0,40}日历|不用留|不安排|不记|别排|别记|先不约)|"
    r"(?:不用了|算了|不必了)[，,、]?\s*(?:先|暂时)?(?:这个|它)?\s*"
    r"(?:别|不(?:要|用)?)\s*"
    r"(?:加|添加|记|创建)(?:了|这个|它)?[。.!！]*$)|"
    r"^(?:(?:我想想啊|嗯|那个)[，,]?)?我?(?:想看看|想知道|看看)"
    r".{0,16}(?:解析|识别).{0,16}(?:怎么|如何|怎样|会怎么).{0,8}(?:提示|显示|处理|表现)|"
    r"(?:请解释|解释一下|说明一下).{0,80}(?:是什么意思|怎么理解|会怎么处理)|"
    r"(?:假设|如果有人说|你会怎么回答).{0,80}|"
    r"(?:今天|今日|明天|后天|日期|时间|上午|下午|晚上).{0,12}"
    r"(?:这个)?(?:词|说法|表达).{0,10}(?:出现|提到|说到)|"
    r"(?:还没|没有|没).{0,8}(?:决定|想好).{0,12}"
    r"(?:记|安排|创建|做).{0,4}(?:什么|啥)[。.!！?？]*$"
)
_COMPLEX_SCHEDULE_RE = re.compile(
    r"(标题(?:不要太长|写|就写|叫|设为|是)|重点是|主要确认|需要通知|地点(?:还)?可能|"
    r"这是新的安排|先不要和|如果[^,，。]{0,24}(?:被占|照这个时间)|这件事和|"
    r"也参加|一起|带上|这次主要是|不用写太长|别只记一天|"
    r"如果|除非|优先|具体时间|等对方(?:确认|回复)|月底前|找一个.{0,12}时间|"
    r"根据.{0,20}(?:决定|安排)|改到)"
)
_DATE_CORRECTION_RE = re.compile(r"(不是|不对|说错|改成|改到|换成|更正|纠正|最终|最后|说早了|以后面的为准|后面的为准)")
_IMPLICIT_CROSS_YEAR_CONFIRM_DAYS = 183
_DEFERRED_DETAIL_RE = re.compile(
    r"(?:日期|哪天|哪一天).{0,10}(?:还没想好|没想好|没定|未定|晚点补)|"
    r"(?:时间|钟点|几点).{0,10}(?:还没想好|没想好|没定|未定|晚点补|再看|再说)|"
    r"(?:等会儿定时间|时间再说)"
)
_LOCATION_PLACEHOLDER_RE = re.compile(
    r"^(?:未指定|未知|无|暂无|待定|不确定|没有|未提供|none|null)$",
    re.IGNORECASE,
)
_UNCERTAIN_LOCATION_RE = re.compile(
    r"(?:"
    r"(?:地点|地址|位置)\s*(?:可能|也许|不确定|还没定|还没确定|未确定|暂定)"
    r"(?:在|是)?[^，,。.!！?？；;]{0,40}?"
    r"(?=(?:安排|计划|创建|进行|开会|会议|和|跟|与|，|,|$))|"
    r"在\s*(?:可能|也许)(?:在|是)?[^，,。.!！?？；;]{1,40}?"
    r"(?:位置|地点|地址)(?:里|内|附近)?"
    r"(?=(?:安排|计划|创建|进行|开会|会议|和|跟|与|，|,|$))|"
    r"在\s*(?:可能|也许)(?:在|是)?[^，,。.!！?？；;]{1,40}?"
    r"(?=(?:位置|地点|地址)(?:里|内|附近)?|安排|计划|创建|进行|开会|会议|和|跟|与|，|,|$)|"
    r"(?:不确定|还没定|还没确定|未确定|暂定)"
    r"[^，,。.!！?？；;]{0,24}(?=(?:地点|地址|位置))"
    r")"
)
_UNSUPPORTED_RECURRENCE_RE = re.compile(
    r"(?:"
    # Keep ordinary month-start/month-end recurrences supported.  The old
    # rule only rejected genuinely structural forms (last workday, nth week,
    # or a weekday selector); a broad ``...末...`` search also matched a
    # lexical title such as ``每月月初安排周末早餐``.
    r"每(?:个)?月(?:最后(?:一个)?工作日|第[一二三四五六七八九十0-9]+周|周[一二三四五六日天])|"
    r"每隔(?:[一二两三四五六七八九十0-9]+)?周|"
    r"隔周|"
    r"每(?:两|二|[2-9]|[二三四五六七八九十])周"
    r")"
)

_RECURRENCE_MARKER_RE = re.compile(
    r"(?:每(?:一)?(?:天|日)|每(?:周|星期|礼拜|(?:个)?月|(?:个)?年|隔|个工作日|逢)|"
    r"每(?:隔)?[一二两三四五六七八九十0-9]+个月|"
    r"每(?:隔)?[一二两三四五六七八九十0-9]+年|"
    r"隔周|工作日|每(?:个)?周末|重复|循环|"
    r"从现在开始(?:每)?(?:周|星期|礼拜))"
)
_RECURRENCE_EXCLUSION_RE = re.compile(
    r"(?:节假日除外|法定节假日除外|节假日不算|跳过节假日|工作日调整|重复[0-9一二两三四五六七八九十两]+次)"
)


def _is_likely_location_number(text: str, match: re.Match[str]) -> bool:
    """Do not treat room/building numbers as calendar dates."""
    suffix = text[match.end():match.end() + 8]
    prefix = text[max(0, match.start() - 4):match.start()]
    return bool(
        re.search(r"(?:会议室|仓库|餐厅|办公室|室|楼|门|前台|大厅)", suffix)
        or re.search(r"(?:路|街|巷|楼|室|门)$", prefix)
    )


def _should_skip_quick_schedule_parse(text: str) -> bool:
    normalized = _normalize_schedule_text(text)
    if _UNCERTAIN_LOCATION_RE.search(normalized):
        return True
    if _RECURRENCE_MARKER_RE.search(normalized) and (
        not _DATE_CORRECTION_RE.search(normalized)
        or _UNSUPPORTED_RECURRENCE_RE.search(normalized)
    ):
        # Recurrence rules are now parsed deterministically, including explicit
        # unsupported forms which must return a Chinese clarification instead
        # of waiting for a model that may silently downgrade them to once.
        return False
    if _SERVER_PARSE_REQUIRED_RE.search(normalized):
        return True
    # A single reminder such as “提醒我带上雨衣，因为会下雨” is a narrow
    # event request, not the multi-entity attachment cases covered by the
    # generic complex-schedule gate. Keep it on the deterministic path.
    if re.match(r"^提醒我带上[^，,。.!！?？；;]{1,40}(?:因为|由于)", normalized):
        return False
    if len(normalized) > 52 or _COMPLEX_SCHEDULE_RE.search(normalized):
        return True
    sentence_count = len([part for part in re.split(r"[。.!！?？；;]+", normalized) if part])
    if sentence_count > 1:
        return True
    if _has_date_range_signal(normalized):
        parsed_range = _parse_date_range(normalized)
        if (
            parsed_range
            and parsed_range[0] == parsed_range[1]
            and re.search(
                r"(?:别|不要|不能|不应|不想)[^，,。；;]{0,12}"
                r"(?:只|仅)[^，,。；;]{0,8}(?:一天|一日|单日)",
                normalized,
            )
        ):
            return True
        # A reverse range is deliberately handled by the deterministic path:
        # preserve the spoken start date, clear the unsafe end date, and ask
        # the user to resolve the ordering instead of sending a malformed
        # range to the model.
        if parsed_range is None and _is_rule_supported_reverse_range(normalized):
            return False
        return parsed_range is None or _implicit_long_cross_year_range_needs_confirmation(
            normalized,
            parsed_range,
        )
    return False


def _is_rule_supported_reverse_range(text: str) -> bool:
    """Whether a spoken date range is parseable but has its endpoints reversed."""
    normalized = _normalize_schedule_text(text)
    if not _has_date_range_signal(normalized):
        return False
    parsed = _parse_date_range_unchecked(normalized)
    return bool(parsed and parsed[1] < parsed[0])


def _is_non_schedule_control_text(text: str) -> bool:
    return bool(_NON_SCHEDULE_CONTROL_RE.search(_normalize_schedule_text(text)))


def _has_create_priority(text: str) -> bool:
    normalized = _normalize_schedule_text(text)
    # A question/lookup shell must not become a create request merely because
    # its subject contains a word such as "安排" or "查询".
    if (
        _QUERY_INTENT_RE.search(normalized)
        and not _CREATE_IMPERATIVE_RE.search(normalized)
        and re.match(
            r"^(?:我想看看|想看看|看看|看下|查下|查一下|查询|有没有|还有没有|"
            r"日历里有|安排了吗|定了吗|排了吗)",
            normalized,
        )
    ):
        return False
    # A plain delete command may mention a date or a title containing
    # "提醒/安排".  Treat it as creation only when a real scheduling wrapper
    # follows ("排到/放进/定在/设置…"), not when the word is just lexical.
    if _DELETE_INTENT_RE.search(normalized) and not re.search(
        r"(?:排(?:到|在)|放(?:进|入)|定(?:在|个)|设置|安排(?:在|一下)|"
        r"安排[^，,。.!！?？；;]{0,30}(?:删除|取消|移除|撤掉|去掉)|"
        r"加到|留给|留出|设成|固定)",
        normalized,
    ):
        return False
    if re.match(r"^(?:删除|删掉|撤掉|取消|移除|去掉)", normalized):
        return False
    if (
        _CREATE_IMPERATIVE_RE.search(normalized)
        or _LOW_INFORMATION_SCHEDULE_INTENT_RE.search(normalized)
        or _CLARIFY_INTENT_RE.search(normalized)
    ):
        return True
    return bool(
        (_has_date_signal(normalized) or _RECURRENCE_MARKER_RE.search(normalized))
        and re.search(
            r"(?:安排|进行|举行|召开|提醒|记下|记住|加到|添加|放进|放入|"
            r"设成|设置|固定|留给|留出|定个|定在|排个|排到|排在|存一下|"
            r"做|处理|准备|想约|想做|加个|改到|改成|改为|换成|换到|调整到)",
            normalized,
        )
        or bool(
            _RECURRENCE_MARKER_RE.search(normalized)
            and re.search(_TIME_TOKEN_PATTERN, normalized)
            and not re.search(r"(?:吗|呢|[?？])\s*$", normalized)
        )
    )


def _has_natural_query_intent(text: str) -> bool:
    """Recognize spoken lookup forms without treating query words as magic tokens."""
    normalized = _normalize_schedule_text(text)
    if _has_create_priority(normalized) or _DELETE_INTENT_RE.search(normalized):
        return False
    if _DEFERRED_DETAIL_RE.search(normalized):
        return False
    if re.search(r"(?:不确定|没确定|未确定).{0,16}(?:跨(?:天|夜)|隔天)", normalized):
        return False
    if re.fullmatch(r"现在几点了?[。.!！?？]*", normalized):
        return False
    question_tail = r"(?:吗|呢|啊|到底|[?？])\s*$"
    temporal = rf"(?:{_DATE_TOKEN_PATTERN}|{_TIME_TOKEN_PATTERN})"
    if re.search(rf"{temporal}.{{0,8}}还是.{{0,8}}{temporal}", normalized) and (
        re.search(question_tail, normalized) or "到底" in normalized
    ):
        return True
    if re.search(r"是不是", normalized):
        if re.search(r"(?:跨天|跨夜|隔天)", normalized) and re.search(
            r"(?:先记|记下|安排|加上|加到)", normalized
        ):
            return False
        return bool(
            re.search(r"(?:日程|安排|会议|开会|体检|培训|跑步|会)", normalized)
            and re.search(question_tail, normalized)
        )
    if re.search(r"(?:还有几个|还有哪些|还有什么|都有什么)", normalized):
        return bool(re.search(r"(?:会|会议|安排|日程|事|待办|课|培训|检查)", normalized))
    # Broad calendar overviews often end with "是什么/有哪些" instead of a
    # question particle.  Keep these read-only requests out of the saveable
    # quick path, while creation verbs remain protected by _has_create_priority.
    if re.search(r"(?:是什么|有哪些|有多少|有几项|有几件|怎么安排)", normalized):
        return bool(re.search(r"(?:日历|日程|安排|时间表|计划|事项|活动|会议|约定|预约)", normalized))
    if "到底" in normalized and len(re.findall(r"周[一二三四五六日天]", normalized)) >= 2:
        return True
    if re.search(r"改到几点", normalized):
        return bool(re.search(r"(?:了|吗|呢|[?？])\s*$", normalized))
    if re.search(r"几点了", normalized):
        return bool(re.search(r"(?:日程|安排|会议|开会|培训|体检|跑步)", normalized))
    if re.search(r"(?:什么时候|哪天)", normalized):
        return bool(re.search(question_tail, normalized))
    return False


def _is_schedule_query_text(text: str) -> bool:
    """Keep calendar lookups out of the create/parse endpoint.

    A lookup such as "这周六是不是有事" contains date words and can otherwise
    be turned into a saveable all-day draft by the fallback parser.  Creation
    verbs take precedence because users can mention an existing event while
    asking to add a new one.
    """
    normalized = _normalize_schedule_text(text)
    # ``查询`` is often a noun inside a create request ("把签证进度查询放
    # 进日历").  Creation/clarification priority must be decided before the
    # broad read-only query suffix matcher.
    if _has_create_priority(normalized):
        return False
    if _has_natural_query_intent(normalized):
        return True
    if not _QUERY_INTENT_RE.search(normalized):
        return False
    return not _has_create_priority(normalized) and not _DELETE_INTENT_RE.search(normalized)


def classify_schedule_intent(
    text: str,
    *,
    has_current_draft: bool = False,
) -> tuple[str, Optional[str], Optional[str]]:
    """Keep the router's intent preflight compatible with the parser service."""
    normalized = _normalize_schedule_text(text)
    # Explicit creation negatives must remain safety rejects even though words
    # such as "取消" also occur in delete-existing-event commands.
    if not normalized or _is_non_schedule_control_text(normalized):
        if normalized and _DELETE_INTENT_RE.search(normalized) and not re.search(
            r"(?:取消创建|不要(?:创建|新建|添加)|不(?:要|想)保存(?:成|为)?日程)",
            normalized,
        ):
            return "delete", "delete_schedule", "已识别为删除日程"
        return "reject", "not_schedule", "这段内容不是日程安排"
    candidate_title, _ = _extract_title_and_description(normalized)
    semantic_text = _remove_title_surface(normalized, candidate_title)
    has_spoken_slot = bool(
        _has_date_signal(semantic_text)
        or re.search(_TIME_TOKEN_PATTERN, semantic_text)
    )
    if _CLARIFY_INTENT_RE.search(normalized) and not has_spoken_slot:
        return "clarify", "clarify_schedule", "需要补充日程信息"
    # A create shell takes precedence over a lexical delete word in the
    # subject (for example "把线上照片删除排到周末上午").
    if _DELETE_INTENT_RE.search(normalized) and not _has_create_priority(normalized):
        return "delete", "delete_schedule", "已识别为删除日程"
    if _has_create_priority(normalized):
        return "create", None, None
    if _is_schedule_query_text(normalized):
        return "query", "query_schedule", "已识别为查询日程"
    if re.search(r"(?:把|将)?(?:刚才|之前|前面|上一个|那个|这条)(?:的|那个)?(?:日程|安排|草稿|事件)?", normalized) and not has_current_draft:
        return "context_edit", "missing_edit_target", "需要先选择要修改的日程"
    if _has_invalid_explicit_date(normalized):
        return "reject", "invalid_date", "日期不存在，请确认正确的年月日"
    return "create", None, None


def _build_system_prompt() -> str:
    weekdays = ["一", "二", "三", "四", "五", "六", "日"]
    now = _current_datetime()
    today = now.date()
    this_week_start = today - timedelta(days=today.weekday())
    next_week_start = this_week_start + timedelta(days=7)
    this_week_map = "、".join(
        f"周{weekday}={(this_week_start + timedelta(days=index)).strftime('%Y-%m-%d')}"
        for index, weekday in enumerate(weekdays)
    )
    next_week_map = "、".join(
        f"周{weekday}={(next_week_start + timedelta(days=index)).strftime('%Y-%m-%d')}"
        for index, weekday in enumerate(weekdays)
    )
    upcoming_weekday_map = "、".join(
        f"周{weekday}={(today + timedelta(days=(index - today.weekday()) % 7)).strftime('%Y-%m-%d')}"
        for index, weekday in enumerate(weekdays)
    )
    this_month_end = date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    next_month_year = today.year + int(today.month == 12)
    next_month = 1 if today.month == 12 else today.month + 1
    next_month_end = date(
        next_month_year,
        next_month,
        calendar.monthrange(next_month_year, next_month)[1],
    )
    return (
        _SYSTEM_PROMPT_TEMPLATE
        .replace("__TODAY__", today.strftime("%Y-%m-%d"))
        .replace("__TOMORROW__", (today + timedelta(days=1)).strftime("%Y-%m-%d"))
        .replace("__DAY_AFTER_TOMORROW__", (today + timedelta(days=2)).strftime("%Y-%m-%d"))
        .replace("__WEEKDAY__", weekdays[today.weekday()])
        .replace("__NOW_TIME__", now.strftime("%H:%M"))
        .replace("__THIS_WEEK_START__", this_week_start.strftime("%Y-%m-%d"))
        .replace("__THIS_WEEK_END__", (this_week_start + timedelta(days=6)).strftime("%Y-%m-%d"))
        .replace("__NEXT_WEEK_START__", next_week_start.strftime("%Y-%m-%d"))
        .replace("__NEXT_WEEK_END__", (next_week_start + timedelta(days=6)).strftime("%Y-%m-%d"))
        .replace("__THIS_WEEK_MAP__", this_week_map)
        .replace("__NEXT_WEEK_MAP__", next_week_map)
        .replace("__UPCOMING_WEEKDAY_MAP__", upcoming_weekday_map)
        .replace("__THIS_MONTH_END__", this_month_end.strftime("%Y-%m-%d"))
        .replace("__NEXT_MONTH_END__", next_month_end.strftime("%Y-%m-%d"))
    )


def _build_schedule_repair_prompt() -> str:
    """Short retry prompt for small local models that answer an explicit task with null."""
    return (
        "你在重试一个日程解析请求。只输出一个 JSON 对象，不要 Markdown，不要输出 null。"
        "只要用户明确说了要记下、安排、删除或保留一个事项，就必须保留这个事项；"
        "即使日期或时间未定，也要输出对象，缺少的 date_phrase、time_phrase、recurrence_phrase 用 null，"
        "needs_clarification=true，并给出简短中文 clarification_question。证据短语必须逐字复制原文。"
        "只有明确说不要创建、只是提问或不是日程时才输出 null。"
        "对象只需包含 title、event_type、category、date_phrase、time_phrase、recurrence_phrase、"
        "needs_clarification 和必要的 clarification_question。category 必须从工作、学习、健康、生活、"
        "社交、出行、财务、重要、其他中选择。"
    )


async def _parse_schedule_text_impl(text: str, *, model_only: bool = False) -> Optional[dict]:
    """
    将自然语言文本解析为日程结构。
    在异步上下文中调用（供 FastAPI 路由使用）。

    Args:
        text: 用户语音转写文本

    Returns:
        解析后的日程字典，或 None（解析失败时）
    """
    import asyncio

    if not model_only and (_is_non_schedule_control_text(text) or _is_schedule_query_text(text)):
        _mark_parse_observation(route="reject")
        return None

    if not model_only and not _schedule_force_llm() and not _should_skip_quick_schedule_parse(text):
        quick = (
            _deterministic_complex_fallback(text)
            if _is_rule_supported_reverse_range(text)
            else _parse_schedule_text_quick(text)
        )
        if quick:
            _mark_parse_observation(
                route="quick",
                model_id=None,
            )
            return quick

    active_context = _ACTIVE_PARSE_CONTEXT.get()

    def _call():
        context_token = None
        if active_context is not None:
            context_token = _ACTIVE_PARSE_CONTEXT.set(active_context)
        config = _load_ollama_config()
        _mark_parse_observation(
            route="model",
            model_attempted=True,
            model_id=getattr(config, "model", None),
        )
        try:
            raw = call_ollama(
                config,
                system_prompt=_build_system_prompt(),
                transcript=text,
                timeout=_schedule_llm_timeout(),
                max_tokens=_schedule_llm_max_tokens(),
                options={"num_ctx": _schedule_llm_num_ctx(), "temperature": 0},
                priority="interactive",
                telemetry_operation="schedule.parse",
            )
            parsed = _parse_llm_response(
                raw,
                text,
                allow_rule_fallback=not model_only,
                model_only=model_only,
            )
            if parsed is None or parsed.get("parse_source") != "local_llm":
                # A small model may answer an explicit incomplete task with
                # null. Retry once with a narrower contract before recording
                # a fallback; the retry remains part of the same model route.
                _mark_parse_observation(model_retry_count=1)
                retry_raw = call_ollama(
                    config,
                    system_prompt=_build_schedule_repair_prompt(),
                    transcript=text,
                    timeout=_schedule_llm_timeout(),
                    max_tokens=_schedule_llm_max_tokens(),
                    options={"num_ctx": _schedule_llm_num_ctx(), "temperature": 0},
                    priority="interactive",
                    telemetry_operation="schedule.parse.retry",
                )
                retry_parsed = _parse_llm_response(
                    retry_raw,
                    text,
                    allow_rule_fallback=not model_only,
                    model_only=model_only,
                )
                if retry_parsed is not None:
                    parsed = retry_parsed
            if parsed is not None:
                if parsed.get("parse_source") == "local_llm":
                    _mark_parse_observation(route="model", model_success=True)
                else:
                    _mark_parse_observation(route="fallback", fallback_used=True)
                return parsed
            if model_only:
                _mark_parse_observation(route="model", model_success=False)
                return None
            _mark_parse_observation(route="fallback", fallback_used=True)
            return _deterministic_complex_fallback(text)
        except Exception as e:
            print(f"[ScheduleParser] LLM 调用失败: {e}", flush=True)
            if model_only:
                _mark_parse_observation(route="model", model_success=False)
                raise ScheduleParserUnavailable("模型解析服务暂时不可用") from e
            # A model outage must not turn a request that is already covered
            # by deterministic rules into an empty result.  The fallback is
            # deliberately conservative: it can return a draft or a Chinese
            # clarification, but never invents a saveable date.
            _mark_parse_observation(
                route="fallback",
                fallback_used=True,
            )
            return _deterministic_complex_fallback(text)
        finally:
            if context_token is not None:
                _ACTIVE_PARSE_CONTEXT.reset(context_token)

    return await asyncio.to_thread(_call)


async def parse_schedule_text(
    text: str,
    reference_datetime: Optional[str] = None,
    timezone_name: Optional[str] = None,
    *,
    model_only: bool = False,
) -> Optional[dict]:
    """Parse text with an optional request-scoped reference clock and timezone."""
    context = _resolve_parse_context(reference_datetime, timezone_name)
    observation_owner = _parse_observation() is None
    observation_token = (
        _ACTIVE_PARSE_OBSERVATION.set(_new_parse_observation(str(text), context))
        if observation_owner
        else None
    )
    if context is None:
        try:
            return _with_context_metadata(await _parse_schedule_text_impl(text, model_only=model_only))
        finally:
            if observation_token is not None:
                _ACTIVE_PARSE_OBSERVATION.reset(observation_token)
    token = _ACTIVE_PARSE_CONTEXT.set(context)
    try:
        return _with_context_metadata(await _parse_schedule_text_impl(text, model_only=model_only))
    finally:
        _ACTIVE_PARSE_CONTEXT.reset(token)
        if observation_token is not None:
            _ACTIVE_PARSE_OBSERVATION.reset(observation_token)


def _parse_schedule_text_sync_impl(text: str, *, model_only: bool = False) -> Optional[dict]:
    """同步版本的解析（供线程池调用）"""
    if not model_only and (_is_non_schedule_control_text(text) or _is_schedule_query_text(text)):
        _mark_parse_observation(route="reject")
        return None

    if not model_only and not _schedule_force_llm() and not _should_skip_quick_schedule_parse(text):
        quick = (
            _deterministic_complex_fallback(text)
            if _is_rule_supported_reverse_range(text)
            else _parse_schedule_text_quick(text)
        )
        if quick:
            _mark_parse_observation(
                route="quick",
                model_id=None,
            )
            return quick

    config = _load_ollama_config()
    _mark_parse_observation(
        route="model",
        model_attempted=True,
        model_id=getattr(config, "model", None),
    )
    try:
        raw = call_ollama(
            config,
            system_prompt=_build_system_prompt(),
            transcript=text,
            timeout=_schedule_llm_timeout(),
            max_tokens=_schedule_llm_max_tokens(),
            options={"num_ctx": _schedule_llm_num_ctx(), "temperature": 0},
            priority="interactive",
            telemetry_operation="schedule.parse_sync",
        )
        parsed = _parse_llm_response(
            raw,
            text,
            allow_rule_fallback=not model_only,
            model_only=model_only,
        )
        if parsed is None or parsed.get("parse_source") != "local_llm":
            _mark_parse_observation(model_retry_count=1)
            retry_raw = call_ollama(
                config,
                system_prompt=_build_schedule_repair_prompt(),
                transcript=text,
                timeout=_schedule_llm_timeout(),
                max_tokens=_schedule_llm_max_tokens(),
                options={"num_ctx": _schedule_llm_num_ctx(), "temperature": 0},
                priority="interactive",
                telemetry_operation="schedule.parse_sync.retry",
            )
            retry_parsed = _parse_llm_response(
                retry_raw,
                text,
                allow_rule_fallback=not model_only,
                model_only=model_only,
            )
            if retry_parsed is not None:
                parsed = retry_parsed
        if parsed is not None:
            if parsed.get("parse_source") == "local_llm":
                _mark_parse_observation(route="model", model_success=True)
            else:
                _mark_parse_observation(route="fallback", fallback_used=True)
            return parsed
        if model_only:
            _mark_parse_observation(route="model", model_success=False)
            return None
        _mark_parse_observation(route="fallback", fallback_used=True)
        return _deterministic_complex_fallback(text)
    except Exception as e:
        print(f"[ScheduleParser] LLM 调用失败: {e}", flush=True)
        if model_only:
            _mark_parse_observation(route="model", model_success=False)
            raise ScheduleParserUnavailable("模型解析服务暂时不可用") from e
        _mark_parse_observation(
            route="fallback",
            fallback_used=True,
        )
        return _deterministic_complex_fallback(text)


def parse_schedule_text_sync(
    text: str,
    reference_datetime: Optional[str] = None,
    timezone_name: Optional[str] = None,
    *,
    model_only: bool = False,
) -> Optional[dict]:
    """Synchronous parser with the same request-scoped context contract."""
    context = _resolve_parse_context(reference_datetime, timezone_name)
    observation_owner = _parse_observation() is None
    observation_token = (
        _ACTIVE_PARSE_OBSERVATION.set(_new_parse_observation(str(text), context))
        if observation_owner
        else None
    )
    if context is None:
        try:
            return _with_context_metadata(_parse_schedule_text_sync_impl(text, model_only=model_only))
        finally:
            if observation_token is not None:
                _ACTIVE_PARSE_OBSERVATION.reset(observation_token)
    token = _ACTIVE_PARSE_CONTEXT.set(context)
    try:
        return _with_context_metadata(_parse_schedule_text_sync_impl(text, model_only=model_only))
    finally:
        _ACTIVE_PARSE_CONTEXT.reset(token)
        if observation_token is not None:
            _ACTIVE_PARSE_OBSERVATION.reset(observation_token)


def _apply_schedule_clarification_impl(current: dict, answer: str) -> Optional[dict]:
    """把用户对追问的补充应用到当前日程草稿上。"""
    normalized = _normalize_schedule_text(answer)
    if not normalized:
        return None
    if _is_non_schedule_control_text(normalized) or _has_invalid_explicit_date(normalized):
        return None

    updated = dict(current)
    question = _normalize_schedule_text(str(current.get("clarification_question") or ""))
    asks_date = bool(re.search(r"日期|哪一天|哪天|几号|起止|范围|先后顺序|首次日期", question))
    asks_time = bool(re.search(r"时间|几点|钟点|上午|下午|晚上|早上|中午|时段|首次时间", question))
    asks_location = bool(re.search(r"地点|位置|地址", question))
    asks_title = bool(re.search(r"标题|事项|内容", question))
    asks_recurrence = bool(re.search(r"重复|首次", question))
    has_known_target = asks_date or asks_time or asks_location or asks_title or asks_recurrence
    parsed_range = _parse_date_range(normalized)
    parsed_date = parsed_range[0] if parsed_range else _parse_explicit_or_relative_date(normalized)
    parsed_time = _parse_time(normalized)
    time_period = None if parsed_time else _parse_fuzzy_time_period(normalized)
    wants_all_day = bool(re.search(r"(全天|整天|一整天|整日)", normalized)) or bool(
        asks_time and re.fullmatch(r"(?:就这样|按当前|按这个|直接保存|确认保存)[。.!！?？]*", normalized)
    )
    changed = False

    if parsed_date is not None:
        updated["start_date"] = parsed_date.strftime("%Y-%m-%d")
        updated["end_date"] = parsed_range[1].strftime("%Y-%m-%d") if parsed_range else None
        changed = True
    if parsed_time is not None:
        updated["start_time"] = parsed_time
        updated["end_time"] = _default_end_time(parsed_time)
        updated["time_period"] = None
        updated["is_all_day"] = False
        changed = True
    elif time_period is not None:
        # If the original request contained a bare clock such as “五点”, the
        # follow-up “下午” qualifies that clock instead of becoming a separate
        # untimed input. Otherwise retain the spoken period without inventing
        # an exact HH:mm value.
        inherited_clock = None
        original_text = _normalize_schedule_text(str(current.get("raw_text") or ""))
        clock_matches = list(re.finditer(_TIME_TOKEN_PATTERN, original_text))
        if clock_matches:
            inherited_clock = _parse_time_token(
                clock_matches[-1].group(0),
                default_period=_time_period_surface(time_period),
            )
        if inherited_clock:
            updated["start_time"] = inherited_clock
            updated["end_time"] = _default_end_time(inherited_clock)
            updated["time_period"] = None
        else:
            updated["start_time"] = None
            updated["end_time"] = None
            updated["time_period"] = time_period
        updated["is_all_day"] = False
        changed = True
    elif wants_all_day:
        updated["start_time"] = None
        updated["end_time"] = None
        updated["time_period"] = None
        updated["is_all_day"] = True
        changed = True

    if asks_location and parsed_date is None and parsed_time is None and time_period is None and not wants_all_day:
        location_answer = normalized.strip("，,。.!！?？；; ")
        if re.fullmatch(r"(?:是|是的|对|对的|确定|就这个|就那里)", location_answer):
            location_answer = _extract_location(_normalize_schedule_text(str(current.get("raw_text") or ""))) or ""
        correction = re.search(r"(?:不是[^，,。；;]{0,40}[，,。；;])?(?:是|改成|改为|换成|定在|就在)([^，,。.!！?？；;]{1,100})", location_answer)
        if correction:
            location_answer = correction.group(1).strip()
        location_answer = re.sub(r"^(?:地点|位置|地址)(?:是|在|改成|改为|换成)?", "", location_answer).strip()
        if location_answer and not _UNCERTAIN_LOCATION_RE.search(location_answer):
            updated["location"] = location_answer[:100]
            changed = True

    if asks_title and parsed_date is None and parsed_time is None and time_period is None and not wants_all_day:
        title_answer = re.sub(r"^(?:标题|事项|内容)(?:是|叫|写成|写为|改成|改为)?", "", normalized)
        title_answer = title_answer.strip("，,。.!！?？；; ")
        if title_answer:
            updated["title"] = title_answer[:100]
            changed = True

    if asks_recurrence and re.search(r"每|隔周|重复|不重复|一次", normalized):
        if re.search(r"不重复|一次(?:性)?", normalized):
            updated.update({
                "event_type": "once",
                "recurrence_interval": 1,
                "recurrence_weekdays": None,
                "recurrence_until_date": None,
            })
            changed = True
        else:
            recurrence = _parse_recurrence_rule(normalized)
            if not recurrence.get("unsupported"):
                updated.update({
                    "event_type": recurrence.get("event_type", updated.get("event_type", "once")),
                    "recurrence_interval": recurrence.get("interval", 1),
                    "recurrence_weekdays": recurrence.get("weekdays"),
                    "recurrence_until_date": (
                        recurrence["until_date"].strftime("%Y-%m-%d")
                        if recurrence.get("until_date")
                        else None
                    ),
                })
                changed = True

    if not changed:
        return None

    raw_text = str(current.get("raw_text") or "").strip()
    updated["raw_text"] = f"{raw_text}；补充：{answer.strip()}" if raw_text else answer.strip()
    updated["parse_source"] = "clarified"
    updated["confidence"] = max(float(updated.get("confidence") or 0), 0.92)
    unresolved = []
    if asks_date and not updated.get("start_date"):
        unresolved.append("日期")
    if asks_time and not (
        updated.get("start_time")
        or updated.get("time_period")
        or updated.get("is_all_day")
    ):
        unresolved.append("时间")
    if asks_location and not updated.get("location"):
        unresolved.append("地点")
    if asks_title and not str(updated.get("title") or "").strip():
        unresolved.append("事项")
    if unresolved:
        updated["needs_clarification"] = True
        updated["clarification_question"] = f"还需要补充{'和'.join(unresolved)}。"
    elif has_known_target or changed:
        updated["needs_clarification"] = False
        updated["clarification_question"] = None
    return updated


def apply_schedule_clarification(
    current: dict,
    answer: str,
    reference_datetime: Optional[str] = None,
    timezone_name: Optional[str] = None,
) -> Optional[dict]:
    """Apply a clarification using the draft's original request clock."""
    inherited_reference = reference_datetime or current.get("reference_datetime")
    inherited_timezone = timezone_name or current.get("timezone")
    context = _resolve_parse_context(inherited_reference, inherited_timezone)
    if context is None:
        return _with_context_metadata(_apply_schedule_clarification_impl(current, answer))
    token = _ACTIVE_PARSE_CONTEXT.set(context)
    try:
        return _with_context_metadata(_apply_schedule_clarification_impl(current, answer))
    finally:
        _ACTIVE_PARSE_CONTEXT.reset(token)


def _deferred_detail_fallback(raw_text: str, *, allow_rule_fallback: bool = True) -> Optional[dict]:
    if not allow_rule_fallback:
        return None
    normalized_raw = _normalize_schedule_text(raw_text)
    if not _DEFERRED_DETAIL_RE.search(normalized_raw):
        return None
    fallback_text = re.sub(
        r"^加[^，,。.!！?？]{0,8}个待办[，,]?",
        "加个待办，",
        raw_text,
    )
    fallback = _parse_schedule_text_quick(fallback_text)
    if fallback is None:
        return None
    fallback["raw_text"] = raw_text
    if not _has_date_signal(normalized_raw):
        fallback["needs_clarification"] = True
        fallback["clarification_question"] = "没有听到具体日期，需要补充日期或确认按今天保存。"
    return fallback


def _parse_llm_response(
    raw: str,
    raw_text: str,
    *,
    allow_rule_fallback: bool = True,
    model_only: bool = False,
) -> Optional[dict]:
    """从 LLM 输出中提取 JSON，尝试多种解析策略"""
    def normalize(value: object) -> Optional[dict]:
        # The model-only route is deliberately a separate normalization path.
        # It may validate the model's JSON shape and values, but it must not
        # reinterpret the user's surface text with the server rule parser.
        return (
            _normalize_model_only_result(value, raw_text)
            if model_only
            else _normalize_llm_result(value, raw_text)
        )

    # 策略1：直接解析完整 JSON
    try:
        normalized = normalize(json.loads(raw))
        if normalized is not None:
            return normalized
        return _deferred_detail_fallback(raw_text, allow_rule_fallback=allow_rule_fallback)
    except json.JSONDecodeError:
        pass

    # 策略2：提取 markdown 代码块
    code_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if code_match:
        try:
            return normalize(json.loads(code_match.group(1)))
        except json.JSONDecodeError:
            pass

    # 策略3：找到第一个 { ... } JSON 对象
    brace_start = raw.find("{")
    brace_end = raw.rfind("}")
    if brace_start != -1 and brace_end != -1 and brace_end > brace_start:
        candidate = raw[brace_start:brace_end + 1]
        try:
            result = json.loads(candidate)
            normalized = normalize(result)
            if normalized:
                return normalized
        except json.JSONDecodeError:
            pass

    # 策略4：逐行扫描找有效 JSON
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                result = json.loads(line)
                normalized = normalize(result)
                if normalized:
                    return normalized
            except json.JSONDecodeError:
                continue

    print(f"[ScheduleParser] 无法从 LLM 输出解析 JSON: {raw[:200]}", flush=True)
    return _deferred_detail_fallback(raw_text, allow_rule_fallback=allow_rule_fallback)


def _verified_model_surface_phrase(
    result: dict,
    key: str,
    raw_text: str,
) -> Optional[str]:
    """Accept a model evidence phrase only when it is present in the request."""
    phrase = _normalize_optional_text(result.get(key), limit=100)
    if not phrase:
        return None
    normalized_phrase = _normalize_schedule_text(phrase)
    normalized_raw = _normalize_schedule_text(raw_text)
    if not normalized_phrase or normalized_phrase not in normalized_raw:
        return None
    if key in {"time_phrase", "end_time_phrase"}:
        index = normalized_raw.find(normalized_phrase)
        prefix = normalized_raw[:index]
        for period in ("凌晨", "早上", "上午", "中午", "下午", "傍晚", "晚上", "晚间"):
            if prefix.endswith(period):
                return period + normalized_phrase
    return normalized_phrase


def _normalize_model_only_result(result: object, raw_text: str) -> Optional[dict]:
    """Validate model output without reparsing the user's text.

    ``model_only`` is used after the phone's shared rule parser has declined a
    complex create utterance.  In that route the server is not allowed to
    recover a date, title, category, recurrence, reminder, or clarification
    from ``raw_text``.  The model owns those semantics; this function only
    performs schema/safety normalization so malformed model JSON cannot enter
    the calendar database.
    """
    if result is None or not isinstance(result, dict):
        return None

    title = _sanitize_llm_title(str(result.get("title") or ""), "")
    if re.search(r"(?:下下|下个|下一个|下|本|这|这个)?周末(?:两|二|2)?天?(?:去|做|休息|安排|参加|出发)", raw_text):
        title = re.sub(r"^(?:下下|下个|下一个|下|本|这|这个)?周末(?:两|二|2)?天?", "", title).strip(" ，,。") or title
    if not title:
        return None

    allowed_event_types = {"once", "daily", "weekly", "monthly", "yearly"}
    event_type = str(result.get("event_type") or "once").strip().lower()
    if event_type not in allowed_event_types:
        event_type = "once"

    def clean_date(value: object) -> str:
        candidate = str(value or "").strip()
        return candidate if _is_valid_date_like(candidate) else ""

    start_date = clean_date(result.get("start_date"))
    end_date = clean_date(result.get("end_date")) or None
    start_time = _clean_time(result.get("start_time"))
    end_time = _clean_time(result.get("end_time"))
    date_phrase = _verified_model_surface_phrase(result, "date_phrase", raw_text)
    end_date_phrase = _verified_model_surface_phrase(result, "end_date_phrase", raw_text)
    time_phrase = _verified_model_surface_phrase(result, "time_phrase", raw_text)
    end_time_phrase = _verified_model_surface_phrase(result, "end_time_phrase", raw_text)
    recurrence_phrase = _verified_model_surface_phrase(result, "recurrence_phrase", raw_text)

    # The model decides which surface spans carry calendar meaning. Absolute
    # dates, clocks and recurrence fields are then canonicalized only from
    # those verified spans, never by rerunning the full rule parser on raw_text.
    evidence_date: Optional[date] = None
    evidence_end_date: Optional[date] = None
    date_range_conflict = False
    spoken_day_period = bool(re.search(r"(?:明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)", raw_text))
    spoken_clock = _parse_authoritative_time(raw_text) if spoken_day_period else None
    spoken_period = _parse_fuzzy_time_period(raw_text) if spoken_day_period else None
    relative_evidence = date_phrase or time_phrase
    relative_start = (
        _parse_relative_offset_datetime(relative_evidence)
        if relative_evidence
        else None
    )
    if relative_start:
        evidence_date = relative_start.date()
        start_time = relative_start.strftime("%H:%M")
    elif date_phrase:
        evidence_range = _parse_date_range_unchecked(date_phrase)
        if evidence_range:
            evidence_date, evidence_end_date = evidence_range
        else:
            evidence_date = _parse_authoritative_date(date_phrase)
    if evidence_date is None and spoken_day_period:
        # The model-only route must not broadly reparse user text, but these
        # unambiguous spoken day-period aliases are an explicit date surface
        # fact. Recovering them prevents "明早九点" from becoming a date-less
        # clarification draft when the model omits date_phrase.
        evidence_date = _parse_authoritative_date(raw_text)
    if start_time is None and spoken_clock:
        start_time = spoken_clock
    if end_date_phrase:
        evidence_end_date = _parse_range_date_token(
            end_date_phrase,
            reference=_current_date(),
            context=evidence_date,
        )
    if evidence_date:
        start_date = evidence_date.strftime("%Y-%m-%d")
    elif event_type == "once":
        start_date = ""
        end_date = None
    if evidence_end_date and evidence_date and evidence_end_date >= evidence_date:
        end_date = evidence_end_date.strftime("%Y-%m-%d")
    elif end_date_phrase:
        end_date = None
        date_range_conflict = bool(
            evidence_date
            and evidence_end_date
            and evidence_end_date < evidence_date
        )

    if not relative_start:
        model_time = _parse_authoritative_time(time_phrase) if time_phrase else None
        if spoken_clock:
            start_time = spoken_clock
        elif model_time:
            start_time = model_time
        elif not (spoken_day_period and start_time):
            start_time = None
    # Generic model evidence such as “上午” stays an all-day candidate in
    # model-only mode. Only explicit aliases such as “明早/明晚” carry a
    # relative period that should be preserved without a numeric clock.
    time_period = None if start_time else spoken_period
    end_time = (
        _parse_time_token(
            end_time_phrase,
            default_period=_extract_time_period(time_phrase or ""),
        )
        if end_time_phrase
        else None
    )

    # These are model fields, not values inferred from the original sentence.
    # Keep a small amount of structural protection for impossible ranges, but
    # do not attempt to repair them from raw_text.
    needs_clarification = bool(result.get("needs_clarification", False))
    clarification_question = _normalize_optional_text(
        result.get("clarification_question"), limit=300
    )
    if end_date and start_date and end_date < start_date:
        end_date = None
        needs_clarification = True
        clarification_question = clarification_question or "开始和结束日期的先后顺序需要确认。"
    if start_time and end_time and end_time < start_time:
        needs_clarification = True
        clarification_question = clarification_question or "开始和结束时间的先后顺序需要确认。"
    if (
        needs_clarification
        and start_date
        and start_time is None
        and clarification_question
        and re.search(r"(?:几点|具体(?:的)?(?:时间|钟点)|开始时间)", clarification_question)
    ):
        # A date-only event is saveable. A vague period must not create a
        # blocking question merely because the model wanted an exact clock.
        needs_clarification = False
        clarification_question = None
    if needs_clarification and not clarification_question:
        clarification_question = "还有一项日程信息需要确认。"
    if not needs_clarification:
        clarification_question = None

    category = _normalize_optional_text(result.get("category"), limit=50)
    if category not in _CATEGORY_SET:
        category = _DEFAULT_CATEGORY

    recurrence_interval = 1
    try:
        recurrence_interval = max(1, min(365, int(result.get("recurrence_interval", 1))))
    except (TypeError, ValueError):
        recurrence_interval = 1

    recurrence_weekdays_value = result.get("recurrence_weekdays")
    recurrence_weekdays: Optional[list[int]] = None
    if isinstance(recurrence_weekdays_value, (list, tuple)):
        cleaned_weekdays: list[int] = []
        for value in recurrence_weekdays_value:
            try:
                weekday = int(value)
            except (TypeError, ValueError):
                continue
            if 1 <= weekday <= 7 and weekday not in cleaned_weekdays:
                cleaned_weekdays.append(weekday)
        recurrence_weekdays = cleaned_weekdays or None

    recurrence_until_date = clean_date(result.get("recurrence_until_date")) or None
    recurrence_unsupported = False
    if recurrence_phrase:
        recurrence_rule = _parse_recurrence_rule(recurrence_phrase)
        recurrence_unsupported = bool(recurrence_rule["unsupported"])
        event_type = recurrence_rule["event_type"]
        recurrence_interval = recurrence_rule["interval"]
        recurrence_weekdays = recurrence_rule["weekdays"]
        recurrence_until = recurrence_rule["until_date"]
        recurrence_until_date = (
            recurrence_until.strftime("%Y-%m-%d")
            if recurrence_until is not None
            else None
        )
        if not start_date:
            recurrence_anchor = _parse_authoritative_date(recurrence_phrase)
            if recurrence_anchor:
                start_date = recurrence_anchor.strftime("%Y-%m-%d")
            elif event_type == "daily":
                start_date = _current_date().strftime("%Y-%m-%d")
    elif event_type != "once":
        # A recurrence without an exact source span is not safe to save as a
        # repeated event. Keep it as a draft instead of trusting invented data.
        event_type = "once"
        recurrence_interval = 1
        recurrence_weekdays = None
        recurrence_until_date = None
    if recurrence_until_date and start_date and recurrence_until_date < start_date:
        recurrence_until_date = None
        needs_clarification = True
        clarification_question = clarification_question or "重复结束日期需要晚于开始日期。"
    if not start_date:
        needs_clarification = True
        clarification_question = clarification_question or "没有听到具体日期，需要补充日期。"

    description = _normalize_optional_text(result.get("description"), limit=500)
    color = _normalize_optional_text(result.get("color"), limit=32)
    location = _normalize_optional_text(result.get("location"), limit=100)
    if _UNCERTAIN_LOCATION_RE.search(_normalize_schedule_text(raw_text)):
        location = None
    elif not location:
        location = _recover_explicit_location(raw_text)
    detail = _normalize_optional_text(result.get("detail"), limit=1000)
    status = _normalize_optional_text(result.get("status"), limit=50)
    reminder_minutes = _normalize_reminder_minutes(result.get("reminder_minutes"))
    confidence = _clamp_float(result.get("confidence"), default=0.72)
    is_all_day = start_time is None and time_period is None
    if bool(result.get("is_all_day", False)) and time_period is None:
        is_all_day = True
    if is_all_day:
        start_time = None
        end_time = None

    time_range_conflict = bool(
        start_time
        and end_time
        and end_time <= start_time
    )
    ambiguous_clock = bool(
        time_phrase
        and _has_unqualified_clock_ambiguity(time_phrase)
        and not spoken_day_period
    )
    location_uncertain = bool(_UNCERTAIN_LOCATION_RE.search(_normalize_schedule_text(raw_text)))
    if not start_date:
        needs_clarification = True
        clarification_question = "没有听到具体日期，需要补充日期。"
    elif date_range_conflict or (end_date_phrase and evidence_end_date is None):
        needs_clarification = True
        clarification_question = "开始和结束日期的先后顺序需要确认。"
    elif time_range_conflict:
        needs_clarification = True
        clarification_question = "开始和结束时间的先后顺序需要确认。"
    elif ambiguous_clock:
        needs_clarification = True
        clarification_question = "这个钟点没有说明上午或下午，需要确认具体时段。"
    elif location_uncertain:
        needs_clarification = True
        clarification_question = "地点还不确定，需要确认最终地点。"
    elif recurrence_unsupported:
        needs_clarification = True
        clarification_question = "这个重复规则较复杂，需要进入详细编辑确认。"
    else:
        needs_clarification = False
        clarification_question = None

    return {
        "title": title[:100],
        "event_type": event_type,
        "recurrence_interval": recurrence_interval,
        "recurrence_weekdays": recurrence_weekdays,
        "recurrence_until_date": recurrence_until_date,
        "start_date": start_date,
        "end_date": end_date,
        "color": color,
        "spanning": bool(end_date and end_date != start_date),
        "start_time": start_time,
        "end_time": end_time,
        "time_period": time_period,
        "is_all_day": is_all_day,
        "description": description,
        "location": location,
        "category": category,
        "detail": detail,
        "status": status,
        "reminder_minutes": reminder_minutes,
        "raw_text": raw_text,
        "parse_source": "local_llm",
        "confidence": confidence,
        "needs_clarification": needs_clarification,
        "clarification_question": clarification_question,
    }


def _recover_explicit_location(raw_text: str) -> Optional[str]:
    """Recover only a definite venue omitted by a generation provider."""
    normalized = _normalize_schedule_text(raw_text)
    if _UNCERTAIN_LOCATION_RE.search(normalized):
        return None
    return _extract_location(normalized)


def _event_type_from_text(raw_text: str) -> str:
    normalized = _normalize_recurrence_expression(_normalize_schedule_text(raw_text))
    if _parse_date_range_unchecked(normalized) and not _RECURRENCE_MARKER_RE.search(normalized):
        return "once"
    return _parse_recurrence_rule(normalized)["event_type"]


def _normalize_llm_result(result: object, raw_text: str) -> Optional[dict]:
    """规整并校验本地大模型输出，避免自由发挥直接进入日程。"""
    if result is None:
        return None
    if not isinstance(result, dict):
        return None

    title = _sanitize_llm_title(str(result.get("title") or "").strip(), raw_text)
    if re.search(r"(?:下下|下个|下一个|下|本|这|这个)?周末(?:两|二|2)?天?(?:去|做|休息|安排|参加|出发)", raw_text):
        title = re.sub(r"^(?:下下|下个|下一个|下|本|这|这个)?周末(?:两|二|2)?天?", "", title).strip(" ，,。") or title
    event_type = str(result.get("event_type") or "once").strip()
    start_date = str(result.get("start_date") or "").strip()
    end_date = str(result.get("end_date") or "").strip() or None
    start_time = _clean_time(result.get("start_time"))
    end_time = _clean_time(result.get("end_time"))
    description = result.get("description")
    description = str(description).strip() if description not in (None, "") else None
    color = _normalize_optional_text(result.get("color"), limit=32)
    location = _normalize_optional_text(result.get("location"), limit=100)
    category = _normalize_category(result.get("category"), title=title, raw_text=raw_text)
    detail = _normalize_optional_text(result.get("detail"), limit=1000)
    status = _normalize_optional_text(result.get("status"), limit=50)

    normalized_raw = _normalize_schedule_text(raw_text)
    if not _EXPLICIT_CATEGORY_RE.search(normalized_raw) and _infer_category(title, normalized_raw) == _DEFAULT_CATEGORY:
        category = None
    if (
        not _EXPLICIT_CATEGORY_RE.search(normalized_raw)
        and not re.search(_DATE_TOKEN_PATTERN, normalized_raw)
        and _parse_relative_offset_datetime(normalized_raw) is None
        and (
            category == _DEFAULT_CATEGORY
            or title in {"会议", "开会", "会面", "预约", "提醒", "活动", "日程", "事项", "安排"}
            or re.fullmatch(r"(?:和|跟|与).+的会议", title)
        )
    ):
        category = None
    surface_title, _ = _extract_title_and_description(normalized_raw)
    pre_correction_subject = _extract_pre_correction_subject(raw_text)
    if pre_correction_subject:
        # A conditional replacement tail is temporal instruction, not the
        # event subject. Prefer the subject spoken before the first marker.
        surface_title = pre_correction_subject
        title = pre_correction_subject
    elif _prefer_surface_title(title, surface_title):
        title = surface_title
    elif _prefer_correction_surface_title(title, normalized_raw):
        correction_tail = _select_correction_tail(normalized_raw)
        correction_title, _ = _extract_title_and_description(correction_tail)
        if correction_title:
            title = correction_title
    recurrence_rule = _parse_recurrence_rule(normalized_raw)
    if recurrence_rule["event_type"] != "once":
        # The model often returns the cadence but omits its first occurrence.
        # Reuse the deterministic recurrence/date pass as an authoritative
        # surface fact; this does not replace the model for ordinary fields.
        recurrence_surface = _parse_schedule_text_quick(raw_text)
        if recurrence_surface and recurrence_surface.get("event_type") == recurrence_rule["event_type"]:
            if not start_date:
                start_date = str(recurrence_surface.get("start_date") or "")
            if end_date is None and recurrence_surface.get("end_date") is not None:
                end_date = recurrence_surface.get("end_date")
    if _DATE_CORRECTION_RE.search(normalized_raw) and re.fullmatch(
        r"(?:不是|不对|说错|先(?:让我)?|最后(?:定)?|最终(?:是)?|"
        r"改成|改为|换成|调整到|以后面的为准|后面的为准)",
        title,
    ):
        authoritative_title, _ = _extract_title_and_description(normalized_raw)
        if authoritative_title:
            title = authoritative_title
    invalid_explicit_date = _has_invalid_explicit_date(normalized_raw)

    if not title:
        return None
    # The model may omit dates when the utterance is incomplete. Let the
    # deterministic text pass derive an authoritative date, or preserve an
    # empty date so the caller receives a clarification draft instead of a
    # silently dropped schedule. A malformed model date must not override a
    # valid date present in the user's text.
    if start_date and not _is_valid_date_like(start_date):
        start_date = ""

    if invalid_explicit_date:
        # Preserve a draft for clarification, never a guessed date that can be saved.
        start_date = ""
        end_date = None
    event_type = recurrence_rule["event_type"]
    recurrence_interval = recurrence_rule["interval"]
    recurrence_weekdays = recurrence_rule["weekdays"]
    recurrence_until_date = recurrence_rule["until_date"]
    temporal_raw = re.sub(
        r"标题.{0,8}写短(?:[，,]?(?:可能|大概|就是|然后)?[，,]?)?一点",
        "",
        normalized_raw,
    )
    relative_start = None if invalid_explicit_date else _parse_relative_offset_datetime(temporal_raw)
    if relative_start:
        event_type = "once"
        start_date = relative_start.date().strftime("%Y-%m-%d")
        start_time = relative_start.strftime("%H:%M")
        end_time = None
        end_date = None

    next_month_start = _parse_vague_next_month_start(normalized_raw)
    if next_month_start:
        event_type = "once"
        # Keep the candidate date only as an internal reference for the
        # clarification message; do not present the first of next month as a
        # saveable date when the user said only “下个月”.
        start_date = ""
        end_date = None

    deterministic_date = _parse_authoritative_date(normalized_raw)
    if deterministic_date and not relative_start and not invalid_explicit_date:
        start_date = deterministic_date.strftime("%Y-%m-%d")
    spoken_time_range = _parse_time_range(temporal_raw)
    if spoken_time_range and not relative_start:
        start_time, end_time = spoken_time_range
    elif not relative_start:
        deterministic_time = _parse_authoritative_time(temporal_raw)
        start_time = deterministic_time
        end_time = None
    if "我要处理" in normalized_raw and title.startswith("处理"):
        title = title[2:].strip() or title

    uncertain_location = re.search(
        r"地点(?:还)?(?:可能变|不确定|没定|未定)[，,]?"
        r"(?:先|暂时)?(?:写|填|记|按)([^，,。.!！?？；;]{1,100})",
        normalized_raw,
    )
    if uncertain_location:
        location = uncertain_location.group(1).strip()
    elif not location:
        # Keep an explicit venue when the provider omits this optional field.
        location = _extract_location(normalized_raw)
    elif location and (
        _LOCATION_PLACEHOLDER_RE.fullmatch(location)
        or re.search(r"^(?:带上|备注|需要通知|主要确认|重点是|和.+一起)", location)
    ):
        location = None

    weekday_selection_range = event_type == "weekly" and bool(recurrence_weekdays and len(recurrence_weekdays) > 1)
    has_range_signal = _has_date_range_signal(normalized_raw) and not weekday_selection_range
    spoken_range = None if invalid_explicit_date or weekday_selection_range else _parse_date_range_unchecked(normalized_raw)
    range_ambiguous = has_range_signal and spoken_range is None
    range_conflict = False
    time_conflict = False
    unsupported_recurrence = bool(recurrence_rule["unsupported"])
    range_collapsed_against_intent = bool(
        spoken_range
        and spoken_range[0] == spoken_range[1]
        and re.search(
            r"(?:别|不要|不能|不应|不想)[^，,。；;]{0,12}"
            r"(?:只|仅)[^，,。；;]{0,8}(?:一天|一日|单日)",
            normalized_raw,
        )
    )
    implicit_long_range_needs_confirmation = _implicit_long_cross_year_range_needs_confirmation(
        normalized_raw,
        spoken_range,
    )
    if spoken_range:
        spoken_start, spoken_end = spoken_range
        start_date = spoken_start.strftime("%Y-%m-%d")
        if spoken_end < spoken_start:
            end_date = None
            range_conflict = True
        else:
            end_date = spoken_end.strftime("%Y-%m-%d") if spoken_end != spoken_start else None
    elif range_ambiguous:
        end_date = None

    if recurrence_until_date is not None and not unsupported_recurrence:
        end_date = recurrence_until_date.strftime("%Y-%m-%d")

    # Do not fabricate today's date when the utterance contains no date.
    # Keep the draft unsaveable until the user explicitly supplies or confirms
    # a date.
    if not _has_date_signal(normalized_raw) and event_type == "once":
        start_date = ""
        end_date = None

    if end_date is not None:
        if not _is_valid_date_like(end_date):
            end_date = None
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", start_date) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_date) and end_date < start_date:
            end_date = None
        elif end_date == start_date:
            end_date = None

    # A one-hour default that crosses midnight is still a single-day calendar
    # event in this contract.  Only an explicit date range or recurrence end
    # may populate end_date; older model output incorrectly marked 23:xx ->
    # 00:xx as a spanning event on the following day.
    if (
        end_date is not None
        and recurrence_until_date is None
        and not _has_date_range_signal(normalized_raw)
        and start_time is not None
        and end_time is not None
        and end_time < start_time
    ):
        end_date = None

    if start_time and not _is_explicit_all_day(normalized_raw) and (
        end_time is None or end_time == start_time
    ):
        # A single spoken clock denotes a normal one-hour event. Keep this
        # default in the normalization path as well as the quick path so a
        # model cannot erase the duration by repeating or omitting the end.
        end_time = _default_end_time(start_time)

    time_period = None if start_time else _parse_fuzzy_time_period(normalized_raw)

    if start_time and end_time and end_time < start_time and not range_conflict:
        time_conflict = True
    is_all_day = start_time is None and time_period is None and (
        _is_explicit_all_day(normalized_raw)
        or bool(_has_date_signal(normalized_raw))
    )
    if is_all_day:
        end_time = None

    explicit_reminder_minutes = _parse_reminder_minutes(raw_text)
    reminder_minutes = _normalize_reminder_minutes(result.get("reminder_minutes"))
    if _wants_no_reminder(raw_text):
        reminder_minutes = None
    elif explicit_reminder_minutes is not None and (
        not is_all_day
        or (start_date and not invalid_explicit_date and not range_conflict)
    ):
        reminder_minutes = explicit_reminder_minutes
    elif is_all_day:
        reminder_minutes = None
    elif relative_start and re.search(r"(?:之后|以后|后)(?:提醒我|提醒|叫我)", _normalize_schedule_text(raw_text)):
        reminder_minutes = 0
    # An omitted reminder is unknown, not an implicit model default.  Clear a
    # model-produced value when the surface text did not contain a reminder;
    # the editor may offer its own default without corrupting the parser
    # oracle with a field the user never spoke.
    elif explicit_reminder_minutes is None:
        reminder_minutes = None

    confidence = _clamp_float(result.get("confidence"), default=0.72)
    needs_clarification = bool(result.get("needs_clarification", confidence < 0.7))
    clarification_question = result.get("clarification_question")
    clarification_question = (
        str(clarification_question).strip()
        if clarification_question not in (None, "")
        else None
    )
    inferred_question = _infer_clarification_question(
        raw_text=raw_text,
        is_all_day=is_all_day,
        start_time=start_time,
        end_date=end_date,
    )
    if inferred_question:
        needs_clarification = True
        clarification_question = inferred_question
    if range_conflict:
        needs_clarification = True
        clarification_question = "起始日期的先后顺序有矛盾，需要确认正确的开始日期和结束日期。"
    elif range_collapsed_against_intent:
        needs_clarification = True
        clarification_question = "两个日期按当前日期计算落在同一天，但原文要求不是单日，需要确认结束日期。"
    elif implicit_long_range_needs_confirmation and spoken_range:
        needs_clarification = True
        clarification_question = (
            f"结束日期按 {spoken_range[1].strftime('%Y-%m-%d')} 处理会形成跨年长日程，"
            "需要确认年份和起止顺序。"
        )
    elif range_ambiguous:
        needs_clarification = True
        clarification_question = "听到了日期范围，但开始或结束日期不够清楚，需要确认完整的起止日期。"
    elif time_conflict:
        needs_clarification = True
        clarification_question = "开始和结束时间的先后顺序有矛盾，需要确认正确的结束时间。"
    unresolved_time = bool(
        re.search(
            r"(?:时间|钟点|几点)[^，,。.!！?？；;]{0,16}(?:还没|没定|未定|没想好|回头补|再看|再说)",
            normalized_raw,
        )
    )
    if unresolved_time:
        needs_clarification = True
        clarification_question = "时间还没有确定，需要补充具体时间。"
    location_uncertain = bool(_UNCERTAIN_LOCATION_RE.search(normalized_raw))
    if location_uncertain:
        # A tentative location is evidence for clarification, not a confirmed
        # venue.  Keep the explicit "先按 X" compatibility path above, but do
        # not persist ordinary candidates such as "地点可能在青松讨论室".
        if uncertain_location is None:
            location = None
        needs_clarification = True
        clarification_question = "地点还不确定，需要确认最终地点。"
    if next_month_start:
        needs_clarification = True
        clarification_question = clarification_question or "下个月的日期不够具体，需要补充具体日期或确认按下月 1 日保存。"
    if unsupported_recurrence:
        recurrence_interval = 1
        recurrence_weekdays = None
        recurrence_until_date = None
        start_date = ""
        end_date = None
        needs_clarification = True
        clarification_question = "这个重复规则较复杂，不能自动简化，需要进入详细编辑确认。"

    try:
        parsed_start_day = date.fromisoformat(start_date) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", start_date) else None
    except ValueError:
        parsed_start_day = None
    dst_question = _dst_risk_question(parsed_start_day, start_time)
    if dst_question:
        needs_clarification = True
        clarification_question = dst_question

    clarification_required = (
        invalid_explicit_date
        or not _has_date_signal(normalized_raw)
        or range_conflict
        or time_conflict
        or range_collapsed_against_intent
        or range_ambiguous
        or bool(implicit_long_range_needs_confirmation and spoken_range)
        or unresolved_time
        or location_uncertain
        or next_month_start is not None
        or unsupported_recurrence
        or dst_question is not None
    )
    if not clarification_required:
        needs_clarification = False
        clarification_question = None
    elif invalid_explicit_date:
        needs_clarification = True
        clarification_question = "未能确定有效日期，需要补充日期。"

    return {
        "title": title[:100],
        "event_type": event_type,
        "recurrence_interval": recurrence_interval,
        "recurrence_weekdays": recurrence_weekdays,
        "recurrence_until_date": recurrence_until_date.strftime("%Y-%m-%d") if recurrence_until_date else None,
        "start_date": start_date,
        "end_date": end_date,
        "color": color,
        "spanning": bool(end_date and end_date != start_date),
        "start_time": start_time,
        "end_time": end_time,
        "time_period": time_period,
        "is_all_day": is_all_day,
        "description": description[:500] if description else None,
        "location": location,
        "category": category,
        "detail": detail,
        "status": status,
        "reminder_minutes": reminder_minutes,
        "raw_text": raw_text,
        "parse_source": "local_llm",
        "confidence": confidence,
        "needs_clarification": needs_clarification,
        "clarification_question": clarification_question,
    }


def _infer_clarification_question(
    *,
    raw_text: str,
    is_all_day: bool,
    start_time: Optional[str],
    end_date: Optional[str],
) -> Optional[str]:
    """只对缺失日期或仍影响日期语义的歧义做硬性追问。"""
    normalized = _normalize_schedule_text(raw_text)
    if not _has_date_signal(normalized):
        return "没有听到具体日期，需要补充日期或确认按今天保存。"
    fuzzy_deadline = re.search(
        r"(月底前|月末前|年底前|年末前|本周内|这周内|下周内|本月内|这个月内|"
        r"之前|截止|截至|尽快|抽空|有空|找个时间|找时间|大概|左右|早些时候|晚些时候)",
        normalized,
    )
    if fuzzy_deadline and not (start_time and _has_date_signal(normalized)):
        return "这个表达更像截止时间或模糊时间，需要我按当前日期保存，还是换成具体某一天/某个时间？"
    if end_date is None and _has_date_range_signal(normalized):
        return "听到了日期范围，但开始或结束日期不够清楚，需要确认完整的起止日期。"
    return None


def _has_date_signal(text: str) -> bool:
    if _parse_relative_offset_datetime(text) is not None:
        return True
    if _parse_date_range(text) is not None:
        return True
    if _parse_explicit_or_relative_date(text) is not None:
        return True
    recurrence_text = _normalize_recurrence_expression(text)
    return bool(_RECURRENCE_MARKER_RE.search(recurrence_text))


def _clean_time(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if text.lower() == "null":
        return None
    match = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", text)
    if not match:
        return None
    return f"{int(match.group(1)):02d}:{int(match.group(2)):02d}"


def _is_valid_date_like(value: str) -> bool:
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            year, month, day = [int(part) for part in value.split("-")]
            date(year, month, day)
            return True
        except ValueError:
            return False
    if re.fullmatch(r"\d{2}-\d{2}", value):
        month, day = [int(part) for part in value.split("-")]
        if not 1 <= month <= 12:
            return False
        return 1 <= day <= calendar.monthrange(2028, month)[1]
    return False


def _has_invalid_explicit_date(text: str) -> bool:
    """Detect impossible spoken calendar dates before any clamping fallback."""
    patterns = (
        r"(?P<year>\d{4})年(?P<month>[0-9一二两三四五六七八九十]{1,2})月(?P<day>[0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        r"(?<!年)(?<![0-9])(?P<month>[0-9一二两三四五六七八九十]{1,2})月(?P<day>[0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        r"(?P<year>\d{4})[-/.](?P<month>\d{1,2})[-/.](?P<day>\d{1,2})",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text):
            year = int(match.group("year")) if match.groupdict().get("year") else _current_date().year
            month = _cn_to_int(match.group("month"))
            day = _cn_to_int(match.group("day"))
            if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(year, month)[1]:
                return True
    return False


def _clamp_float(value: object, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, number))


# ==================== 快速规则解析 ====================

_CN_NUM_MAP = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}

_WEEKDAY_MAP = {
    "一": 0,
    "二": 1,
    "三": 2,
    "四": 3,
    "五": 4,
    "六": 5,
    "日": 6,
    "天": 6,
    "1": 0,
    "2": 1,
    "3": 2,
    "4": 3,
    "5": 4,
    "6": 5,
    "7": 6,
}


_DATE_TOKEN_PATTERN = (
    r"(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)"
    r"|(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月(?:底|末)"
    r"|(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月初"
    r"|(?:下个月|下月|本月|这个月)[0-9一二两三四五六七八九十]{1,3}(?:号|日)"
    r"|下个月初|下月初|本月初|这个月初|月初|下个月底|下个月末|下月底|下月末|月底|月末|周末|"
    r"下下周末|下个周末|下一个周末|下周末|本周末|这周末|这个周末|"
    r"明早|明晨|明晚|明夜|今早|今晨|今夜|今晚|大后天|后天|明天|今天|今日"
    r"|(?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7]"
    r"|(?:下个|下一个)(?:周|星期|礼拜)[一二三四五六日天1-7]"
    r"|[0-9一二两三四五六七八九十]{1,3}(?:号|日)"
)


def _has_date_range_signal(text: str) -> bool:
    """Return true only when a range connector actually joins two date tokens."""
    if re.search(r"(?:下下|下个|下一个|下|本|这|这个)?周末(?:两|二|2)?天?", text):
        return True
    if re.search(
        r"(?:(?:下下|下个|下一个|下|本|这|这个)?(?:周|星期|礼拜)"
        r"[一二三四五六日天1-7]"
        r"(?:[、,，和及跟\s]+(?:周|星期|礼拜)?[一二三四五六日天1-7]|[一二三四五六日天]))",
        text,
    ):
        return True
    matches = list(re.finditer(_DATE_TOKEN_PATTERN, text))
    for left, right in zip(matches, matches[1:]):
        if _is_likely_location_number(text, left) or _is_likely_location_number(text, right):
            continue
        between = text[left.end():right.start()]
        if re.search(r"(?:到|至|直到|[-—~～])", between):
            return True
        suffix = text[right.end():]
        if re.search(r"(?:和|跟|与|及|、)[，,\s]*$", between) and re.match(r"[，,\s]*之间", suffix):
            return True
    return False

_CONSECUTIVE_RELATIVE_RANGE_PATTERN = (
    r"(?:今明后(?:这)?(?:三|3)(?:天|日)|"
    r"今明(?:这)?(?:两|二|2)(?:天|日)|"
    r"明后(?:这)?(?:两|二|2)(?:天|日))"
)
_CONSECUTIVE_RELATIVE_PAIR_PATTERN = (
    r"(?:(?:大后天|后天|明天|今天|今日)(?:和|跟|与|及|、)"
    r"(?:大后天|后天|明天|今天|今日)(?:这?(?:两|二|2)(?:天|日))?)"
)


def _relative_day_offset(token: str) -> Optional[int]:
    return {
        "今天": 0,
        "今日": 0,
        "明天": 1,
        "后天": 2,
        "大后天": 3,
    }.get(token)


def _parse_consecutive_relative_date_ranges(text: str) -> list[tuple[int, tuple[date, date]]]:
    today = _current_date()
    ranges: list[tuple[int, tuple[date, date]]] = []
    for match in re.finditer(_CONSECUTIVE_RELATIVE_RANGE_PATTERN, text):
        token = match.group(0)
        start_offset = 1 if token.startswith("明后") else 0
        duration = 3 if token.startswith("今明后") else 2
        ranges.append((
            match.start(),
            (
                today + timedelta(days=start_offset),
                today + timedelta(days=start_offset + duration - 1),
            ),
        ))

    pair_pattern = re.compile(
        r"(?P<start>大后天|后天|明天|今天|今日)(?:和|跟|与|及|、)"
        r"(?P<end>大后天|后天|明天|今天|今日)(?:这?(?:两|二|2)(?:天|日))?"
    )
    for match in pair_pattern.finditer(text):
        start_offset = _relative_day_offset(match.group("start"))
        end_offset = _relative_day_offset(match.group("end"))
        if start_offset is None or end_offset is None or end_offset - start_offset != 1:
            continue
        ranges.append((
            match.start(),
            (
                today + timedelta(days=start_offset),
                today + timedelta(days=end_offset),
            ),
        ))
    return ranges


def _named_calendar_ranges(text: str) -> list[tuple[int, tuple[date, date]]]:
    """Resolve spoken weekend and weekday pairs into explicit date ranges."""
    ranges: list[tuple[int, tuple[date, date]]] = []

    def weekday_occurrence(prefix: str, weekday: int) -> date:
        if prefix == "下下":
            return _weekday_in_week(weekday, 2)
        if prefix in {"下", "下个", "下一个"}:
            return _weekday_in_week(weekday, 1)
        if prefix in {"本", "这", "这个"}:
            return _next_weekday(weekday, include_today=True)
        return _next_weekday(weekday)

    weekend_pattern = re.compile(
        r"(?P<prefix>下下|下个|下一个|下|本|这|这个)?周末(?:两|二|2)?天?"
    )
    for match in weekend_pattern.finditer(text):
        prefix = match.group("prefix") or ""
        if prefix == "下下":
            start = _weekday_in_week(5, 2)
        elif prefix in {"下", "下个", "下一个"}:
            start = _weekday_in_week(5, 1)
        else:
            start = _next_weekday(5, include_today=True)
        ranges.append((match.start(), (start, start + timedelta(days=1))))

    weekday = r"[一二三四五六日天1-7]"
    patterns = (
        re.compile(
            rf"(?P<prefix>下下|下个|下一个|下|本|这|这个)?(?:周|星期|礼拜)"
            rf"(?P<start>{weekday})(?P<end>{weekday})"
        ),
        re.compile(
            rf"(?P<prefix>下下|下个|下一个|下|本|这|这个)?(?:周|星期|礼拜)"
            rf"(?P<start>{weekday})"
            rf"(?:[、,，和及跟\s]+)(?:周|星期|礼拜)?(?P<end>{weekday})"
        ),
    )
    seen: set[tuple[int, str, str]] = set()
    for pattern in patterns:
        for match in pattern.finditer(text):
            key = (match.start(), match.group("start"), match.group("end"))
            if key in seen:
                continue
            seen.add(key)
            prefix = match.group("prefix") or ""
            start_weekday = _WEEKDAY_MAP[match.group("start")]
            end_weekday = _WEEKDAY_MAP[match.group("end")]
            start = weekday_occurrence(prefix, start_weekday)
            delta = (end_weekday - start_weekday) % 7
            if delta == 0:
                continue
            ranges.append((match.start(), (start, start + timedelta(days=delta))))
    return ranges


def _parse_range_date_token(
    token: str,
    *,
    reference: date,
    context: Optional[date] = None,
) -> Optional[date]:
    """Keep unyear-qualified range endpoints in one plausible calendar year."""
    value = token.strip()
    month_day = re.fullmatch(
        r"([0-9一二两三四五六七八九十]{1,2})月"
        r"([0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        value,
    )
    month_end = re.fullmatch(
        r"([0-9一二两三四五六七八九十]{1,2})月(?:底|末)",
        value,
    )
    bare_day = re.fullmatch(
        r"([0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        value,
    )
    if month_day or month_end:
        match = month_day or month_end
        month = _cn_to_int(match.group(1))
        if not 1 <= month <= 12:
            return None
        # A range endpoint without a year is anchored to the request year.
        # Only the *end* endpoint is allowed to roll into the next year when
        # its month is earlier than the already parsed start month (the caller
        # passes that start as ``context``). Applying the usual "next future
        # occurrence" rule to the start itself turned a spoken reversed range
        # such as "7月21号到7月18号" in August into 2027 dates and hid the
        # ordering conflict from the clarification path.
        year = (
            context.year + int(month < context.month)
            if context is not None
            else reference.year
        )
        if month_day:
            day = _cn_to_int(match.group(2))
            if not 1 <= day <= calendar.monthrange(year, month)[1]:
                return None
        else:
            day = calendar.monthrange(year, month)[1]
        return date(year, month, day)
    if bare_day:
        month = context.month if context is not None else reference.month
        year = context.year if context is not None else reference.year
        day = _cn_to_int(bare_day.group(1))
        if not 1 <= day <= calendar.monthrange(year, month)[1]:
            return None
        return date(year, month, day)
    return _parse_date_token(value, context=context)


def _parse_date_range_unchecked(text: str) -> Optional[tuple[date, date]]:
    reference = _current_date()
    pattern = re.compile(rf"(?P<start>{_DATE_TOKEN_PATTERN})(?:开始)?(?:到|至|直到|[-—~～])(?P<end>{_DATE_TOKEN_PATTERN})")
    parsed_ranges = [
        *_parse_consecutive_relative_date_ranges(text),
        *_named_calendar_ranges(text),
    ]
    for match in pattern.finditer(text):
        if _is_likely_location_number(text, match):
            continue
        start = _parse_range_date_token(
            match.group("start"),
            reference=reference,
        )
        end = _parse_range_date_token(
            match.group("end"),
            reference=reference,
            context=start,
        )
        if start and end:
            parsed_ranges.append((match.start(), (start, end)))
    if not parsed_ranges:
        return None
    parsed_ranges.sort(key=lambda item: item[0])
    selected = parsed_ranges[-1] if _DATE_CORRECTION_RE.search(text) else parsed_ranges[0]
    return selected[1]


def _parse_date_range(text: str) -> Optional[tuple[date, date]]:
    parsed = _parse_date_range_unchecked(text)
    if parsed and parsed[1] >= parsed[0]:
        return parsed
    return None


def _implicit_long_cross_year_range_needs_confirmation(
    text: str,
    parsed_range: Optional[tuple[date, date]],
) -> bool:
    if not parsed_range:
        return False
    start, end = parsed_range
    if end.year <= start.year or (end - start).days <= _IMPLICIT_CROSS_YEAR_CONFIRM_DAYS:
        return False

    pattern = re.compile(
        rf"(?P<start>{_DATE_TOKEN_PATTERN})(?:开始)?(?:到|至|直到|[-—~～])(?P<end>{_DATE_TOKEN_PATTERN})"
    )
    matches = list(pattern.finditer(text))
    if not matches:
        return False
    selected = matches[-1] if _DATE_CORRECTION_RE.search(text) else matches[0]
    return not all(
        re.match(r"^[0-9]{4}年", selected.group(name))
        for name in ("start", "end")
    )


def _parse_date_token(token: str, context: Optional[date] = None) -> Optional[date]:
    token = token.strip()
    explicit_month_start = _parse_explicit_month_start(token, context=context)
    if explicit_month_start:
        return explicit_month_start
    explicit_month_end = _parse_explicit_month_end(token, context=context)
    if explicit_month_end:
        return explicit_month_end
    if context:
        if match := re.fullmatch(r"([0-9一二两三四五六七八九十]{1,3})(?:号|日)", token):
            day = _cn_to_int(match.group(1))
            year, month = context.year, context.month
            _, days_in_month = calendar.monthrange(year, month)
            if not 1 <= day <= days_in_month:
                return None
            candidate = date(year, month, day)
            if candidate < context:
                year = year + int(month == 12)
                month = 1 if month == 12 else month + 1
                if day > calendar.monthrange(year, month)[1]:
                    return None
                candidate = date(year, month, day)
            return candidate
        if match := re.fullmatch(r"([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)", token):
            month = _cn_to_int(match.group(1))
            day = _cn_to_int(match.group(2))
            year = context.year + int(month < context.month)
            if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(year, month)[1]:
                return None
            return date(year, month, day)
        if match := re.fullmatch(r"(?:周|星期|礼拜)([一二三四五六日天1-7])", token):
            weekday = _WEEKDAY_MAP[match.group(1)]
            delta = weekday - context.weekday()
            if delta < 0:
                delta += 7
            return context + timedelta(days=delta)
    return _parse_explicit_or_relative_date(token)


def _parse_relative_offset_datetime(text: str) -> Optional[datetime]:
    normalized = _normalize_schedule_text(text)
    now = _current_datetime().replace(second=0, microsecond=0)
    suffix = r"(?:之后|以后|后)"
    if re.search(rf"半(?:个)?小时{suffix}", normalized):
        return now + timedelta(minutes=30)
    if re.search(rf"一刻钟{suffix}", normalized):
        return now + timedelta(minutes=15)
    if match := re.search(rf"([0-9一二两三四五六七八九十]{{1,3}})分钟{suffix}", normalized):
        return now + timedelta(minutes=max(1, _cn_to_int(match.group(1))))
    if match := re.search(rf"([0-9一二两三四五六七八九十]{{1,3}})(?:个)?小时{suffix}", normalized):
        return now + timedelta(hours=max(1, _cn_to_int(match.group(1))))
    if match := re.search(rf"([0-9一二两三四五六七八九十]{{1,2}})刻钟{suffix}", normalized):
        return now + timedelta(minutes=max(1, _cn_to_int(match.group(1))) * 15)
    return None


def _parse_vague_next_month_start(text: str) -> Optional[date]:
    normalized = _normalize_schedule_text(text)
    if "每月" in normalized or "每个月" in normalized:
        return None
    if "下个月底" in normalized or "下个月末" in normalized or "下月底" in normalized or "下月末" in normalized:
        return None
    if "下个月" not in normalized and "下月" not in normalized:
        return None
    if re.search(r"下(?:个)?月[0-9一二两三四五六七八九十]{1,3}(?:号|日)", normalized):
        return None
    today = _current_date()
    year = today.year + int(today.month == 12)
    month = 1 if today.month == 12 else today.month + 1
    return date(year, month, 1)


def _has_fuzzy_period_without_clock(text: str) -> bool:
    normalized = _normalize_schedule_text(text)
    if not re.search(r"(凌晨|早上|上午|中午|下午|晚上|晚间)", normalized):
        return False
    return re.search(r"([0-9一二两三四五六七八九十]{1,3}点|[0-9]{1,2}[:：][0-9]{2}|半)", normalized) is None


def _normalize_optional_text(value: object, *, limit: int) -> Optional[str]:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text or text.lower() == "null":
        return None
    return text[:limit]


def _wants_no_reminder(text: str) -> bool:
    return bool(re.search(r"(不提醒|无需提醒|不用提醒|不需要提醒|不要提醒)", _normalize_schedule_text(text)))


def _is_explicit_all_day(text: str) -> bool:
    """Only mark an event all-day when the user explicitly says so."""
    return bool(re.search(r"(?:全天|整天|一整天|全日|从早到晚)", _normalize_schedule_text(text)))


def _normalize_reminder_minutes(value: object) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return None
    if minutes < 0:
        return None
    return min(minutes, 30 * 24 * 60)


def _parse_reminder_minutes(text: str) -> Optional[int]:
    if _wants_no_reminder(text):
        return None
    if re.search(r"(开始时|准时|到点)提醒", text):
        return 0
    if match := re.search(r"提前([0-9一二两三四五六七八九十]{1,3})分钟提醒", text):
        return max(0, _cn_to_int(match.group(1)))
    if re.search(r"提前半小时提醒", text):
        return 30
    if match := re.search(r"提前([0-9一二两三四五六七八九十]{1,3})小时提醒", text):
        return max(0, _cn_to_int(match.group(1)) * 60)
    if match := re.search(r"提前([0-9一二两三四五六七八九十]{1,3})天提醒", text):
        return max(0, _cn_to_int(match.group(1)) * 24 * 60)
    return None


_LOCATION_TOKEN_PATTERN = (
    r"(?:[^，,。.!！?？；;]{0,20}[A-Za-z]{1,4}[-_]?\d{1,4}(?:室|房间)?|"
    r"[^，,。.!！?？；;]{0,24}?(?:会议室|办公室|图书馆|健身房|咖啡馆|咖啡店|"
    r"实验室|教室|报告厅|写字楼|大厦|商场|超市|机场|车站|公司|学校|医院|"
    r"公园|餐厅|饭店|酒店|园区|小区|广场|中心|工作室|体育馆|体育场|球场|"
    r"码头|港口|校区|现场|路|街|巷|室|厅|楼|馆|院|门|站|店|家))"
)
_LOCATION_LOCALIZER_PATTERN = r"(?:里面|里|内|外|附近|门口|旁边|楼上|楼下|前台|大厅|现场|口)?"
_LOCATION_ACTION_PATTERN = (
    r"(?:开会|召开|举行|进行|参加|安排|计划|创建|处理|完成|提交|整理|跟进|准备|复盘|讨论|沟通|"
    r"确认|评审|汇报|学习|复习|上课|考试|培训|阅读|跑步|健身|运动|体检|看病|"
    r"服药|聚餐|约会|吃饭|购物|购买|买|取|领取|寄|打印|缴|交|支付|还款|报销|"
    r"拜访|会见|维护|检查|测试|发布|更新|制作|编写|练习|集合|出发|接待|签字|"
    r"排队|取号|见面|接|送|办理|预约)"
)
_LOW_INFORMATION_SCHEDULE_INTENT_RE = re.compile(
    r"(安排|创建|日程|待办|提醒|开会|会议|周会|评审|复盘|汇报|面试|值班|提交|跟进|维护|发布|更新|编写|打印|签字|"
    r"回复邮件|发邮件|联系|打电话|学习|复习|上课|课程|考试|作业|论文|阅读|培训|答辩|练习|"
    r"跑步|健身|运动|体检|看病|复诊|服药|吃药|预约牙医|预约体检|睡觉|喝水|聚餐|约会|"
    r"生日|婚礼|见面|拜访|会见|吃饭|看电影|出发|出差|旅行|航班|高铁|火车|值机|接机|"
    r"送机|缴费|交费|(?:缴|交)(?:水电费|物业费|停车费|报名费|社保|房租)|"
    r"还款|付款|支付|报销|账单|转账|购物|买菜|买药|买票|取快递|取票|"
    r"取号|领取|寄快递|寄文件|快递|洗衣|理发|大扫除|修空调|办理|预约|接待|集合|排队|"
    r"讨论|沟通|整理(?:房间|衣柜|材料|文件|报告|发票|数据|照片|行李)|"
    r"处理(?:事项|工单|问题|材料|文件|订单)|准备(?:材料|会议|考试|报告|行李|方案)|"
    r"(?:有个|先留着|先放着|先记着|想约个|想做|准备|先把|记个|记一下)[^。.!！?？；;]{0,100}?"
    r"(?:时间|日期|几点|具体时间|具体日期|回头补|留个位置|留点时间)[^。.!！?？；;]{0,24}?"
    r"(?:还没|没定|没想好|再说|回头补|再看|留个位置|留点时间)|"
    r"[^。.!！?？；;]{1,80}(?:先留着|先放着|先记着|不用留了|时间再说|等会儿定时间))"
)
_LOCATION_WITH_ACTION_RE = re.compile(
    rf"(?:在|去|到|往|地点(?:是|为|去)?|地址(?:是|为|去)?)\s*"
    rf"(?P<location>{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})\s*"
    rf"(?P<action>{_LOCATION_ACTION_PATTERN}[^，,。.!！?？；;]{{0,40}})"
)
_INFERRED_LOCATION_RE = re.compile(
    rf"在\s*(?P<location>{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})"
    rf"(?=\s*(?:{_LOCATION_ACTION_PATTERN}|[，,。.!！?？；;]|$))"
)
_DESTINATION_CONTEXT_RE = re.compile(
    rf"(?P<location>{_LOCATION_TOKEN_PATTERN})(?P<place_suffix>门口)?(?:那边|附近|门口)"
    rf"(?=[^，,。.!！?？；;]{{0,24}}(?:安排|计划|进行|做|处理|参加|开会|会议|提交|取|领取|拜访|复盘|检查))"
)


def _extract_location_action(text: str) -> Optional[tuple[str, str]]:
    match = _LOCATION_WITH_ACTION_RE.search(text)
    if not match:
        return None
    location = re.sub(r"^(?:去|到|往)", "", match.group("location")).strip("，,。.!！?？；;的 ")
    action = match.group("action").strip("，,。.!！?？；;的 ")
    # A broad location token can otherwise consume the schedule slots in
    # phrases such as "在明天下午两点加个事项".  A real venue may contain
    # digits (A301), but it must not contain a date or clock expression.
    if not location or not action or _location_candidate_has_schedule_slot(location):
        return None
    return location, action


def _location_candidate_has_schedule_slot(value: str) -> bool:
    """Return whether a location candidate actually contains date/time text."""
    candidate = value.strip()
    if not candidate:
        return False
    if re.search(_DATE_TOKEN_PATTERN, candidate) or re.search(_TIME_TOKEN_PATTERN, candidate):
        return True
    return _parse_relative_offset_datetime(candidate) is not None


def _extract_location(text: str) -> Optional[str]:
    # When a spoken correction explicitly moves the event, the final location
    # is authoritative.  Resolve that clause before considering the original
    # "在..." location.
    correction = re.search(
        r"(?:改到|换到|调整到|地点改为|地址改为)\s*"
        r"(?P<location>[^，,。.!！?？；;]{1,100})",
        text,
    )
    if correction:
        candidate = correction.group("location").strip("，,。.!！?？的 ")
        # “改到明天下午一点” is a date/time correction, not a venue.  Only
        # accept the correction branch when the candidate is location-like and
        # does not contain an independent date or clock token.
        if (
            candidate
            and not _location_candidate_has_schedule_slot(candidate)
            and re.search(_LOCATION_TOKEN_PATTERN, candidate)
        ):
            return candidate[:100]
    location_action = _extract_location_action(text)
    if location_action:
        return re.sub(r"^(?:去|到|往)", "", location_action[0]).strip("，,。.!！?？的 ")[:100]

    attributive_pattern = re.compile(
        rf"在\s*(?P<location>{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})\s*的"
        rf"(?=[^，,。.!！?？；;]{{1,40}}$)"
    )
    for attributive in attributive_pattern.finditer(text):
        candidate = attributive.group("location").strip("，,。.!！?？的 ")
        if candidate and not _location_candidate_has_schedule_slot(candidate):
            return candidate[:100]

    destination = _DESTINATION_CONTEXT_RE.search(text)
    if destination:
        candidate = (
            destination.group("location") + (destination.group("place_suffix") or "")
        ).strip("，,。.!！?？的 ")
        if not _location_candidate_has_schedule_slot(candidate):
            return candidate[:100]

    trailing_destination = re.search(
        rf"(?:^|[，,])\s*(?:去|到|往)\s*(?P<location>{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})"
        rf"\s*$",
        text,
    )
    if trailing_destination:
        candidate = trailing_destination.group("location").strip("，,。.!！?？的 ")
        if not _location_candidate_has_schedule_slot(candidate):
            return candidate[:100]

    explicit = re.search(
        rf"(?:地点|地址)\s*(?:在|是|为|位于)\s*(?P<location>[^，,。.!！?？；;]{{1,100}})",
        text,
    )
    if not explicit:
        explicit = re.search(
            rf"(?:地点|地址)\s*(?P<location>{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})",
            text,
        )
    match = explicit or _INFERRED_LOCATION_RE.search(text)
    if not match:
        return None
    location = match.group("location").strip("，,。.!！?？的") if "location" in match.groupdict() else match.group(1).strip("，,。.!！?？的")
    location = re.sub(r"^(?:去|到|往)", "", location).strip("，,。.!！?？的 ")
    if _location_candidate_has_schedule_slot(location):
        return None
    # A room such as "青松一号室" contains the glyph "号" but is a valid
    # location.  Only reject a candidate that is itself a complete temporal
    # token; broad single-glyph guards silently dropped numbered rooms.
    if (
        re.fullmatch(rf"(?:{_DATE_TOKEN_PATTERN})", location)
        or re.fullmatch(rf"(?:{_TIME_TOKEN_PATTERN})", location)
    ):
        return None
    return location[:100] or None


_CATEGORY_RULES = [
    ("重要", r"(重要|截止|紧急|到期|必须|尽快|加急|最终版|回滚|风险|护照过期|证书到期|ddl|DDL|deadline|Deadline)"),
    ("学习", r"(学习|复习|上课|课程|考试|作业|论文|阅读|培训|背单词|公开课|文献|答辩|实验报告|模拟考试|资格考试|读书会|听力|算法课|统计学)"),
    ("工作", r"(工作|上班|会议|开会|周会|周报|项目|评审|复盘|复核|需求|汇报|报告|预算|系统维护|检查服务器|客户|合同|供应商|产品方案|设计稿|接口联调|测试用例|上线|投标|库存|数据报表|值班|招聘|面试)"),
    ("健康", r"(健康|健身|运动|跑步|训练|复诊|体检|看病|服药|吃药|买药|牙医|眼科|康复|疫苗|心理咨询|睡眠|血压|游泳|瑜伽)"),
    ("出行", r"(出行|出发|旅行|旅游|交通|航班|飞机|高铁|火车|车票|机票|打车|坐车|出差|机场|车站|酒店|值机|行李|路线|租车|签证|景点|退票|换乘|行程|接机)"),
    ("财务", r"(财务|钱|付款|付钱|支付|缴费|交费|还款|账单|发票|报销|工资|收入|贷款|房贷|信用卡|房租|社保|转账|收款|退款|保险|停车费|物业费|水电费|报名费)"),
    ("社交", r"(社交|聚餐|约会|朋友|生日|同学|家庭晚饭|咖啡|电影|婚礼|爸妈|约球|读书沙龙|社区活动|送别|亲戚)"),
    ("生活", r"(生活|家务|购物|买|取|家|个人|快递|睡觉|喝水|大扫除|理发|修空调|手机膜|加油|洗衣|买菜|猫粮|寄文件|证件照|整理房间|整理衣柜|物业)"),
]
_CATEGORY_SET = {category for category, _ in _CATEGORY_RULES}
_DEFAULT_CATEGORY = "其他"
_EXPLICIT_CATEGORY_RE = re.compile(
    r"(?:分类|类别|类型)\s*(?:设为|设成|定为|改为|写成|叫作|叫做|是|为)"
    r"\s*(工作|学习|健康|生活|社交|出行|财务|重要|其他)"
)
_RELATIVE_REMINDER_RE = re.compile(
    r"[0-9一二两三四五六七八九十]{1,3}(?:分钟|小时|刻钟)(?:之后|以后|后)\s*(?:提醒我|提醒|叫我)"
)
_CATEGORY_LOCATION_CLAUSE_RE = re.compile(
    r"(?:地点|地址|位置)\s*(?:在|是|为|位于)?[^，,。.!！?？；;]+|"
    r"在[^，,。.!！?？；;]{0,24}(?:会议室|办公室|图书馆|健身房|咖啡馆|咖啡店|实验室|教室|报告厅|机场|车站|医院|公园|餐厅|酒店|体育馆|体育场|球场|大厅|路演厅|讨论室|一号室|二号室|三号室|四号室|五号室)"
    r"(?:里面|里|内|附近|门口|旁边|楼上|楼下)?"
)


def _infer_category(title: str, text: str) -> str:
    title = title or ""
    # The title describes the event itself; the remaining sentence often contains
    # unrelated locations or participants (for example "在健身房缴水电费").
    explicit = _EXPLICIT_CATEGORY_RE.search(f"{title}，{text}")
    if explicit:
        return explicit.group(1)
    if _RELATIVE_REMINDER_RE.search(text):
        return "重要"
    if re.search(_CATEGORY_RULES[0][1], f"{title}，{text}"):
        return "重要"
    category_text = _CATEGORY_LOCATION_CLAUSE_RE.sub("", text)
    for category, pattern in _CATEGORY_RULES:
        if re.search(pattern, title):
            return category
    for category, pattern in _CATEGORY_RULES:
        if re.search(pattern, category_text):
            return category
    return _DEFAULT_CATEGORY


def _normalize_category(value: object, *, title: str, raw_text: str) -> str:
    explicit = _EXPLICIT_CATEGORY_RE.search(raw_text)
    if explicit:
        return explicit.group(1)
    inferred = _infer_category(title, raw_text)
    # Spoken domain cues outrank a model's generic category.  A small model
    # frequently labels birthday/health/finance utterances as "生活" even
    # though the surface text contains an unambiguous domain term.
    if inferred != _DEFAULT_CATEGORY:
        return inferred
    category = _normalize_optional_text(value, limit=50)
    if category in _CATEGORY_SET and category != _DEFAULT_CATEGORY:
        return category
    if category in _CATEGORY_SET:
        return category
    return _infer_category(title, f"{category or ''}{raw_text}")


def _normalize_recurrence_expression(text: str) -> str:
    """Remove only sparse ASR fillers that split an otherwise explicit repeat marker."""
    normalized = re.sub(
        r"每[，,]*(?:额|呃|嗯|那个|可能)?[，,]*(年|月|周|星期|礼拜)",
        r"每\1",
        text,
    )
    return re.sub(
        r"((?:每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?周|每(?:周|星期|礼拜)))"
        r"[，,]*(?:额|呃|嗯|那个|可能)[，,]*",
        r"\1",
        normalized,
    )


def _recurrence_weekdays(text: str) -> list[int]:
    """Extract an explicit weekly weekday set as ISO values (Mon=1..Sun=7)."""
    normalized = _normalize_recurrence_expression(text)
    if re.search(r"(?:每(?:个)?工作日|每周工作日|工作日(?:重复|安排))", normalized):
        return [1, 2, 3, 4, 5]
    if re.search(r"(?:每(?:个)?周末|周末(?:重复|安排))", normalized):
        return [6, 7]

    anchor = re.search(r"(?:每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)|"
                       r"(?:周|星期|礼拜))", normalized)
    if not anchor:
        return []
    suffix = normalized[anchor.end():]
    suffix = re.sub(r"^(?:周|星期|礼拜)", "", suffix)
    weekday = r"[一二三四五六日天1-7]"
    # “每周一到周五” and “每周一至星期五”.
    range_match = re.match(
        rf"({weekday})(?:到|至)(?:(?:周|星期|礼拜))?({weekday})",
        suffix,
    )
    if range_match:
        start = _WEEKDAY_MAP[range_match.group(1)]
        end = _WEEKDAY_MAP[range_match.group(2)]
        if start <= end:
            return [value + 1 for value in range(start, end + 1)]
        return [value + 1 for value in list(range(start, 7)) + list(range(0, end + 1))]

    list_match = re.match(
        rf"({weekday}(?:[、,，和及\s]+{weekday}){{0,6}})",
        suffix,
    )
    compact_match = re.match(r"([一二三四五六日天]{2,7})", suffix)
    # The separator form also matches the first character of a compact form
    # (for example “一三五”). Prefer the longest candidate so no weekday is
    # silently discarded.
    candidates = [match.group(1) for match in (list_match, compact_match) if match]
    source = max(candidates, key=len, default="")
    if not source:
        return []
    values = [_WEEKDAY_MAP[char] + 1 for char in re.findall(weekday, source)]
    return sorted(set(values))


def _recurrence_interval(text: str, event_type: str) -> int:
    normalized = _normalize_recurrence_expression(text)
    if event_type == "weekly":
        match = re.search(
            r"每隔([一二两三四五六七八九十0-9]+)周|"
            r"每([一二两三四五六七八九十0-9]+)周|隔周",
            normalized,
        )
        if match:
            if "隔周" in match.group(0):
                return 2
            return max(2, _cn_to_int(match.group(1) or match.group(2)))
    if event_type == "monthly":
        match = re.search(r"每隔([一二两三四五六七八九十0-9]+)个月|每([一二两三四五六七八九十0-9]+)个月", normalized)
        if match:
            return max(1, _cn_to_int(match.group(1) or match.group(2)))
    if event_type == "yearly":
        match = re.search(r"每隔([一二两三四五六七八九十0-9]+)年|每([一二两三四五六七八九十0-9]+)年", normalized)
        if match:
            return max(1, _cn_to_int(match.group(1) or match.group(2)))
    return 1


def _recurrence_until_date(text: str) -> Optional[date]:
    normalized = _normalize_recurrence_expression(text)
    date_pattern = (
        r"(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月"
        r"(?:[0-9一二两三四五六七八九十]{1,3}(?:号|日)|底|末)"
        r"|(?:下个月底|下个月末|下月底|下月末|月底|月末)"
    )
    match = re.search(rf"(?:重复|持续|一直)?(?:到|至|直到|截至|截止)(?:日期)?({date_pattern})", normalized)
    if not match:
        return None
    return _parse_explicit_or_relative_date(match.group(1))


def _parse_recurrence_rule(text: str) -> dict:
    """Parse recurrence semantics shared by quick and LLM normalization paths."""
    normalized = _normalize_recurrence_expression(text)
    if not _RECURRENCE_MARKER_RE.search(normalized):
        return {
            "event_type": "once",
            "interval": 1,
            "weekdays": None,
            "until_date": None,
            "unsupported": False,
        }

    if _RECURRENCE_EXCLUSION_RE.search(normalized) or re.search(
        r"每(?:个)?月(?:最后(?:一个)?工作日|第[一二三四五六七八九十0-9]+周|周[一二三四五六日天])",
        normalized,
    ):
        return {
            "event_type": "once",
            "interval": 1,
            "weekdays": None,
            "until_date": None,
            "unsupported": True,
        }

    if re.search(r"(?:每天|每日|每一天|每一日)", normalized):
        return {
            "event_type": "daily",
            "interval": 1,
            "weekdays": None,
            "until_date": _recurrence_until_date(normalized),
            "unsupported": False,
        }

    weekdays = _recurrence_weekdays(normalized)
    if weekdays:
        return {
            "event_type": "weekly",
            "interval": _recurrence_interval(normalized, "weekly"),
            "weekdays": weekdays,
            "until_date": _recurrence_until_date(normalized),
            "unsupported": False,
        }

    if re.search(r"(?:每(?:隔)?[一二两三四五六七八九十0-9]+个月|每(?:个)?月)", normalized) and (
        re.search(
            r"(?:每(?:隔)?[一二两三四五六七八九十0-9]+个月|每(?:个)?月)[0-9一二两三四五六七八九十]{1,3}(?:号|日)",
            normalized,
        )
        or re.search(r"(?:每(?:隔)?[一二两三四五六七八九十0-9]+个月|每(?:个)?月)(?:月初|月末|月底)", normalized)
    ):
        return {
            "event_type": "monthly",
            "interval": _recurrence_interval(normalized, "monthly"),
            "weekdays": None,
            "until_date": _recurrence_until_date(normalized),
            "unsupported": False,
        }

    # “每周都要” is a valid weekly cadence even though it omits a weekday.
    # Keep the weekday field empty so the editor can choose one later; do not
    # downgrade it to an unsupported rule or a one-off event.
    if re.search(r"每周(?:的|都要|都得|都安排|都留|固定)?", normalized):
        return {
            "event_type": "weekly",
            "interval": 1,
            "weekdays": None,
            "until_date": _recurrence_until_date(normalized),
            "unsupported": False,
        }

    if re.search(
        r"(?:每年|每(?:隔)?[一二两三四五六七八九十0-9]+年)[0-9一二两三四五六七八九十]{1,2}月"
        r"[0-9一二两三四五六七八九十]{1,3}(?:号|日)",
        normalized,
    ):
        return {
            "event_type": "yearly",
            "interval": _recurrence_interval(normalized, "yearly"),
            "weekdays": None,
            "until_date": _recurrence_until_date(normalized),
            "unsupported": False,
        }

    return {
        "event_type": "once",
        "interval": 1,
        "weekdays": None,
        "until_date": None,
        "unsupported": True,
    }


def _remove_title_surface(text: str, title: str) -> str:
    """Remove one exact title occurrence before parsing temporal slots."""
    candidate = (title or "").strip()
    if not candidate or candidate == "待办":
        return text
    return text.replace(candidate, "", 1)


def _parse_schedule_text_quick(text: str) -> Optional[dict]:
    """解析高频中文日程口令，避免简单任务也等待大模型。"""
    normalized = _normalize_schedule_text(text)
    if not normalized:
        return None

    # Words such as "周末" and "月底" can be part of the event title.  Title
    # extraction must happen before slot extraction so those lexical words do
    # not override the actual date later in the utterance.
    full_text_time_range = _parse_time_range(normalized)
    title, description = _extract_title_and_description(normalized)
    if full_text_time_range and title:
        title = re.sub(r"(?:到|至|直到)$", "", title).strip()
    if not title:
        title = None
    semantic_text = _remove_title_surface(normalized, title)

    if _has_invalid_explicit_date(semantic_text):
        fallback = _parse_low_information_note(normalized, text)
        if fallback is None:
            fallback = _parse_low_information_note(
                f"记一下{title or '日程'}",
                text,
            )
            if fallback is None:
                return None
            fallback["description"] = description[:500] if description else None
            fallback["detail"] = description[:1000] if description else None
        fallback["start_date"] = ""
        fallback["end_date"] = None
        fallback["spanning"] = False
        parsed_time = _parse_time(semantic_text)
        if parsed_time:
            fallback["start_time"] = parsed_time
            fallback["end_time"] = _default_end_time(parsed_time)
            fallback["is_all_day"] = False
            reminder = _parse_reminder_minutes(normalized)
            fallback["reminder_minutes"] = (
                15 if reminder is None and not _wants_no_reminder(normalized) else reminder
            )
        fallback["needs_clarification"] = True
        fallback["clarification_question"] = "未能确定有效日期，需要补充日期。"
        fallback["confidence"] = 0.0
        return fallback

    event_type = "once"
    recurrence_text = _normalize_recurrence_expression(semantic_text)
    recurrence_rule = _parse_recurrence_rule(recurrence_text)
    event_type = recurrence_rule["event_type"]
    recurrence_interval = recurrence_rule["interval"]
    recurrence_weekdays = recurrence_rule["weekdays"]
    recurrence_until_date = recurrence_rule["until_date"]
    unsupported_recurrence = bool(recurrence_rule["unsupported"])
    parsed_range = _parse_date_range(semantic_text)
    weekday_selection_range = event_type == "weekly" and bool(recurrence_weekdays and len(recurrence_weekdays) > 1)
    if weekday_selection_range:
        parsed_range = None
    relative_start = None if parsed_range else _parse_relative_offset_datetime(semantic_text)
    implicit_long_range_needs_confirmation = _implicit_long_cross_year_range_needs_confirmation(
        semantic_text,
        parsed_range,
    )
    parsed_date = (
        parsed_range[0]
        if parsed_range
        else relative_start.date()
        if relative_start
        else _parse_authoritative_date(semantic_text)
    )
    end_date = parsed_range[1] if parsed_range else None
    if event_type == "daily":
        # A finite date range is a spanning event because the current schema has
        # no separate recurrence-until field. Open-ended daily events keep an
        # explicitly spoken start date instead of silently starting today.
        if parsed_date is None and re.search(
            r"(?:从(?:今天|明天|明日起|现在|此刻)开始|自(?:今天|明天|现在)起)",
            semantic_text,
        ):
            parsed_date = _current_date() + timedelta(
                days=1 if re.search(r"从明天|明日起", semantic_text) else 0
            )
    elif event_type == "weekly" and recurrence_weekdays:
        # An explicit anchor such as "从 2026 年 8 月 15 日起每周六" is
        # authoritative.  Recomputing the next weekday here used to replace
        # that user-provided start with the next occurrence relative to today.
        has_explicit_calendar_date = bool(re.search(
            r"(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月"
            r"[0-9一二两三四五六七八九十]{1,3}(?:号|日)",
            semantic_text,
        ))
        if not has_explicit_calendar_date:
            parsed_date = min(
                (_next_weekday(weekday - 1, include_today=True) for weekday in recurrence_weekdays),
                default=parsed_date,
            )
    elif event_type == "monthly" and (match := re.search(r"(?:每(?:个)?月|每(?:隔)?[一二两三四五六七八九十0-9]+个月)([0-9一二两三四五六七八九十]{1,3})(?:号|日)", recurrence_text)):
        day = max(1, min(31, _cn_to_int(match.group(1))))
        today = _current_date()
        year, month = today.year, today.month
        if day <= today.day or day > calendar.monthrange(year, month)[1]:
            month += 1
            if month == 13:
                year, month = year + 1, 1
        parsed_date = date(year, month, min(day, calendar.monthrange(year, month)[1]))
    elif event_type == "monthly":
        # A month-start/month-end recurrence has no single first occurrence
        # that should be forced into the one-off start_date field.
        parsed_date = _parse_explicit_month_start(recurrence_text) or _parse_explicit_month_end(recurrence_text)
    elif event_type == "yearly" and (match := re.search(r"(?:每年|每(?:隔)?[一二两三四五六七八九十0-9]+年)([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)", recurrence_text)):
        month = max(1, min(12, _cn_to_int(match.group(1))))
        day = max(1, min(31, _cn_to_int(match.group(2))))
        today = _current_date()
        year = today.year + int(month < today.month or (month == today.month and day <= today.day))
        parsed_date = date(year, month, min(day, calendar.monthrange(year, month)[1]))

    parsed_time_range = full_text_time_range or _parse_time_range(semantic_text)
    parsed_time = (
        parsed_time_range[0]
        if parsed_time_range
        else relative_start.strftime("%H:%M")
        if relative_start
        else _parse_authoritative_time(semantic_text)
        if _DATE_CORRECTION_RE.search(semantic_text)
        else _parse_time(semantic_text)
    )
    ambiguous_clock = _has_unqualified_clock_ambiguity(semantic_text)
    if ambiguous_clock:
        parsed_time = None
    time_period = None if parsed_time else _parse_fuzzy_time_period(semantic_text)
    has_date = parsed_date is not None
    has_time = parsed_time is not None
    # Recurring requests without an anchor still carry a valid recurrence
    # rule. Keep that rule in the draft so the editor can ask for the first
    # date/time instead of downgrading the request to a one-off note.
    # A recurring event needs a first date, but a date-only yearly/weekly
    # event is still valid without a clock. Only a missing date blocks saving;
    # the 0239 weekly draft has neither date nor time and remains clarifiable.
    recurrence_missing_anchor = event_type != "once" and not has_date
    if not has_date and not has_time and event_type == "once":
        low_info_note = _parse_low_information_note(normalized, text)
        if low_info_note:
            if unsupported_recurrence:
                low_info_note.update(
                    {
                        "start_date": "",
                        "end_date": None,
                        "spanning": False,
                        "needs_clarification": True,
                        "clarification_question": "这个重复规则较复杂，不能自动简化，需要进入详细编辑确认。",
                        "confidence": 0.0,
                    }
                )
            return low_info_note
        return None

    start_time = parsed_time
    end_time = parsed_time_range[1] if parsed_time_range and parsed_time_range[1] else None
    if recurrence_until_date is not None and not unsupported_recurrence:
        end_date = recurrence_until_date
    elif event_type == "daily" and end_date is not None and not unsupported_recurrence:
        recurrence_until_date = end_date
    effective_end_date = end_date if end_date and end_date != (parsed_date or _current_date()) else None
    location = _extract_location(normalized)
    location_uncertain = bool(_UNCERTAIN_LOCATION_RE.search(normalized))
    if location_uncertain:
        # A candidate location is not saveable until the user confirms it.
        location = None
    # The v4 contract always exposed a concrete bucket.  ``其他`` is the
    # neutral category when neither the utterance nor the title carries a
    # domain cue; returning null here was a migration-only behavior change.
    category = _infer_category(title, normalized)
    reminder_minutes = _parse_reminder_minutes(normalized)
    if relative_start and re.search(r"(?:之后|以后|后)(?:提醒我|提醒|叫我)", semantic_text):
        reminder_minutes = 0
    elif start_time and reminder_minutes is None and not _wants_no_reminder(normalized):
        # Preserve the established editor default for timed events.  Explicit
        # reminders still win; an explicit no-reminder phrase remains null.
        reminder_minutes = 15
    dst_question = _dst_risk_question(parsed_date, start_time)
    unresolved_time = bool(
        re.search(
            r"(?:时间|钟点|几点)[^，,。.!！?？；;]{0,16}(?:还没|没定|未定|没想好|回头补|再看|再说)",
            normalized,
        )
    )
    is_all_day = start_time is None and time_period is None and (
        _is_explicit_all_day(normalized)
        or (has_date and not ambiguous_clock and not unresolved_time)
    )
    if start_time and not is_all_day and (
        end_time is None or end_time == start_time
    ):
        # Keep the one-hour default identical to the model normalization path.
        # A single spoken clock is a normal timed event even when the model
        # omitted or echoed the end time.
        end_time = _default_end_time(start_time)
    parsed_result = {
        "title": title[:100] if title else None,
        "event_type": event_type,
        "recurrence_interval": recurrence_interval,
        "recurrence_weekdays": recurrence_weekdays,
        "recurrence_until_date": recurrence_until_date.strftime("%Y-%m-%d") if recurrence_until_date else None,
        "start_date": parsed_date.strftime("%Y-%m-%d") if parsed_date else "",
        "end_date": effective_end_date.strftime("%Y-%m-%d") if effective_end_date else None,
        "color": None,
        "spanning": bool(effective_end_date),
        "start_time": start_time,
        "end_time": end_time,
        "time_period": time_period,
        "is_all_day": is_all_day,
        "description": description[:500] if description else None,
        "location": location,
        "category": category,
        "detail": description[:1000] if description else None,
        "status": None,
        "reminder_minutes": reminder_minutes,
        "raw_text": text,
        "parse_source": "rules",
        "confidence": _quick_confidence(
            has_date=has_date,
            has_time=has_time,
            title=title,
            event_type=event_type,
        ),
        "needs_clarification": (
            dst_question is not None
            or location_uncertain
            or ambiguous_clock
            or
            implicit_long_range_needs_confirmation
            or unsupported_recurrence
            or unresolved_time
            or not title
            or (event_type == "once" and not has_date)
            # A cadence plus a clock is a valid reusable weekly draft even
            # when the weekday/first date is left for the editor.  The old v4
            # path kept this as non-blocking and retained the ordinary
            # missing-date question for display.
            or (recurrence_missing_anchor and not has_time)
        ),
        "clarification_question": (
            dst_question
            if dst_question
            else (
                "地点还不确定，需要确认最终地点。"
                if location_uncertain
                else (
                        "这个重复规则较复杂，不能自动简化，需要进入详细编辑确认。"
                        if unsupported_recurrence
                        else (
                            "时间还没有确定，需要补充具体时间。"
                            if unresolved_time
                            else (
                                "五点等钟点没有说明上午还是下午，需要确认具体时段。"
                                if ambiguous_clock
                                else (
                                "需要补充要提醒的事项。"
                                if not title
                                else (
                                (
                                    f"结束日期按 {effective_end_date.strftime('%Y-%m-%d')} 处理会形成跨年长日程，"
                                    "需要确认年份和起止顺序。"
                                )
                                if implicit_long_range_needs_confirmation and effective_end_date
                                else (
                                    _quick_clarification_question(
                                        has_date=has_date,
                                        has_time=has_time,
                                    )
                                    if recurrence_missing_anchor and has_time
                                    else (
                                        "需要补充重复日程的首次日期和时间。"
                                        if recurrence_missing_anchor and not has_date and not has_time
                                        else (
                                            "需要补充重复日程的首次日期。"
                                            if recurrence_missing_anchor
                                            else _quick_clarification_question(
                                                has_date=has_date,
                                                has_time=has_time,
                                            )
                                        )
                                    )
                                )
                                )
                                )
                            )
                        )
                )
            )
        ),
    }
    # Do not erase the lightweight missing-date question when a weekly cadence
    # has a clock but no weekday.  This is informational in v4 (needs=false),
    # not a blocking clarification request.
    if unsupported_recurrence:
        parsed_result.update(
            {
                "event_type": "once",
                "recurrence_interval": 1,
                "recurrence_weekdays": None,
                "recurrence_until_date": None,
                "start_date": "",
                "end_date": None,
                "spanning": False,
                "confidence": 0.0,
            }
        )
    return parsed_result


def _deterministic_complex_fallback(text: str) -> Optional[dict]:
    """Recover a safe structured draft when model output is absent.

    This is intentionally narrow: it only reuses the deterministic parser for
    utterances with an explicit date/time or scheduling intent, and it never
    turns a reversed range into a saveable end date.
    """
    normalized = _normalize_schedule_text(text)
    has_signal = (
        _has_date_signal(normalized)
        or bool(re.search(_TIME_TOKEN_PATTERN, normalized))
        or bool(_LOW_INFORMATION_SCHEDULE_INTENT_RE.search(normalized))
    )
    if not has_signal:
        return None
    parsed = _parse_schedule_text_quick(text)
    if parsed is None:
        return None

    spoken_range = _parse_date_range_unchecked(normalized)
    if spoken_range:
        start, end = spoken_range
        parsed["start_date"] = start.strftime("%Y-%m-%d")
        if end < start:
            parsed["end_date"] = None
            parsed["spanning"] = False
            parsed["needs_clarification"] = True
            parsed["clarification_question"] = (
                "起始日期的先后顺序有矛盾，需要确认正确的开始日期和结束日期。"
            )
        elif end == start and re.search(
            r"(?:别|不要|不能|不应|不想)[^，,。；;]{0,12}"
            r"(?:只|仅)[^，,。；;]{0,8}(?:一天|一日|单日)",
            normalized,
        ):
            parsed["end_date"] = None
            parsed["spanning"] = False
            parsed["needs_clarification"] = True
            parsed["clarification_question"] = (
                "两个日期按当前日期计算落在同一天，但原文要求不是单日，需要确认结束日期。"
            )
    if _UNSUPPORTED_RECURRENCE_RE.search(normalized):
        parsed["event_type"] = "once"
        parsed["start_date"] = ""
        parsed["end_date"] = None
        parsed["spanning"] = False
        parsed["needs_clarification"] = True
        parsed["clarification_question"] = "这个重复规则较复杂，不能自动简化，需要进入详细编辑确认。"
    return parsed


def _quick_confidence(*, has_date: bool, has_time: bool, title: str, event_type: str) -> float:
    confidence = 0.82
    if has_date:
        confidence += 0.08
    if has_time:
        confidence += 0.06
    if title and title != "待办":
        confidence += 0.04
    if event_type != "once":
        confidence += 0.03
    return min(0.97, confidence)


def _quick_clarification_question(*, has_date: bool, has_time: bool) -> Optional[str]:
    if not has_date and not has_time:
        return "需要补充具体日期。"
    if not has_date:
        return "没有听到具体日期，需要补充日期。"
    return None


def _parse_low_information_note(normalized: str, raw_text: str) -> Optional[dict]:
    if not (
        re.search(r"(记一下|记个|帮我记|提醒我|待办|想约个|想做|准备|先把|先记着|先留着|先放着)", normalized)
        or _CREATE_IMPERATIVE_RE.search(normalized)
        or _LOW_INFORMATION_SCHEDULE_INTENT_RE.search(normalized)
    ):
        return None
    title, description = _extract_title_and_description(normalized)
    # Keep the user-visible title and the concrete v4 category bucket even
    # when the date/time is still missing.  This draft is intentionally
    # all-day-looking so the editor can fill the missing date later.
    title = title[:100] if title else None
    category = _infer_category(title, normalized)
    return {
        "title": title,
        "event_type": "once",
        "recurrence_interval": 1,
        "recurrence_weekdays": None,
        "recurrence_until_date": None,
        "start_date": "",
        "end_date": None,
        "color": None,
        "spanning": False,
        "start_time": None,
        "end_time": None,
        "is_all_day": True,
        "description": description[:500] if description else None,
        "location": None,
        "category": category,
        "detail": description[:1000] if description else None,
        "status": None,
        "reminder_minutes": None,
        "raw_text": raw_text,
        "parse_source": "rules",
        "confidence": 0.45,
        "needs_clarification": True,
        "clarification_question": "没有听到具体日期，需要补充日期。",
    }


_LAOJI_WAKE_WORD = r"(?:老记|老纪|老计|老季|牢记|小记)"


def normalize_laoji_transcript(text: str) -> str:
    """纠正老记唤醒词的常见同音 ASR 误写，只处理句首连续唤醒词。"""
    cleaned = (text or "").strip()
    if not cleaned:
        return cleaned
    pattern = rf"^((?:{_LAOJI_WAKE_WORD}[，,。\s]*){{1,2}})"
    match = re.match(pattern, cleaned)
    if not match:
        return cleaned
    normalized_prefix = re.sub(_LAOJI_WAKE_WORD, "老记", match.group(1))
    return normalized_prefix + cleaned[match.end():]


def _schedule_asr_text(payload: object) -> Optional[str]:
    """Extract only a plain string from an ASR response; reject structured text."""
    if not isinstance(payload, dict):
        return None
    text = payload.get("text")
    if not isinstance(text, str):
        return None
    text = text.strip()
    return text or None


def _normalize_schedule_text(text: str) -> str:
    text = normalize_laoji_transcript(text)
    cleaned = text.strip()
    # Common Traditional-Chinese ASR glyphs carry the same spoken tokens.
    # Normalize them before date/time regexes so a regional keyboard or ASR
    # model does not fall through to the missing-date path.
    cleaned = cleaned.translate(str.maketrans({
        "週": "周",
        "點": "点",
        "號": "号",
        "後": "后",
        "這": "这",
        "禮": "礼",
        "賓": "宾",
        "復": "复",
        "習": "习",
        "預": "预",
        "約": "约",
        "體": "体",
        "檢": "检",
        "買": "买",
        "鐵": "铁",
        "發": "发",
        "繳": "缴",
        "水": "水",
        "電": "电",
        "費": "费",
        "緊": "紧",
        "急": "急",
        "記": "记",
        "錄": "录",
        "靈": "灵",
        "閱": "阅",
        "讀": "读",
        "課": "课",
        "程": "程",
        "聯": "联",
        "審": "审",
        "評": "评",
    }))
    cleaned = re.sub(rf"^{_LAOJI_WAKE_WORD}[，,。\s]*(?:{_LAOJI_WAKE_WORD})?[，,。\s]*", "", cleaned)
    cleaned = re.sub(r"\s+", "", cleaned)
    # ASR commonly emits a short discourse filler before the actual command.
    # Remove it only at the sentence head and only when punctuation or a clear
    # scheduling token follows, so a lexical title such as “那个项目” remains.
    leading_filler = r"^(?:(?:嗯|呃|额|那个|然后|就是)(?:[，,。.!！?？]+|(?=(?:每|今天|明天|后天|大后天|下(?:周|个月)|本(?:周|月)|安排|记|提醒))))+"
    cleaned = re.sub(leading_filler, "", cleaned)
    cleaned = re.sub(
        r"[，,]*(?:呃|额|嗯|那个|就是)[，,]*(?=(?:上午|中午|下午|晚上|晚间|傍晚|安排|计划|创建|提醒|记|谢谢|就这样))",
        "",
        cleaned,
    )
    correction_filler = r"(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+"
    cleaned = re.sub(rf"不{correction_filler}是", "不是", cleaned)
    cleaned = re.sub(rf"不{correction_filler}对", "不对", cleaned)
    cleaned = re.sub(rf"说{correction_filler}错", "说错", cleaned)
    cleaned = re.sub(rf"改{correction_filler}成", "改成", cleaned)
    cleaned = re.sub(
        r"^(?:(?:刚才)?(?:说漏了|漏说了|忘了说)|补充一下|再补充(?:一下)?|对了)[，,。]*",
        "",
        cleaned,
    )
    cleaned = re.sub(
        r"((?:每天|每日))[0-9一二两三四五六七八九十]{1,2}"
        r"(?:差不多|大概(?:是)?|可能(?:是)?)(?=(?:[01]?\d|2[0-3])[:：])",
        r"\1",
        cleaned,
    )
    temporal_filler = r"(?:[，,]*(?:呃|额|嗯|那个|可能|然后|别忘了)[，,]*)+"
    cleaned = re.sub(rf"([0-9一二两三四五六七八九十]){temporal_filler}(?=月)", r"\1", cleaned)
    cleaned = re.sub(rf"(月){temporal_filler}(?=[0-9一二两三四五六七八九十])", r"\1", cleaned)
    sparse_date_filler = r"(?:[，,]*(?:呃|额|嗯|那个|可能|就是|差不多|先这样)[，,]*)+"
    cleaned = re.sub(
        rf"([0-9一二两三四五六七八九十]{{1,2}}月[0-3]?){sparse_date_filler}([0-9])(?=号|日)",
        r"\1\2",
        cleaned,
    )
    cleaned = re.sub(rf"(月){sparse_date_filler}(?=底|末)", r"\1", cleaned)
    cleaned = re.sub(
        rf"((?:下下|下|本|这)?(?:周|星期|礼拜)){temporal_filler}(?=[一二三四五六日天1-7])",
        r"\1",
        cleaned,
    )
    cleaned = re.sub(r"(?:然后|可能|大概)+(?=(?:到|至|直到))", "", cleaned)
    cleaned = re.sub(
        rf"(到|至|直到){temporal_filler}(?=(?:下下|下|本|这)?(?:周|星期|礼拜)|[0-9一二两三四五六七八九十])",
        r"\1",
        cleaned,
    )
    cleaned = re.sub(r"(号|日)始(?=到|至)", r"\1开始", cleaned)
    cleaned = re.sub(
        r"提前([0-9一二两三四五六七八九十]{1,3})时(?=提醒)",
        r"提前\1小时",
        cleaned,
    )
    cleaned = re.sub(r"声音可能有点小", "", cleaned)
    cleaned = re.sub(r"(?:然后|那个|呃|额|嗯)+(?=(?:可能)?(?:到|至|直到))", "", cleaned)
    cleaned = re.sub(r"(?:嗯|可能)*(?:不要|别)漏(?:掉)?前面日期", "", cleaned)
    # Keep a weekday and an immediately following hour as separate tokens.
    # Otherwise "下周五两点" is greedily read as the invalid hour "五两点".
    cleaned = re.sub(
        r"((?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7])"
        r"(?=[0-9一二两三四五六七八九十]{1,3}点)",
        r"\1，",
        cleaned,
    )
    return cleaned.strip("，,。.!！?？")


def _parse_authoritative_date(text: str) -> Optional[date]:
    """Prefer the final spoken date when the utterance explicitly corrects itself."""
    if _DATE_CORRECTION_RE.search(text):
        correction_tail = _select_correction_tail(text)
        if correction_tail != text:
            corrected = _parse_explicit_or_relative_date(correction_tail)
            if corrected:
                return corrected
        matches = list(re.finditer(_DATE_TOKEN_PATTERN, text))
        if matches:
            # A trailing clause such as "今天主题是..." is not the corrected
            # date.  Prefer the last absolute calendar token when one exists,
            # then fall back to relative tokens for utterances like
            # "不是今天，改成明天".
            absolute_matches = [
                match for match in matches
                if re.search(r"(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月"
                             r"[0-9一二两三四五六七八九十]{1,3}(?:号|日)", match.group(0))
            ]
            candidates = absolute_matches or matches
            for match in reversed(candidates):
                if _is_likely_location_number(text, match):
                    continue
                parsed = _parse_date_token(match.group(0))
                if parsed:
                    return parsed
    return _parse_explicit_or_relative_date(text)


def _parse_explicit_or_relative_date(text: str) -> Optional[date]:
    today = _current_date()
    # An absolute date in the utterance outranks incidental words such as
    # "今天主题是".  Checking relative-day tokens first made a valid
    # 2027-02-17 event collapse to the request date whenever the title clause
    # contained "今天".
    if match := re.search(
        r"([0-9]{4})年([0-9一二两三四五六七八九十]{1,2})月"
        r"([0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        text,
    ):
        year = int(match.group(1))
        month = _cn_to_int(match.group(2))
        day = _cn_to_int(match.group(3))
        if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(year, month)[1]:
            return None
        return date(year, month, day)
    if match := re.search(
        r"([0-9一二两三四五六七八九十]{1,2})月"
        r"([0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        text,
    ):
        month = _cn_to_int(match.group(1))
        day = _cn_to_int(match.group(2))
        if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(today.year, month)[1]:
            return None
        candidate = date(today.year, month, day)
        return date(today.year + 1, month, day) if candidate < today else candidate
    explicit_month_start = _parse_explicit_month_start(text)
    if explicit_month_start:
        return explicit_month_start
    explicit_month_end = _parse_explicit_month_end(text)
    if explicit_month_end:
        return explicit_month_end
    if re.search(r"(?<!记)(?:下个月底|下个月末|下月底|下月末)", text):
        year = today.year + int(today.month == 12)
        month = 1 if today.month == 12 else today.month + 1
        return date(year, month, calendar.monthrange(year, month)[1])
    if "月底" in text or "月末" in text:
        return date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    if re.search(r"(?:下下|下个|下一个|下)周末", text):
        weeks = 2 if "下下周末" in text else 1
        return _weekday_in_week(5, weeks)
    if re.search(r"(?:本|这|这个)周末", text):
        return _next_weekday(5, include_today=True)
    if "周末" in text:
        return _next_weekday(5, include_today=True)
    if re.search(r"(?:明早|明晨|明晚|明夜|明天)", text):
        return today + timedelta(days=1)
    if re.search(r"(?:今早|今晨|今夜|今晚|今天|今日)", text):
        return today
    if "大后天" in text:
        return today + timedelta(days=3)
    if "后天" in text:
        return today + timedelta(days=2)
    if "明天" in text:
        return today + timedelta(days=1)
    if "今天" in text or "今日" in text or "今晚" in text:
        return today

    if match := re.search(
        r"(下个月|下月|本月|这个月)([0-9一二两三四五六七八九十]{1,3})(?:号|日)",
        text,
    ):
        month_word = match.group(1)
        year, month = today.year, today.month
        if month_word in {"下个月", "下月"}:
            year += int(month == 12)
            month = 1 if month == 12 else month + 1
        day = _cn_to_int(match.group(2))
        if not 1 <= day <= calendar.monthrange(year, month)[1]:
            return None
        return date(year, month, day)

    if match := re.search(r"([0-9]{4})年([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)", text):
        year = int(match.group(1))
        month = _cn_to_int(match.group(2))
        day = _cn_to_int(match.group(3))
        if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(year, month)[1]:
            return None
        return date(year, month, day)

    if match := re.search(r"([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)", text):
        month = _cn_to_int(match.group(1))
        day = _cn_to_int(match.group(2))
        if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(today.year, month)[1]:
            return None
        candidate = date(today.year, month, day)
        if candidate < today:
            candidate = date(today.year + 1, month, day)
        return candidate

    if match := re.search(r"(?:(下下|下|本|这)?(?:周|星期|礼拜))([一二三四五六日天1-7])", text):
        prefix = match.group(1) or ""
        weekday = _WEEKDAY_MAP[match.group(2)]
        if prefix == "下下":
            return _weekday_in_week(weekday, weeks_from_this=2)
        if prefix == "下":
            return _weekday_in_week(weekday, weeks_from_this=1)
        if prefix in {"本", "这"}:
            # The v4 spoken-calendar rule treats ``本周X/这周X`` as the next
            # upcoming occurrence, just like an unqualified ``周X``.  It must
            # not silently resolve to a date that has already passed in the
            # current week.
            return _next_weekday(weekday, include_today=True)
        return _next_weekday(weekday)

    for match in re.finditer(r"([0-9一二两三四五六七八九十]{1,3})(?:号|日)", text):
        if _is_likely_location_number(text, match):
            continue
        day = _cn_to_int(match.group(1))
        _, days_in_month = calendar.monthrange(today.year, today.month)
        if 1 <= day <= days_in_month:
            candidate = date(today.year, today.month, day)
            if candidate < today:
                year = today.year + int(today.month == 12)
                month = 1 if today.month == 12 else today.month + 1
                candidate = date(year, month, min(day, calendar.monthrange(year, month)[1]))
            return candidate

    return None


def _parse_explicit_month_start(text: str, context: Optional[date] = None) -> Optional[date]:
    """Resolve month-start phrases to the next non-past calendar occurrence."""
    reference = context or _current_date()
    explicit = re.search(
        r"(?:(?P<year>[0-9]{4})年)?"
        r"(?P<month>[0-9一二两三四五六七八九十]{1,2})月初",
        text,
    )
    if explicit:
        month = max(1, min(12, _cn_to_int(explicit.group("month"))))
        year = int(explicit.group("year")) if explicit.group("year") else reference.year + int(month < reference.month)
        candidate = date(year, month, 1)
        if not explicit.group("year") and candidate < reference:
            year += 1
            candidate = date(year, month, 1)
        return candidate
    if re.search(r"(?:下个月初|下月初)", text):
        year = reference.year + int(reference.month == 12)
        month = 1 if reference.month == 12 else reference.month + 1
        return date(year, month, 1)
    if re.search(r"(?:本月初|这个月初|月初)", text):
        candidate = date(reference.year, reference.month, 1)
        if candidate < reference:
            year = reference.year + int(reference.month == 12)
            month = 1 if reference.month == 12 else reference.month + 1
            candidate = date(year, month, 1)
        return candidate
    return None


def _parse_explicit_month_end(text: str, context: Optional[date] = None) -> Optional[date]:
    match = re.search(
        r"(?:(?P<year>[0-9]{4})年)?"
        r"(?P<month>[0-9一二两三四五六七八九十]{1,2})月(?:底|末)",
        text,
    )
    if not match:
        return None
    month = max(1, min(12, _cn_to_int(match.group("month"))))
    if match.group("year"):
        year = int(match.group("year"))
    else:
        reference = context or _current_date()
        year = reference.year + int(month < reference.month)
    return date(year, month, calendar.monthrange(year, month)[1])


_TIME_TOKEN_PATTERN = (
    r"(?:[01]?\d|2[0-3])[:：][0-5]\d"
    r"|(?:凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)?[0-9一二两三四五六七八九十]{1,3}点(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?"
)


def _parse_time_range(text: str) -> Optional[tuple[Optional[str], Optional[str]]]:
    pattern = re.compile(rf"(?P<start>{_TIME_TOKEN_PATTERN})(?:到|至|直到|[-—~～])(?P<end>{_TIME_TOKEN_PATTERN})")
    for match in pattern.finditer(text):
        start_token = match.group("start")
        end_token = match.group("end")
        start_period = _extract_time_period(start_token) or _infer_time_period(text, match.start())
        start_time = _parse_time_token(start_token, default_period=start_period)
        end_time = _parse_time_token(end_token, default_period=_extract_time_period(start_token) or start_period)
        if start_time and end_time:
            return start_time, end_time
    # Spoken Chinese may place the event subject between the bounds, for
    # example “下午三点半开会到五点”. Correction phrases remain replacements,
    # not ranges, and are deliberately excluded here.
    split_pattern = re.compile(
        rf"(?P<start>{_TIME_TOKEN_PATTERN})"
        rf"(?P<middle>[^，,。.!！?？；;]{{1,30}}?)"
        rf"(?:到|至|直到)(?P<end>{_TIME_TOKEN_PATTERN})"
    )
    for match in split_pattern.finditer(text):
        middle = match.group("middle").strip()
        if not middle or re.search(r"(?:改|换|调整|更正|不是|不对|说错)", middle):
            continue
        if re.search(_TIME_TOKEN_PATTERN, middle):
            continue
        start_token = match.group("start")
        end_token = match.group("end")
        start_period = _extract_time_period(start_token) or _infer_time_period(text, match.start())
        start_time = _parse_time_token(start_token, default_period=start_period)
        end_time = _parse_time_token(end_token, default_period=_extract_time_period(start_token) or start_period)
        if start_time and end_time:
            return start_time, end_time
    return None


def _parse_time(text: str) -> Optional[str]:
    if match := re.search(r"([01]?\d|2[0-3])[:：]([0-5]\d)", text):
        return f"{int(match.group(1)):02d}:{int(match.group(2)):02d}"

    # “中午” on its own is a spoken time-of-day, not an absent time. Treat it
    # as noon only when no more specific clock appears in the same utterance;
    # “中午十二点” continues through the numeric branch below.
    if "中午" in text and not re.search(
        r"(?:凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)?"
        r"[0-9一二两三四五六七八九十]{1,3}点",
        text,
    ):
        return "12:00"

    match = re.search(
        r"(凌晨|早上|上午|中午|下午|晚上|晚间|傍晚)?([0-9一二两三四五六七八九十]{1,3})点(?:(半)|([0-9一二两三四五六七八九十]{1,2})分?)?",
        text,
    )
    if not match:
        return None
    return _format_time_parts(
        match.group(1) or _infer_time_period(text, match.start()),
        _cn_to_int(match.group(2)),
        30 if match.group(3) else (_cn_to_int(match.group(4)) if match.group(4) else 0),
    )


def _has_unqualified_clock_ambiguity(text: str) -> bool:
    """Detect a short spoken clock with no day-period evidence.

    Bare hours such as ``五点`` can mean 05:00 or 17:00.  Keep explicit
    numeric clocks and period-qualified clocks deterministic, while asking
    for the missing period instead of silently choosing early morning.
    """
    normalized = _normalize_schedule_text(text)
    inherited_range_end_spans = []
    qualified_range_pattern = re.compile(
        r"(?:凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)"
        r"[0-9一二两三四五六七八九十]{1,3}点"
        r"(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?"
        r"(?P<middle>[^，,。.!！?？；;]{0,30}?)"
        r"(?:到|至|直到|[-—~～])"
        r"(?P<end>[0-9一二两三四五六七八九十]{1,3}点"
        r"(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?)"
    )
    for range_match in qualified_range_pattern.finditer(normalized):
        middle = range_match.group("middle")
        if re.search(r"(?:改|换|调整|更正|不是|不对|说错)", middle):
            continue
        inherited_range_end_spans.append(range_match.span("end"))
    inherited_period = bool(
        _DATE_CORRECTION_RE.search(normalized)
        and re.search(r"(?:凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)\s*[0-9一二两三四五六七八九十]{1,3}点", normalized)
    )
    for match in re.finditer(
        r"(?P<period>凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)?"
        r"(?P<hour>[0-9一二两三四五六七八九十]{1,3})点"
        r"(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?",
        normalized,
    ):
        if any(start <= match.start() < end for start, end in inherited_range_end_spans):
            continue
        if match.group("period") or _infer_time_period(normalized, match.start()) or inherited_period:
            continue
        hour = _cn_to_int(match.group("hour"))
        # 12点 is usually understood as noon/midnight only with context; it
        # remains ambiguous without a period as well.  13-23 cannot occur in
        # Chinese bare-hour wording and are already covered by numeric clocks.
        # In ordinary Chinese calendar speech, bare 10/11点 default to the
        # daytime reading; 1-9点 and 12点 remain genuinely ambiguous without
        # a period marker. This keeps the existing “五点” safety prompt while
        # allowing natural forms such as “十点会面”.
        if hour in set(range(1, 10)) | {12}:
            return True
    return False


def _parse_authoritative_time(text: str) -> Optional[str]:
    """Use a single explicit time, or the final time after a spoken correction."""
    matches = list(re.finditer(_TIME_TOKEN_PATTERN, text))
    if not matches:
        return None
    if len(matches) == 1:
        return _parse_time_token(
            matches[0].group(0),
            default_period=_infer_time_period(text, matches[0].start()),
        )
    if _DATE_CORRECTION_RE.search(text):
        inherited_period = (
            _extract_time_period(matches[0].group(0))
            or _infer_time_period(text, matches[0].start())
        )
        return _parse_time_token(
            matches[-1].group(0),
            default_period=inherited_period or _infer_time_period(text, matches[-1].start()),
        )
    return None


def _parse_time_token(token: str, default_period: str = "") -> Optional[str]:
    token = token.strip()
    if match := re.fullmatch(r"([01]?\d|2[0-3])[:：]([0-5]\d)", token):
        return f"{int(match.group(1)):02d}:{int(match.group(2)):02d}"
    match = re.fullmatch(
        r"(凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)?([0-9一二两三四五六七八九十]{1,3})点(?:(半)|([0-9一二两三四五六七八九十]{1,2})分?)?",
        token,
    )
    if not match:
        return None
    period = match.group(1) or default_period
    if period in {"明早", "明晨", "今早", "今晨"}:
        period = "早上"
    elif period in {"明晚", "明夜", "今夜", "今晚"}:
        period = "晚上"
    hour = _cn_to_int(match.group(2))
    minute = 30 if match.group(3) else (_cn_to_int(match.group(4)) if match.group(4) else 0)
    return _format_time_parts(period, hour, minute)


def _extract_time_period(token: str) -> str:
    match = re.match(
        r"(凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)",
        token.strip(),
    )
    if not match:
        return ""
    value = match.group(1)
    if value in {"明早", "明晨", "今早", "今晨"}:
        return "早上"
    if value in {"明晚", "明夜", "今夜", "今晚"}:
        return "晚上"
    return value


def _parse_fuzzy_time_period(text: str) -> Optional[str]:
    """Return a stable spoken period without inventing an HH:mm value."""
    normalized = _normalize_schedule_text(text)
    normalized = re.sub(r"下午茶|早茶|中午饭|午饭|午餐|晚饭|晚餐", "", normalized)
    matches = list(re.finditer(r"凌晨|早上|上午|中午|下午|午后|傍晚|晚上|晚间|明早|明晨|明晚|明夜|今早|今晨|今晚|今夜", normalized))
    if not matches:
        return None
    spoken = matches[-1].group(0)
    if spoken == "凌晨":
        return "early_morning"
    if spoken in {"早上", "上午", "明早", "明晨", "今早", "今晨"}:
        return "morning"
    if spoken == "中午":
        return "noon"
    if spoken in {"下午", "午后"}:
        return "afternoon"
    if spoken == "傍晚":
        return "evening"
    return "night"


def _time_period_surface(period: Optional[str]) -> str:
    return {
        "early_morning": "凌晨",
        "morning": "上午",
        "noon": "中午",
        "afternoon": "下午",
        "evening": "傍晚",
        "night": "晚上",
    }.get(str(period or ""), "")


def _infer_time_period(text: str, index: int) -> str:
    prefix = text[max(0, index - 8):index]
    if re.search(r"(下午茶|午后|下午时段)", prefix):
        return "下午"
    if re.search(r"(早茶|上午时段|明早|明晨|今早|今晨)", prefix):
        return "上午"
    if re.search(r"(中午饭|午饭|午餐)", prefix):
        return "中午"
    if re.search(r"(晚饭|晚餐|晚间|今晚|明晚|明夜|今夜)", prefix):
        return "晚上"
    return ""


def _format_time_parts(period: str, hour: int, minute: int) -> Optional[str]:
    if period in {"下午", "晚上", "晚间", "傍晚"} and hour < 12:
        hour += 12
    elif period == "中午" and hour < 11:
        hour += 12
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return f"{hour:02d}:{minute:02d}"


def _select_correction_tail(text: str) -> str:
    replacement = re.search(
        r"(?:不是|不对|说错)[^，,。.!！?？；;]*[，,。.!！?？；;]"
        r"(?:是|改成|改为|换成|调整到)?(.+)$",
        text,
    )
    if replacement and replacement.group(1).strip():
        return replacement.group(1)

    direct = re.search(r"(?:改成|改为|改到|换成|换到|调整到|更正为?|纠正为?)(.+)$", text)
    if direct and direct.group(1).strip():
        tail = direct.group(1)
        # A trailing negation may describe the discarded value rather than
        # the replacement, e.g. "改成周五下午三点，不是原来的时间".
        # Keep only the replacement clause so it cannot become the title.
        tail = re.split(
            r"[，,。.!！?？；;]\s*(?:不是|不对|说错|原来的|之前的)",
            tail,
            maxsplit=1,
        )[0]
        if tail.strip():
            return tail

    # “日期改一下，……” is a common spoken correction without an explicit
    # 改成/换成 token.  Preserve the clause after the pause as authoritative.
    field_correction = re.search(
        r"(?:日期|时间|时间点)改(?:一下|一下吧)?[，,：:]\s*(.+)$",
        text,
    )
    if field_correction and field_correction.group(1).strip():
        return field_correction.group(1)

    final = re.search(r"(?:最终|最后(?!一个工作日)|以后面的为准|后面的为准)[，,：: ]*(.+)$", text)
    if final and final.group(1).strip():
        return final.group(1)
    return text


def _repair_title_text(title: str, raw_text: str) -> str:
    """Remove spoken control wrappers without dropping the task subject."""
    cleaned = _normalize_title(title or "")
    # A date can remain in a model title when the utterance uses the compact
    # spoken form "我十五日要乘飞机".  Once the date is already authoritative
    # in the schedule fields, remove the date and its following intent shell;
    # keep the actual subject ("乘飞机").
    if raw_text and _has_date_signal(raw_text):
        cleaned = re.sub(
            rf"^(?:我|我要|我想)\s*(?={_DATE_TOKEN_PATTERN})",
            "",
            cleaned,
        )
        # A date-looking word can be lexical title material.  In particular,
        # authored v4 intentionally keeps ``周末旅行计划`` and
        # ``月底水电缴费`` as titles when the temporal word is attached to the
        # subject; actual date phrases have already been removed by
        # ``_strip_schedule_markers`` when followed by a clock.
        leading_temporal = re.match(r"^(周末|月初|月底|月末)(?P<rest>.+)$", cleaned)
        if not (
            leading_temporal
            and leading_temporal.group("rest")
            and not re.match(
                r"^(?:凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|"
                r"[0-9一二两三四五六七八九十]{1,3}点)",
                leading_temporal.group("rest"),
            )
        ):
            cleaned = re.sub(
                rf"^(?:{_DATE_TOKEN_PATTERN})\s*",
                "",
                cleaned,
            )
        cleaned = re.sub(
            r"^(?:要|得|准备|计划|会(?!议|面))\s*(?=.{1,})",
            "",
            cleaned,
        )
    cleaned = re.sub(r"^(?:嗯+|呃+|额+|啊+|那个)(?:[………，,\s]+)?", "", cleaned)
    cleaned = re.sub(r"^(?:刚才|刚刚|以后|得|抽空|我要|我想说|我觉得|我想|我|先)\s*", "", cleaned)
    cleaned = re.sub(r"^说(?=(?:安排|记|提醒|创建|新建|加))", "", cleaned)
    cleaned = re.sub(
        r"^(?:安排一下|记一下|记下|创建一下|新建一下|加一下)(?=.{2,})",
        "",
        cleaned,
    )
    # In a spoken command these are operation verbs, not the event subject
    # ("处理预算季度复盘" -> "预算季度复盘").  Keep short lexical words
    # such as "做饭" intact by requiring a non-trivial remainder.
    if raw_text and (
        _has_date_signal(raw_text)
        or re.search(
            r"(?:加到|加进|写进|写入|安排在|排到|排在|定在|定个|留出|留给|留点时间给|"
            r"设置|固定|提醒我|隔周|每周|每月|每年|可以做|"
            r"改成|改为|改到|换成|换到|调整到|更正|纠正|存一下|存下|保存一下)",
            raw_text,
        )
    ):
        cleaned = re.sub(
            r"^(?:做|处理|安排|准备|确认|跟进|讨论|联系|参加)(?=.{2,})",
            "",
            cleaned,
        )
    if raw_text and re.search(r"(?:安排在|排到|排在|定在|留给|留出|留点时间给)", raw_text):
        cleaned = re.sub(r"^给(?=.{2,})", "", cleaned)
    cleaned = re.sub(r"^(?:叫我|提醒我)\s*", "", cleaned)
    cleaned = re.sub(r"那个", "", cleaned)
    # Removing a pronoun can expose a recurrence or creation wrapper that was
    # not at the beginning on the first normalization pass.
    cleaned = _normalize_title(cleaned)
    cleaned = re.sub(
        r"(讨论|整理|确认|联系|准备|安排|检查|处理|提交|跟进|复盘)一下",
        r"\1",
        cleaned,
    )
    cleaned = re.split(r"[，,]\s*(?:时间|日期|几点).*$", cleaned, maxsplit=1)[0]
    cleaned = re.sub(
        r"[，,]\s*(?:你(?:给我)?(?:加上|记着|记一下)|先占(?:个)?位|别又忘了|自己再想想).*$",
        "",
        cleaned,
    )
    cleaned = re.sub(r"(?:你(?:给我)?(?:加上|记着|记一下)|先占(?:个)?位|别又忘了|自己再想想)$", "", cleaned)
    cleaned = re.sub(r"(?:吧|呢|啊)$", "", cleaned)
    cleaned = re.sub(r"是$", "", cleaned)
    return cleaned.strip("，,。.!！?？；; ………")


def _prefer_surface_title(model_title: str, surface_title: str) -> bool:
    """Prefer a richer spoken subject when a small model drops its tail."""
    model = _repair_title_text(model_title, "")
    surface = _repair_title_text(surface_title, "")
    if not surface or surface == "待办":
        return False
    if not model or re.fullmatch(r"(?:嗯+|呃+|额+|那个|看看|你|我)", model):
        return True
    if model in surface and len(surface) > len(model):
        return True
    return len(surface) - len(model) >= 2


def _prefer_correction_surface_title(model_title: str, raw_text: str) -> bool:
    """Keep an explicit correction's lexical subject over a semantic rewrite.

    A model can turn ``电影排片`` into ``看电影`` in a correction utterance.
    The latter is a plausible paraphrase but changes the user's calendar
    subject.  Only activate this narrow branch when a correction tail contains
    a non-slot title and the two normalized subjects are not containment
    variants.  Ordinary ``做项目启动``/``项目启动`` pairs continue to use the
    existing model-vs-surface rule and are not broadened by this fix.
    """
    normalized = _normalize_schedule_text(raw_text)
    if not _DATE_CORRECTION_RE.search(normalized):
        return False
    tail = _select_correction_tail(normalized)
    if tail == normalized:
        return False
    surface_title, _ = _extract_title_and_description(tail)
    surface = _repair_title_text(surface_title, normalized)
    model = _repair_title_text(model_title, normalized)
    if not surface or surface == "待办" or not model or model == "待办":
        return False
    # These are action shells in a correction tail, not part of the subject.
    surface_core = re.sub(r"^(?:做|处理|安排)(?=.{2,})", "", surface)
    surface_core = surface_core.strip()
    if len(surface_core) < 2:
        return False
    return model not in surface_core and surface_core not in model


def _extract_pre_correction_subject(raw_text: str) -> Optional[str]:
    """Extract the existing subject before a date/time replacement marker.

    Complex conditional requests are intentionally sent to the model for
    temporal reasoning. A small model may nevertheless copy the conditional
    tail (for example ``如果没有空就安排``) into ``title``. The text before
    ``改到``/``调整到`` remains the authoritative subject in that form.
    """
    normalized = _normalize_schedule_text(raw_text)
    marker = re.search(r"(?:改成|改为|改到|换成|换到|调整到|更正为?|纠正为?)", normalized)
    if marker is None:
        return None
    prefix = normalized[: marker.start()].strip("，,。.!！?？；; ")
    if not prefix or re.fullmatch(r"(?:日期|时间|时间点|安排|日程|事项|活动)", prefix):
        return None
    candidate, _ = _extract_title_and_description(prefix)
    candidate = _repair_title_text(candidate, normalized)
    if not candidate or candidate in {"待办", "会议", "开会", "日程", "事项", "安排", "活动"}:
        return None
    if re.search(_DATE_TOKEN_PATTERN, candidate) or re.search(_TIME_TOKEN_PATTERN, candidate):
        return None
    return candidate[:20]


def _extract_title_and_description(text: str) -> tuple[str, Optional[str]]:
    correction_tail = _select_correction_tail(text)
    # A correction tail may contain only a replacement time, reminder, or
    # location.  In those cases using the tail as the title source discards
    # the original task name.  Prefer it only when it still contains a clear
    # scheduling action and therefore carries the task itself.
    authoritative_text = text
    if correction_tail != text:
        # Choose the correction tail when it contains any non-slot title
        # payload.  A tail containing only a replacement time/location must
        # not discard the original task name.
        tail_probe = _normalize_title(_strip_schedule_markers(correction_tail))
        tail_is_slot_only = bool(
            not _location_candidate_has_schedule_slot(correction_tail.strip())
            and re.fullmatch(
                r"(?:地点|地址|位置)?(?:改到|换到|调整到|是|为)?"
                rf"(?:{_LOCATION_TOKEN_PATTERN}|{_TIME_TOKEN_PATTERN})?",
                correction_tail.strip(),
            )
        )
        if tail_probe and tail_probe != "待办" and not tail_is_slot_only:
            authoritative_text = correction_tail
    # Remove an uncertain-location clause without discarding the actual task
    # that follows it.  Splitting on the generic "地点" marker used to leave
    # only the time prefix and produce the placeholder title "待办".
    uncertain_location = _UNCERTAIN_LOCATION_RE.search(authoritative_text)
    if uncertain_location:
        authoritative_text = (
            authoritative_text[:uncertain_location.start()]
            + authoritative_text[uncertain_location.end():]
        )
    destination = _DESTINATION_CONTEXT_RE.search(authoritative_text)
    if destination:
        authoritative_text = (
            authoritative_text[:destination.start()]
            + authoritative_text[destination.end():]
        )
    # A reason clause after a reminder is context, not part of the event name
    # (for example, “提醒我带上雨衣，因为会下雨”). Keep the user-facing task
    # while dropping only the trailing causal explanation.
    if re.search(r"(?:提醒我|告诉我|记一下|记个|安排|添加|加到|设置)", authoritative_text):
        authoritative_text = re.split(r"(?:因为|由于|以免|免得)", authoritative_text, maxsplit=1)[0]
    # Explicit location clauses belong to the location field, not the title.
    # Remove only the clause after the marker and retain the surrounding task.
    authoritative_text = re.sub(
        rf"(?:地点|地址|位置)\s*(?:在|是|为|去|到|往)?\s*"
        rf"(?:{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})",
        "",
        authoritative_text,
    )
    # The ordinary “在某处做某事” form has no explicit 地点 marker.  Strip
    # only the venue token while keeping the action as title material, so
    # “在 A301 复盘项目” becomes title “复盘项目”, location “A301”.
    location_action_match = None
    location_action_start = None
    for marker in re.finditer(r"(?:在|去|到|往)", authoritative_text):
        candidate = _LOCATION_WITH_ACTION_RE.match(authoritative_text[marker.start() :])
        if candidate is None:
            continue
        location_candidate = candidate.group("location").strip()
        if location_candidate and not _location_candidate_has_schedule_slot(location_candidate):
            location_action_match = candidate
            location_action_start = marker.start()
            break
    if location_action_match is not None and location_action_start is not None:
        end = location_action_start + location_action_match.end()
        authoritative_text = (
            authoritative_text[:location_action_start]
            + location_action_match.group("action")
            + authoritative_text[end:]
        )
    explicit_title = re.search(
        r"(?:标题(?:不要太长)?[，,]?(?:就)?(?:写|叫|设为|是)|"
        r"(?:本次|这次|今天|当前|新的|该项|接下来|随后|下一个|待办)?"
        r"(?:主题|事项|日程|计划|任务|活动|内容|安排|工作|会议)?"
        r"(?:名称|名字|名)?"
        r"(?:写成|写为|记为|定名为|定为|安排为|叫作|叫做|叫|就写|是|(?<!因)为(?!我(?:的)?)))"
        r"\s*([^，,。.!！?？；;]{1,60}?)"
        r"(?=\s*(?:地点|地址|位置|提前|无需提醒|不提醒|需要通知|"
        r"和[^，,。.!！?？；;]{1,16}一起|[，,。.!！?？；;]|$))",
        authoritative_text,
    )
    if explicit_title:
        explicit_candidate = _repair_title_text(explicit_title.group(1), text)
        # A loose "是" match can capture the following date/repetition phrase
        # (for example "生日是每年三月十二号") as a title.  Let the normal
        # surface pass continue so the spoken subject before the slot survives.
        if (
            explicit_candidate
            and not _has_date_signal(explicit_candidate)
            and not _RECURRENCE_MARKER_RE.search(explicit_candidate)
        ):
            return explicit_candidate[:20], None

    # Calendar-add requests often wrap the actual subject in “把我的…添加
    # 到我的日历”. Extract only the subject so an undated request can still
    # produce a safe clarification draft instead of being sent to the model
    # and rejected as not-a-schedule.
    calendar_add = re.search(
        r"(?:把|将)\s*(?:我的|我这边的|我那条)?\s*"
        r"(?P<subject>[^，,。.!！?？；;]{1,50}?)\s*"
        r"(?:添加|加|写入|放入|记入)(?:到|进)\s*(?:我的)?(?:日历|日程)",
        authoritative_text,
    )
    if calendar_add:
        calendar_title = _repair_title_text(calendar_add.group("subject"), text)
        if calendar_title:
            return calendar_title[:20], None

    # Voice reminders often omit a field marker and put the task after a
    # clock phrase, for example "提醒我在 07:06 处理讨论供应商合同".  The
    # old fallback kept the command prefix ("请顺手记一笔") as the title.
    implicit_title = re.search(
        r"(?:提醒我|叫我)[^，,。.!！?？；;]{0,30}?"
        r"(?P<action>处理|完成|提交|跟进|安排|准备|确认|整理|讨论|联系|参加)\s*"
        r"(?P<subject>[^，,。.!！?？；;]{1,60})",
        authoritative_text,
    )
    if implicit_title:
        action = implicit_title.group("action")
        subject = implicit_title.group("subject")
        # “提交材料” is a complete task name, rather than a command prefix
        # like “处理项目复盘”. Preserve the action for this lexical form so
        # relative reminders do not degrade to the generic noun “材料”.
        source = f"{action}{subject}" if action == "提交" else subject
        candidate = _normalize_title(source)
        if candidate:
            return _repair_title_text(candidate, text)[:20], None

    description = None
    desc_match = re.search(
        r"(?:备注|内容是|主题是|关于|要(?:讨论|聊|沟通|确认))(.+)$",
        authoritative_text,
    )
    title_text = authoritative_text
    if desc_match:
        description = desc_match.group(1).strip("，,。.!！?？")
        title_text = authoritative_text[:desc_match.start()].strip("，,。.!！?？")

    location_action = _extract_location_action(title_text)
    if location_action:
        title_text = location_action[1]
    surface_title_text = _strip_schedule_markers(title_text)
    # Remove a spoken filler clause before the generic punctuation split; if it
    # is left in place, "嗯……，那个部门周会" is truncated to just "嗯……".
    surface_title_text = re.sub(
        r"^(?:嗯+|呃+|额+|那个|就是)(?:[………，,：:\s]+)+",
        "",
        surface_title_text,
    )
    title_text = _normalize_title(surface_title_text)
    if not title_text and description:
        title_text = description
    # In a clarification utterance, a leading period word can be lexical title
    # text ("傍晚公园散步，时间还没定") rather than a confirmed clock slot.
    # Restore it only when no numeric/clock expression exists in the utterance.
    if (
        title_text
        and not re.search(_TIME_TOKEN_PATTERN, text)
        and _DEFERRED_DETAIL_RE.search(text)
        and not re.match(r"^(?:凌晨|早上|上午|中午|下午|晚上|晚间|傍晚)", title_text)
    ):
        leading_period = re.match(
            r"^(?:有个|有一项|记个|记一下|先留着|先放着|先记着|想约个|想做|准备)?"
            r"(?P<period>凌晨|早上|上午|中午|下午|晚上|晚间|傍晚)",
            text,
        )
        if leading_period:
            title_text = leading_period.group("period") + title_text
    return _repair_title_text(title_text, text)[:20], description


def _sanitize_llm_title(title: str, raw_text: str) -> str:
    cleaned = _normalize_title(_strip_schedule_markers(title))
    temporal_leak = bool(
        re.search(_DATE_TOKEN_PATTERN, cleaned)
        or re.search(_TIME_TOKEN_PATTERN, cleaned)
        or re.match(r"^(?:凌晨|早上|上午|中午|下午|晚上|晚间)", cleaned)
    )
    if temporal_leak and not _DATE_CORRECTION_RE.search(raw_text):
        candidate, _ = _extract_title_and_description(_normalize_schedule_text(raw_text))
        candidate_has_time = bool(
            re.search(_DATE_TOKEN_PATTERN, candidate)
            or re.search(_TIME_TOKEN_PATTERN, candidate)
            or re.match(r"^(?:凌晨|早上|上午|中午|下午|晚上|晚间)", candidate)
        )
        if candidate and not candidate_has_time:
            return candidate
    return cleaned


def _strip_schedule_markers(text: str) -> str:
    # A period word immediately before "公园" can be lexical title text
    # (for example "傍晚公园散步"), not the event's clock period.  Protect it
    # while removing actual date/time markers and restore it at the end.
    protected_periods: list[str] = []

    def _protect_period(match: re.Match[str]) -> str:
        protected_periods.append(match.group(1))
        index = len(protected_periods) - 1
        return f"\ue000{chr(0xe100 + index)}\ue001"

    cleaned = re.sub(
        r"(凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)(?=公园)",
        _protect_period,
        text,
    )
    patterns = [
        r"(?:把这个放进日程|日程里加一下|帮我设一下|帮我记一下|帮我记|麻烦记录一下|麻烦记录|给我安排|加个待办|记一条|我需要记住|我记住|提醒我)",
        r"^(?:写进日历|写入日历|加到日历里|加进日历|放进日历|存一下|存下|保存一下|留出|留给|定个|排个时间|设置|安排在|安排|排到|排在|定在|放在|加上|加到|加进|加入|加个|设成|设为|把|到|在|从起|从(?:周末|月初|下个月初|下月初|本月初|这个月初)起)",
        r"^(?:记下|记住|记个|先记着|先留着|先放着|有个|有一项|想约个|想做|准备|先把)",
        r"(?:先留着|先放着|先记着|留个位置|留点时间|留一点时间|要安排|具体时间回头补|具体日期回头补|时间还没定|日期还没想好|时间还没想好|几点再看|等会儿定时间|时间再说)$",
        r"(?:先留着|先放着|先记着|留个位置|留点时间|留一点时间|要安排|具体时间回头补|具体日期回头补|时间还没定|日期还没想好|时间还没想好|几点再看|等会儿定时间|时间再说)",
        r"(?:排到|排在|安排在|放在|设成|设为|定在|定为)$",
        r"每(?:个)?月(?:月初|月末|月底)",
        r"每周(?:都要|都得|都安排|都留|固定)",
        r"隔周[一二三四五六日天1-7]?",
        r"固定",
        r"^(?:给)(?=.{2,})",
    r"每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:到|至)(?:周|星期|礼拜)?[一二三四五六日天1-7]",
        r"每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:[、,，和及\s]*(?:周|星期|礼拜)?[一二三四五六日天1-7]){0,6}(?=(?:[，,。.!！?？；;\s]|提醒|安排|记录|加个|做|处理|留给|在|去|参加|开始|到|持续|每天|上午|中午|下午|傍晚|晚上|晚间|凌晨|$))",
        r"(?:半(?:个)?小时|一刻钟|[0-9一二两三四五六七八九十]{1,3}(?:分钟|(?:个)?小时|刻钟))(?:之后|以后|后)",
        _CONSECUTIVE_RELATIVE_RANGE_PATTERN,
        _CONSECUTIVE_RELATIVE_PAIR_PATTERN,
        rf"(?:从)?(?:{_DATE_TOKEN_PATTERN})(?:开始)?(?:到|至|直到|[-—~～])(?:{_DATE_TOKEN_PATTERN})",
        rf"(?:{_TIME_TOKEN_PATTERN})(?:到|至|直到|[-—~～])(?:{_TIME_TOKEN_PATTERN})",
        r"提前(?:半小时|[0-9一二两三四五六七八九十]{1,3}(?:分钟|小时|天))提醒",
        r"(?:开始时|准时|到点)提醒",
        r"(?:不提醒|无需提醒|不用提醒|不要提醒)",
        r"(?:就这样|谢谢|不要漏(?:掉)?)(?:$|[，,。.!！?？；;])",
        r"重复[0-9一二两三四五六七八九十两]+次",
        r"(?:节假日除外|法定节假日除外|节假日不算|跳过节假日)",
        r"(?:重复|持续|一直)(?:到|至|直到|截至|截止)(?:日期)?(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月(?:[0-9一二两三四五六七八九十]{1,3}(?:号|日)|底|末)",
        r"每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:到|至)(?:周|星期|礼拜)?[一二三四五六日天1-7]",
        r"每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)"
        r"[一二三四五六日天1-7](?:[、,，和及\s]*(?:周|星期|礼拜)?[一二三四五六日天1-7]){0,6}(?=(?:[，,。.!！?？；;\s]|提醒|安排|记录|加个|做|处理|留给|在|去|参加|开始|到|持续|每天|上午|中午|下午|傍晚|晚上|晚间|凌晨|$))",
        r"每(?:个)?工作日|每(?:个)?周末",
        r"每(?:个)?月(?:最后(?:一个)?工作日|第[一二三四五六七八九十0-9]+周|周[一二三四五六日天1-7])",
        r"每(?:周|星期|礼拜)[一二三四五六日天1-7]",
        r"每隔(?:[一二两三四五六七八九十0-9]+)?周",
        r"隔周",
        r"每(?:两|二|[2-9]|[二三四五六七八九十])周",
        r"每(?:天|日)",
        r"每(?:隔)?[一二两三四五六七八九十0-9]+个月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?",
        r"每(?:个)?月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?",
        r"每(?:隔)?[一二两三四五六七八九十0-9]+年[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?",
        r"每(?:个)?年[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?",
        r"(?:下下|下个|下一个|下|本|这|这个)?周末(?:两|二|2)?天?(?=(?:凌晨|早上|上午|中午|下午|傍晚|晚上|晚间|全天|安排|做|处理|留给|加个|在|去|参加|两|二|2|$|[，,。]))",
        r"(?:(?:下下|下个|下一个|下|本|这|这个)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:[、,，和及跟\s]+(?:周|星期|礼拜)?[一二三四五六日天1-7]|[一二三四五六日天]))(?=(?:凌晨|早上|上午|中午|下午|傍晚|晚上|晚间|全天|安排|做|处理|留给|加个|在|去|参加|$|[，,。]))",
        r"(明早|明晨|明晚|明夜|今早|今晨|今夜|今晚|大后天|后天|明天|今天|今日)",
        r"(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月(?:底|末)前?(?=(?:上午|中午|下午|傍晚|晚上|凌晨|[0-9一二两三四五六七八九十]{1,3}点|前|安排|做|处理|完成|提交|整理|跟进|准备|复盘|讨论|沟通|确认|评审|汇报|学习|复习|上课|考试|培训|阅读|跑步|健身|体检|看病|预约|出发|参加|进行|$))",
        r"(?:下个月底|下个月末|下月底|下月末|月底|月末)前?(?=(?:[，,。.!！?？；;]|早上|上午|中午|下午|傍晚|晚上|凌晨|[0-9一二三四五六七八九十]{1,3}点|前|的|可以|留给|放到|排在|定在|安排|做|处理|完成|提交|整理|跟进|准备|复盘|讨论|沟通|确认|评审|汇报|学习|复习|上课|考试|培训|阅读|跑步|健身|体检|看病|预约|出发|参加|进行|$))",
        r"[0-9]{4}年[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)",
        r"[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)",
        r"(?:下个月|下月|本月|这个月)[0-9一二两三四五六七八九十]{1,3}(?:号|日)",
        r"(?:下个|下一个)(?:周|星期|礼拜)[一二三四五六日天1-7]",
        r"(?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7]",
        r"周末(?=(?:凌晨|早上|上午|中午|下午|傍晚|晚上|[0-9一二三四五六七八九十]{1,3}点))",
        # Remove month-start tokens before the generic clock pass; otherwise
        # "月初下午两点" becomes "月初" after the clock is stripped and the
        # date token is mistaken for title text.
        r"(?:下个月初|下月初|本月初|这个月初|月初)(?=(?:[，,。.!！?？；;]|早上|上午|中午|下午|傍晚|晚上|凌晨|[0-9一二三四五六七八九十]{1,3}点|前|的|可以|留给|放到|排在|定在|安排|做|处理|完成|提交|整理|跟进|准备|复盘|讨论|沟通|确认|评审|汇报|学习|复习|上课|考试|培训|阅读|跑步|健身|体检|看病|预约|出发|参加|进行|$))",
        r"(凌晨|早上|上午|中午|下午|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)?[0-9一二两三四五六七八九十]{1,3}点(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?",
        r"(?:下个月初|下月初|本月初|这个月初|月初)(?=(?:[，,。.!！?？；;]|早上|上午|中午|下午|傍晚|晚上|凌晨|[0-9一二三四五六七八九十]{1,3}点|前|的|可以|留给|放到|排在|定在|安排|做|处理|完成|提交|整理|跟进|准备|复盘|讨论|沟通|确认|评审|汇报|学习|复习|上课|考试|培训|阅读|跑步|健身|体检|看病|预约|出发|参加|进行|$))",
        r"周末(?=(?:凌晨|早上|上午|中午|下午|傍晚|晚上|[0-9一二三四五六七八九十]{1,3}点|安排|做|处理|留给|加个|在|去|参加))",
        r"(?:凌晨|早上|上午|中午|下午(?!茶)|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)",
        r"([01]?\d|2[0-3])[:：]([0-5]\d)",
        r"^(?:凌晨|早上|上午|中午|下午(?!茶)|晚上|晚间|傍晚|明早|明晨|明晚|明夜|今早|今晨|今夜|今晚)(?=[^，,。.!！?？]{1,})",
        r"(提醒我|记一下|日程|待办|需要|完成)",
    ]
    for pattern in patterns:
        cleaned = re.sub(pattern, "", cleaned)
    # Removing the date/time token can expose a command suffix that was not at
    # the end when the marker pass first visited it (for example “定在月底”).
    cleaned = re.sub(r"(?:排到|排在|安排在|放在|设成|设为|定在|定为|放进|放到|排进)$", "", cleaned)
    for index, period in enumerate(protected_periods):
        cleaned = cleaned.replace(f"\ue000{chr(0xe100 + index)}\ue001", period)
    return cleaned.strip("，,。.!！?？的")


def _normalize_title(title: str) -> str:
    title = re.sub(r"^[，,。.!！?？\s]+", "", title)
    title = re.sub(r"^(?:在)?日历上", "", title)
    # Preserve this common compound noun. The generic trailing “提醒” cleanup
    # below is correct for “设置一个提醒”, but would damage “预约提醒”.
    if title == "预约提醒":
        return title
    # A numeric month-end marker can sit directly before the task in spoken
    # input (for example, “8月差不多末盘点库存” or “下月底前必须模拟考试”).
    # Remove only this leading temporal clause; words such as “周末” inside a
    # genuine event title remain untouched.
    title = re.sub(
        r"^(?:(?:下个月底|下个月末|下月底|下月末|"
        r"[0-9一二两三四五六七八九十]{1,2}月(?:底|末))前?"
        r"(?:必须|要|得|需要)?)+",
        "",
        title,
    )
    # Repetition markers and their explicit month/day payload are temporal
    # syntax, not the event name (for example, “每年7月20号接口联调”).
    title = re.sub(
        r"^(?:每(?:一)?(?:天|日)|每(?:额|呃|嗯|那个)?(?:周|星期|礼拜|月|年)|隔周)"
        r"(?:[0-9一二两三四五六七八九十]{1,2}月"
        r"[0-9一二两三四五六七八九十]{1,3}(?:号|日)?|"
        r"(?:周|星期|礼拜)[一二三四五六日天1-7])?(?:的)?",
        "",
        title,
    )
    if title == "预约提醒":
        return title
    title = re.sub(
        r"^(?:把这个放进日程|日程里加一下|帮我设一下|帮我记一下|帮我记|麻烦记录一下|麻烦记录|"
        r"给我安排|加个待办|记一条|我需要记住|我记住|提醒我)[，,。.]*",
        "",
        title,
    )
    # A creation wrapper can hide the recurrence marker during the first
    # pass (for example, “一个每周的预约提醒”). Remove that remaining
    # marker before the generic trailing-reminder cleanup.
    title = re.sub(r"^(?:一个|一条)?每周(?:的)?", "", title)
    if title == "预约提醒":
        return title
    title = re.sub(
        r"^请(?:在)?(?:帮我)?(?:创建|新建|安排|记录|记一下|添加|加一条)",
        "",
        title,
    )
    title = re.sub(r"^(?:为我的|为我|给我|帮我|麻烦)[，,。.]*", "", title)
    title = re.sub(
        r"^(?:记下|记住|记个|存一下|存下|保存一下|安排在|安排|定一个|预定一个|预订一个|"
        r"设置一个|设定一个|设一个|设定|创建一个|新建一个|排到|排在|定在|放在|"
        r"写进日历|写入日历|加到日历里|加进日历|放进日历|留给|留出|定个|排个时间|"
        r"设置|加到|加进|加入|加个|设成|设为|把|到|在|可以做|"
        r"想约个|想做|先把|先记着|先留着|先放着|有个|有一项)"
        r"[，,。.：:]*",
        "",
        title,
    )
    title = re.sub(r"^是+", "", title)
    title = re.sub(r"(?:并)?(?:重复|循环)$", "", title)
    title = re.sub(r"^从(?:现在)?开始", "", title)
    title = re.sub(r"^(?:都)?(?:需要|要|有)?(?:一个|一条)", "", title)
    title = re.sub(r"^去(?=(?:取|领取))", "", title)
    title = re.sub(r"^和我的(?=(?:同事|朋友|家人|同学))", "和", title)
    title = re.sub(r"^(?:原定|原来|原先)", "", title)
    title = re.sub(r"^我(?:和|跟|与)", "和", title)
    # Date/time stripping can leave the spoken shell “和李雷在有一个会面”.
    # Collapse only this lexical meeting form; do not remove ordinary “在…”
    # location/action wording from other titles.
    title = re.sub(
        r"^(?P<people>(?:和|跟|与).{1,24}?)在有(?:一个|个)?(?P<event>会面|见面|约见)$",
        r"\g<people>\g<event>",
        title,
    )
    title = re.sub(
        r"^(?P<people>(?:和|跟|与).{1,24}?)有(?:一个|个)?(?P<event>会议|会面|见面)$",
        r"\g<people>的\g<event>",
        title,
    )
    title = re.sub(r"先按重(?:复)?日程记.*$", "", title)
    title = re.sub(r"^都要?", "", title)
    title = re.sub(r"^(?:我要处理|我处理)", "", title)
    title = re.sub(r"^(?:前)?(?:必须|得|需要)", "", title)
    # Keep the task before a trailing self-correction clause.  This handles
    # "安排项目，不是三点，改成四点半" without turning the correction into
    # the title or falling back to "待办".
    if not re.fullmatch(r"(?:不是|不对|说错)", title):
        title = re.sub(r"^(?:不是|不对|说错)(?:是)?(?:那个)?", "", title)
        title = re.split(
            r"(?:不是|不对|说错|改成|改为|换成|调整到|最终改为|最后改为)",
            title,
            maxsplit=1,
        )[0]
    location_action = _extract_location_action(title)
    if location_action and re.match(r"^(?:在|地点|地址)", title):
        title = location_action[1]
    title = re.split(
        rf"(?:[，,。.!！?？]|(?:地点|地址|位置)\s*(?:在|是|为|去|到|往)?\s*(?:{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})$|"
        r"需要通知|重点是|主要确认|这件事和|(?<!^)带上)",
        title,
        maxsplit=1,
    )[0]
    title = re.sub(r"(?:持续处理|处理|完成|提交|整理|跟进|准备)?完$", "", title)
    title = re.sub(r"开个会议", "开会", title)
    title = re.sub(r"^在[^，,。.!！?？]{1,30}(?=开会|会议|见面|上课|办事)", "", title)
    # "开" is lexical in tasks such as "开发票".  Strip it only when the
    # remainder clearly names a meeting-like action.
    title = re.sub(
        r"^开(?=.{2,}(?:会|复盘|评审|培训|讨论|沟通|汇报|面试|发布会))",
        "",
        title,
    )
    title = re.sub(r"^(召开|举行|进行)(?=.{2,})", "", title)
    # Participant connectors carry real event information in spoken titles,
    # including meeting requests such as “和朋友开个会议”.
    title = re.sub(r"(?:先留着|先放着|先记着|留个位置|留点时间|留一点时间|要安排|时间再说|等会儿定时间)$", "", title)
    title = re.sub(r"(?:设置|设定)(?:一个)?(?:日程|提醒)$", "", title)
    title = re.sub(r"^的+", "", title)
    title = re.sub(
        rf"^在\s*(?:{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})\s*的",
        "",
        title,
    )
    title = re.sub(
        rf"^(?:{_LOCATION_TOKEN_PATTERN}{_LOCATION_LOCALIZER_PATTERN})\s*的",
        "",
        title,
    )
    # ``安排``/``提醒`` are often part of the spoken subject ("聚餐安排",
    # "电话提醒").  The old v4 rules removed command wrappers, but did not
    # erase these lexical suffixes from the user's title.
    title = re.sub(r"(?:排到|排在|安排在|放在|设成|设为|定在|定为|放进|放到|排进)$", "", title)
    return title.strip("，,。.!！?？的")


def _default_end_time(start_time: Optional[str]) -> Optional[str]:
    if not start_time:
        return None
    hour, minute = [int(part) for part in start_time.split(":")]
    hour = (hour + 1) % 24
    return f"{hour:02d}:{minute:02d}"


def _weekday_in_week(weekday: int, weeks_from_this: int) -> date:
    today = _current_date()
    monday = today - timedelta(days=today.weekday())
    return monday + timedelta(days=weeks_from_this * 7 + weekday)


def _next_weekday(weekday: int, include_today: bool = False) -> date:
    today = _current_date()
    delta = weekday - today.weekday()
    if delta < 0 or (delta == 0 and not include_today):
        delta += 7
    return today + timedelta(days=delta)


def _cn_to_int(value: Optional[str]) -> int:
    if not value:
        return 0
    if value.isdigit():
        return int(value)
    if value == "十":
        return 10
    if value.startswith("十"):
        return 10 + _CN_NUM_MAP.get(value[1:], 0)
    if "十" in value:
        left, right = value.split("十", 1)
        return _CN_NUM_MAP.get(left, 0) * 10 + (_CN_NUM_MAP.get(right, 0) if right else 0)
    total = 0
    for char in value:
        total = total * 10 + _CN_NUM_MAP.get(char, 0)
    return total


def _read_schedule_audio_bytes(audio_bytes: bytes, filename: str = "recording"):
    """Read short schedule audio from wav/flac/ogg or transcode phone m4a/aac via ffmpeg."""
    import io
    import os
    import subprocess
    import tempfile

    import numpy as np
    import soundfile as sf

    def _normalize(audio_data, sr):
        if getattr(audio_data, "ndim", 1) > 1:
            audio_data = audio_data.mean(axis=1)
        return np.asarray(audio_data, dtype=np.float32), int(sr)

    try:
        audio_io = io.BytesIO(audio_bytes)
        audio_data, sr = sf.read(audio_io, dtype="float32")
        return _normalize(audio_data, sr)
    except Exception as direct_error:
        suffix = os.path.splitext(filename or "recording.m4a")[1] or ".m4a"
        input_path = None
        output_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as src:
                src.write(audio_bytes)
                input_path = src.name
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as dst:
                output_path = dst.name
            cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                input_path,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-sample_fmt",
                "s16",
                output_path,
            ]
            subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=30)
            audio_data, sr = sf.read(output_path, dtype="float32")
            print(f"[Schedule-Audio] ffmpeg decoded {filename}: {len(audio_bytes)} bytes", flush=True)
            return _normalize(audio_data, sr)
        except Exception as ffmpeg_error:
            print(
                f"[Schedule-Audio] decode failed for {filename}: direct={direct_error}; ffmpeg={ffmpeg_error}",
                flush=True,
            )
            raise direct_error
        finally:
            for temp_path in (input_path, output_path):
                if temp_path:
                    try:
                        os.unlink(temp_path)
                    except OSError:
                        pass


async def parse_schedule_audio(
    audio_base64: str,
    filename: str,
    reference_datetime: Optional[str] = None,
    timezone_name: Optional[str] = None,
) -> Optional[dict]:
    """
    从音频 base64 解析日程：轻量 ASR 转写 -> 文本日程解析。

    Expo 手机端通常上传 m4a/aac，解码由 transcribe_schedule_audio 内部处理。
    """
    asr_result = await transcribe_schedule_audio(audio_base64, filename)
    if not asr_result:
        print("[ScheduleParser] ASR 无转写结果", flush=True)
        return None

    transcript_text = _schedule_asr_text(asr_result)
    if not transcript_text:
        print("[ScheduleParser] ASR 文本为空", flush=True)
        return None
    transcript_text = normalize_laoji_transcript(transcript_text)

    print(f"[ScheduleParser] ASR 结果: {transcript_text[:100]}", flush=True)
    parsed = await parse_schedule_text(transcript_text, reference_datetime, timezone_name)
    if parsed:
        parsed["raw_text"] = transcript_text
    return parsed


async def transcribe_schedule_audio(audio_base64: str, filename: str = "recording.wav") -> Optional[dict]:
    """轻量一句话 ASR：只做音频转文字，不触发会议离线管道和日程解析。"""
    import asyncio
    import numpy as np

    try:
        audio_bytes = _decode_schedule_audio_base64(audio_base64)
    except ValueError as exc:
        print(f"[Schedule-ASR] 音频载荷无效: {exc}", flush=True)
        return None

    from app.api.qwen_ws import _qwen_transcribe

    def _resample_linear(audio: np.ndarray, source_sr: int, target_sr: int = 16000) -> np.ndarray:
        if source_sr == target_sr:
            return audio.astype(np.float32)
        if len(audio) == 0:
            return audio.astype(np.float32)
        duration = len(audio) / float(source_sr)
        target_len = max(1, int(duration * target_sr))
        x_old = np.linspace(0, len(audio) - 1, num=len(audio), dtype=np.float32)
        x_new = np.linspace(0, len(audio) - 1, num=target_len, dtype=np.float32)
        return np.interp(x_new, x_old, audio).astype(np.float32)

    def _call():
        try:
            audio_data, sr = _read_schedule_audio_bytes(audio_bytes, filename)
            audio_data = _resample_linear(audio_data, int(sr), 16000)
            if len(audio_data) < 1600:
                return None

            pcm16 = (np.clip(audio_data, -1.0, 1.0) * 32767.0).astype(np.int16)
            result = _qwen_transcribe(
                pcm16.tobytes(),
                "Chinese",
                "schedule",
            )
            transcript_text = _schedule_asr_text(result)
            if not transcript_text:
                return None
            transcript = normalize_laoji_transcript(transcript_text)
            print(
                f"[Schedule-ASR] {filename}: {len(audio_data) / 16000:.2f}s -> {transcript[:120]}",
                flush=True,
            )
            if not transcript:
                return None
            return {
                "text": transcript,
                "duration_sec": round(len(audio_data) / 16000, 3),
                "provider": "qwen3-asr",
            }
        except Exception as e:
            print(f"[Schedule-ASR] 转写失败: {e}", flush=True)
            import traceback
            traceback.print_exc()
            return None

    return await asyncio.to_thread(_call)


_MAX_SCHEDULE_AUDIO_BYTES = 25 * 1024 * 1024


def _decode_schedule_audio_base64(value: object) -> bytes:
    """Strictly decode a short-audio payload before the shared 8030 ASR call."""
    import base64
    import binascii

    if not isinstance(value, str) or not value.strip():
        raise ValueError("audio payload is empty")
    payload = value.strip()
    if payload.startswith("data:"):
        separator = payload.find(",")
        metadata = payload[5:separator].lower() if separator >= 0 else ""
        if separator < 0 or "base64" not in {part.strip() for part in metadata.split(";") if part.strip()}:
            raise ValueError("audio data URI must be base64")
        payload = payload[separator + 1:]
    payload = re.sub(r"\s+", "", payload)
    if not payload or len(payload) % 4 == 1 or not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", payload):
        raise ValueError("audio payload is not valid base64")
    # A base64 string expands by 4/3; reject oversized requests before decode.
    if len(payload) > ((_MAX_SCHEDULE_AUDIO_BYTES + 2) // 3) * 4:
        raise ValueError("audio payload is too large")
    try:
        decoded = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("audio payload is not valid base64") from exc
    if not decoded:
        raise ValueError("audio payload is empty")
    if len(decoded) > _MAX_SCHEDULE_AUDIO_BYTES:
        raise ValueError("audio payload is too large")
    return decoded
