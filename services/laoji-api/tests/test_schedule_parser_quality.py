from datetime import date, datetime, timezone

import pytest

from app.services import schedule_parser_service as parser


def test_schedule_llm_context_defaults_to_shared_8192_runner(monkeypatch):
    monkeypatch.delenv("SCHEDULE_LLM_NUM_CTX", raising=False)
    assert parser._schedule_llm_num_ctx() == 8192

    monkeypatch.setenv("SCHEDULE_LLM_NUM_CTX", "4096")
    assert parser._schedule_llm_num_ctx() == 4096

    monkeypatch.setenv("SCHEDULE_LLM_NUM_CTX", "invalid")
    assert parser._schedule_llm_num_ctx() == 8192


def test_simple_command_stays_on_quick_path():
    assert parser._should_skip_quick_schedule_parse("明天下午三点开会") is False


def test_simple_undated_actions_return_unsaveable_rule_clarification_without_llm(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    def fail_if_called(*args, **kwargs):
        raise AssertionError("simple missing-date input must not call Ollama")

    monkeypatch.setattr(parser, "date", FixedDate)
    monkeypatch.setattr(parser, "call_ollama", fail_if_called)

    meeting = parser.parse_schedule_text_sync("开会")
    task = parser.parse_schedule_text_sync("提交材料")
    timed = parser.parse_schedule_text_sync("下午三点开会")

    assert meeting is not None
    assert meeting["title"] == "开会"
    # The current safety contract never fabricates today's date for an
    # undated request; the editor must ask for an explicit date first.
    assert meeting["start_date"] == ""
    assert meeting["start_time"] is None
    assert meeting["parse_source"] == "rules"
    assert meeting["needs_clarification"] is True
    assert meeting["clarification_question"] == "没有听到具体日期，需要补充日期。"
    assert task is not None and task["title"] == "提交材料"
    assert timed is not None and timed["start_time"] == "15:00"
    for text in ("取快递", "缴水电费", "预约牙医", "整理房间"):
        parsed = parser.parse_schedule_text_sync(text)
        assert parsed is not None
        assert parsed["parse_source"] == "rules"
        assert parsed["needs_clarification"] is True
    assert timed["needs_clarification"] is True


def test_ambiguous_or_non_schedule_undated_text_does_not_use_new_fast_path():
    assert parser._should_skip_quick_schedule_parse("开会地点可能在东门") is True
    assert parser._should_skip_quick_schedule_parse("不是开会，改成提交材料") is True
    for text in ("只是随便说句话", "我们交流一下", "我买了一个东西", "文件已经完成了"):
        assert parser._parse_schedule_text_quick(text) is None


def test_dated_event_without_clock_is_complete_all_day_schedule(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick("明天开会")

    assert parsed is not None
    assert parsed["start_date"] == "2026-07-14"
    assert parsed["start_time"] is None
    assert parsed["end_time"] is None
    assert parsed["is_all_day"] is True
    assert parsed["reminder_minutes"] is None
    assert parsed["needs_clarification"] is False
    assert parsed["clarification_question"] is None


def test_consecutive_relative_day_ranges_are_complete_spanning_schedules(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    cases = {
        "今明两天上班": ("2026-07-14", "2026-07-15"),
        "明后两天上班": ("2026-07-15", "2026-07-16"),
        "今明后三天值班": ("2026-07-14", "2026-07-16"),
        "今天和明天上班": ("2026-07-14", "2026-07-15"),
        "明天与后天上班": ("2026-07-15", "2026-07-16"),
    }
    for text, expected_range in cases.items():
        parsed = parser._parse_schedule_text_quick(text)
        assert parsed is not None
        assert (parsed["start_date"], parsed["end_date"]) == expected_range
        assert parsed["spanning"] is True
        assert parsed["needs_clarification"] is False
        assert parsed["clarification_question"] is None
        assert parser._has_date_signal(text) is True

    work = parser._parse_schedule_text_quick("今明两天上班")
    assert work is not None
    assert work["title"] == "上班"
    assert work["category"] == "工作"


def test_compact_relative_range_clears_stale_model_date_question(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "上班",
            "start_date": "2026-07-14",
            "end_date": "2026-07-15",
            "is_all_day": True,
            "category": "工作",
            "needs_clarification": True,
            "clarification_question": "没有听到具体日期，需要补充日期。",
        },
        "今明两天上班",
    )

    assert parsed is not None
    assert parsed["start_date"] == "2026-07-14"
    assert parsed["end_date"] == "2026-07-15"
    assert parsed["needs_clarification"] is False
    assert parsed["clarification_question"] is None


def test_fuzzy_period_without_clock_does_not_leak_into_all_day_title(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick("明天下午开会")
    compound = parser._parse_schedule_text_quick("明天下午茶聚会")

    assert parsed is not None
    assert parsed["title"] == "开会"
    assert parsed["start_time"] is None
    assert parsed["time_period"] == "afternoon"
    assert parsed["is_all_day"] is False
    assert parsed["needs_clarification"] is False
    assert compound is not None
    assert compound["title"] == "下午茶聚会"


def test_afternoon_range_inherits_period_for_the_end_clock(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick("明天下午三点半到五点开会")

    assert parsed is not None
    assert parsed["title"] == "开会"
    assert parsed["start_date"] == "2026-07-14"
    assert parsed["start_time"] == "15:30"
    assert parsed["end_time"] == "17:00"
    assert parsed["is_all_day"] is False


@pytest.mark.parametrize(
    ("text", "start_time", "end_time", "title"),
    [
        ("明天下午三点半开会到五点", "15:30", "17:00", "开会"),
        ("明天上午九点培训到十一点", "09:00", "11:00", "培训"),
        ("明天14:30做评审到16:00", "14:30", "16:00", "评审"),
        ("后天傍晚六点跑步到七点半", "18:00", "19:30", "跑步"),
        ("明天上午十点上课到下午两点", "10:00", "14:00", "上课"),
    ],
)
def test_spoken_time_ranges_accept_subject_between_bounds(
    monkeypatch,
    text,
    start_time,
    end_time,
    title,
):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(text)

    assert parsed is not None
    assert parsed["title"] == title
    assert parsed["start_time"] == start_time
    assert parsed["end_time"] == end_time
    assert parsed["needs_clarification"] is False


def test_time_replacement_is_not_misclassified_as_a_range():
    text = "明天下午三点开会改到五点"
    assert parser._should_skip_quick_schedule_parse(text) is True


def test_clarification_qualifies_existing_clock_without_reparsing_draft(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    current = {
        "title": "项目复盘",
        "event_type": "once",
        "start_date": "2026-07-14",
        "end_date": None,
        "start_time": None,
        "end_time": None,
        "is_all_day": False,
        "location": "A301",
        "category": "工作",
        "raw_text": "明天五点在A301做项目复盘",
        "needs_clarification": True,
        "clarification_question": "五点没有说明上午还是下午，需要确认具体时段。",
    }

    parsed = parser._apply_schedule_clarification_impl(current, "下午")

    assert parsed is not None
    assert parsed["title"] == "项目复盘"
    assert parsed["start_date"] == "2026-07-14"
    assert parsed["start_time"] == "17:00"
    assert parsed["end_time"] == "18:00"
    assert parsed["location"] == "A301"
    assert parsed["needs_clarification"] is False
    assert "补充：下午" in parsed["raw_text"]


def test_clarification_changes_only_the_requested_location():
    current = {
        "title": "项目复盘",
        "event_type": "once",
        "start_date": "2026-07-14",
        "end_date": None,
        "start_time": "15:30",
        "end_time": "17:00",
        "is_all_day": False,
        "location": None,
        "category": "工作",
        "raw_text": "明天下午三点半到五点做项目复盘，地点还没定",
        "needs_clarification": True,
        "clarification_question": "地点还不确定，需要确认最终地点。",
    }

    parsed = parser._apply_schedule_clarification_impl(current, "改成A301")

    assert parsed is not None
    assert parsed["location"] == "A301"
    assert parsed["title"] == current["title"]
    assert parsed["start_date"] == current["start_date"]
    assert parsed["start_time"] == current["start_time"]
    assert parsed["end_time"] == current["end_time"]
    assert parsed["needs_clarification"] is False


def test_model_time_only_question_is_cleared_but_missing_date_still_blocks(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    dated = parser._normalize_llm_result(
        {
            "title": "开会",
            "start_date": "2026-07-14",
            "start_time": None,
            "end_time": None,
            "is_all_day": True,
            "category": "工作",
            "needs_clarification": True,
            "clarification_question": "没有听到具体时间，是否作为全天事项保存？",
        },
        "明天开会",
    )
    missing_date = parser._normalize_llm_result(
        {
            "title": "开会",
            "start_date": "2026-07-14",
            "start_time": None,
            "end_time": None,
            "is_all_day": True,
            "category": "工作",
            "needs_clarification": False,
            "clarification_question": None,
        },
        "开会",
    )

    assert dated is not None
    assert dated["needs_clarification"] is False
    assert dated["clarification_question"] is None
    assert missing_date is not None
    assert missing_date["needs_clarification"] is True
    assert "具体日期" in missing_date["clarification_question"]


def test_relative_offset_is_a_complete_quick_datetime_across_midnight(monkeypatch):
    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 7, 13, 23, 50, 48, tzinfo=tz)

    monkeypatch.setattr(parser, "datetime", FixedDateTime)
    parsed = parser._parse_schedule_text_quick("十五分钟后提醒我提交材料")
    half_hour = parser._parse_schedule_text_quick("半个小时以后出门")

    assert parsed is not None
    assert parsed["title"] == "提交材料"
    assert parsed["start_date"] == "2026-07-14"
    assert parsed["start_time"] == "00:05"
    assert parsed["end_time"] == "01:05"
    assert parsed["reminder_minutes"] == 0
    assert parsed["needs_clarification"] is False
    assert parsed["clarification_question"] is None
    assert half_hour is not None and half_hour["start_time"] == "00:20"


def test_relative_offset_clears_a_stale_model_date_question(monkeypatch):
    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 7, 13, 20, 0, 0, tzinfo=tz)

    monkeypatch.setattr(parser, "datetime", FixedDateTime)
    parsed = parser._normalize_llm_result(
        {
            "title": "十五分钟后做某事",
            "start_date": "2026-07-13",
            "start_time": "20:15",
            "end_time": "21:15",
            "is_all_day": False,
            "category": "其他",
            "needs_clarification": True,
            "clarification_question": "没有听到具体日期，是否安排在今天？",
        },
        "十五分钟后做某事",
    )

    assert parsed is not None
    assert parsed["title"] == "做某事"
    assert parsed["start_date"] == "2026-07-13"
    assert parsed["start_time"] == "20:15"
    assert parsed["needs_clarification"] is False
    assert parsed["clarification_question"] is None


def test_sparse_asr_fillers_inside_correction_force_model_path():
    variants = [
        "整理发票不呃是今天，是下周二下午四点半",
        "整理发票不，那个，对今天，改成下周二下午四点半",
        "整理发票说嗯错今天，改额成下周二下午四点半",
    ]
    assert all(parser._should_skip_quick_schedule_parse(text) for text in variants)


@pytest.mark.parametrize(
    ("text", "expected_title"),
    [
        ("呃，明天下午三点那个就是和产品组讨论一下发布方案", "和产品组讨论发布方案"),
        ("嗯，然后下周二上午十点我需要那个整理一下验收清单", "整理验收清单"),
        ("明天晚上八点，就是那个，记一下给妈妈打电话", "给妈妈打电话"),
        ("呃，8月10号下午两点，那个我想说安排一下和供应商确认合同细节", "和供应商确认合同细节"),
    ],
)
def test_quick_schedule_titles_remove_spoken_control_shell(text, expected_title, monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 7)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(text)

    assert parsed is not None
    assert parsed["title"] == expected_title


def test_sparse_asr_fillers_inside_date_ranges_are_recovered(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    cases = {
        "7月21号到然后下周日准备寄文件": ("2026-07-21", "2026-07-26"),
        "从7月18日始到8月5号发邮件": ("2026-07-18", "2026-08-05"),
        "8月2号到8月嗯5号取快递": ("2026-08-02", "2026-08-05"),
        "本月25号到可能8月5号修空调": ("2026-07-25", "2026-08-05"),
    }
    for text, expected in cases.items():
        parsed = parser._parse_schedule_text_quick(text)
        assert parsed is not None
        assert (parsed["start_date"], parsed["end_date"]) == expected


def test_multi_sentence_and_conflicting_range_use_model_path():
    text = "记一条。2026年8月6日下午两点需求评审。标题就写需求评审。"
    assert parser._should_skip_quick_schedule_parse(text) is True
    # Reversed ranges use the deterministic safety path so the spoken start
    # date is preserved and the unsafe end is cleared for clarification.
    assert parser._should_skip_quick_schedule_parse("7月21号到7月18号提交材料") is False
    assert parser._should_skip_quick_schedule_parse(
        "我需要记住，下月底10:20我要处理邻居沟通装修，这次主要是提醒我按时到"
    ) is True


def test_conditional_and_undecided_time_requests_use_model_path():
    cases = [
        "帮我记一条：本周五下午和客户线上沟通，具体时间等对方确认。",
        "把今天的产品评审改到明天下午，如果明天没有空就安排到周四上午。",
        "我想在月底前找一个两小时的时间和研发、设计一起讨论下一版本。",
        "下周一到下周三安排项目启动会，时间根据会议室空闲决定。",
    ]
    assert all(parser._should_skip_quick_schedule_parse(text) for text in cases)


def test_model_title_does_not_use_conditional_correction_tail():
    raw_text = "把今天的产品评审改到明天下午，如果明天没有空就安排到周四上午。"
    parsed = parser._normalize_llm_result(
        {
            "title": "如果没有空就安",
            "event_type": "once",
            "start_date": "2026-08-06",
            "category": "工作",
            "needs_clarification": True,
            "clarification_question": "需要确认时间。",
        },
        raw_text,
    )

    assert parsed is not None
    assert parsed["title"] == "产品评审"


def test_correction_without_subject_does_not_use_field_label_as_title():
    assert parser._extract_pre_correction_subject("日期改到明天下午") is None


@pytest.mark.parametrize(
    "text",
    [
        "不是今天，改成10月3日晚上七点做项目汇报",
        "原来想排这周六，改到周末下午一点预算评审",
        "不是月初，改成下周三上午九点做设备借用",
    ],
)
def test_correction_without_old_subject_uses_authoritative_tail(text):
    # The discarded date phrase is not an event title, and a correction is
    # not a date range even though both sides contain date-like words.
    assert parser._extract_pre_correction_subject(text) is None
    parsed = parser._parse_schedule_text_quick(text)
    assert parsed is not None
    assert parsed["title"] not in {"不", "想排"}
    assert parsed["needs_clarification"] is False


def test_model_surface_title_removes_operation_verb_from_correction():
    parsed = parser._normalize_llm_result(
        {
            "title": "做牙医洗牙",
            "event_type": "once",
            "start_date": "2026-08-12",
            "start_time": "19:00",
            "needs_clarification": False,
        },
        "不是下周六，改成今天晚上七点做牙医洗牙",
    )
    assert parsed is not None
    assert parsed["title"] == "牙医洗牙"


def test_model_temporal_reasoning_ignores_date_like_title_words():
    context = parser._ScheduleParseContext(
        datetime(2027, 1, 13, 0, 24, tzinfo=timezone.utc),
        "Asia/Shanghai",
    )
    token = parser._ACTIVE_PARSE_CONTEXT.set(context)
    try:
        relative = parser._normalize_llm_result(
            {
                "title": "周末酒店房型确认",
                "event_type": "once",
                "start_date": "2027-01-16",
                "start_time": "09:00",
                "needs_clarification": False,
            },
            "不是1月15日，改成后天上午九点做周末酒店房型确认",
        )
        explicit = parser._normalize_llm_result(
            {
                "title": "周末酒店评价",
                "event_type": "once",
                "start_date": "2027-02-21",
                "start_time": "20:00",
                "needs_clarification": False,
            },
            "把周末酒店评价放到2月21日晚上八点，提前十五分钟提醒我",
        )
    finally:
        parser._ACTIVE_PARSE_CONTEXT.reset(token)
    assert relative is not None
    assert relative["start_date"] == "2027-01-15"
    assert relative["needs_clarification"] is False
    assert explicit is not None
    assert explicit["start_date"] == "2027-02-21"
    assert explicit["needs_clarification"] is False


def test_surface_title_wins_over_small_model_modifier():
    assert parser._prefer_surface_title("半年度医院复诊", "年度医院复诊") is True


def test_surface_title_wins_over_model_anagram():
    assert parser._prefer_surface_title("预订重要酒店", "重要酒店预订") is True


def test_recurrence_markers_inside_title_do_not_force_model_clarification():
    context = parser._ScheduleParseContext(
        datetime(2027, 4, 16, 0, 53, tzinfo=timezone.utc),
        "Asia/Shanghai",
    )
    token = parser._ACTIVE_PARSE_CONTEXT.set(context)
    try:
        parsed = parser._normalize_llm_result(
            {
                "title": "工作日早餐预约",
                "event_type": "once",
                "start_date": "2027-04-17",
                "start_time": "13:00",
                "needs_clarification": False,
            },
            "原来想排4月29号，改到明天下午一点工作日早餐预约",
        )
    finally:
        parser._ACTIVE_PARSE_CONTEXT.reset(token)
    assert parsed is not None
    assert parsed["start_date"] == "2027-04-17"
    assert parsed["needs_clarification"] is False


def test_model_path_recovers_explicit_location_clause():
    parsed = parser._normalize_llm_result(
        {
            "title": "周末志愿签到",
            "event_type": "once",
            "start_date": "2027-03-31",
            "start_time": "08:30",
            "needs_clarification": False,
        },
        "给周末志愿签到定在月底上午八点半，地点去培训室",
    )
    assert parsed is not None
    assert parsed["location"] == "培训室"


def test_explicit_title_clause_wins_over_instruction_text():
    title, description = parser._extract_title_and_description(
        "2026年8月6日下午两点需求评审。标题不要太长，就写需求评审"
    )
    assert title == "需求评审"
    assert description is None


def test_category_uses_event_title_before_location_or_participant_words():
    assert parser._infer_category("整理衣柜", "整理衣柜，在咖啡店靠窗位置") == "生活"
    assert parser._infer_category("体检", "体检，地点在研发区小会议室") == "健康"


def test_recurrence_tolerates_sparse_asr_fillers():
    yearly = parser._parse_schedule_text_quick(
        "给我安排，每额年7月20号下午两点提醒我接口联调"
    )
    weekly = parser._parse_schedule_text_quick(
        "从现在开始周三16:40都要线上培训，先按重日程记"
    )
    assert yearly is not None and yearly["event_type"] == "yearly"
    assert weekly is not None and weekly["event_type"] == "weekly"
    assert yearly["title"] == "接口联调"
    assert weekly["title"] == "线上培训"


def test_recurrence_removes_repair_preface_and_isolated_asr_noise(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(
        "刚才说漏了，每日1 差不多 9:30实验报告。"
    )
    normal_clock = parser._parse_schedule_text_quick("每日19:30整理实验报告")

    assert parsed is not None
    assert parsed["title"] == "实验报告"
    assert parsed["event_type"] == "daily"
    assert parsed["start_time"] == "09:30"
    assert parsed["category"] == "学习"
    assert normal_clock is not None and normal_clock["start_time"] == "19:30"


def test_implicit_near_year_long_range_requires_year_confirmation(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    raw_text = "投诉回访要在8月2号到7月23号之间处理"
    model_result = {
        "title": "投诉回访处理",
        "start_date": "2026-08-02",
        "end_date": "2027-07-23",
        "start_time": None,
        "end_time": None,
        "is_all_day": True,
        "category": "工作",
        "needs_clarification": True,
        "clarification_question": "是否需要每天进行？",
    }

    parsed = parser._normalize_llm_result(model_result, raw_text)
    explicit = parser._parse_schedule_text_quick(
        "2026年8月2号到2027年7月23号长期项目"
    )

    # An apparently near-year range is intentionally sent to the model path
    # for a separate year/order confirmation; only ordinary reversed ranges
    # use the deterministic fail-safe path.
    assert parser._should_skip_quick_schedule_parse(raw_text) is True
    assert parsed is not None
    assert parsed["start_date"] == "2026-08-02"
    assert parsed["end_date"] == "2027-07-23"
    assert parsed["needs_clarification"] is True
    assert parsed["clarification_question"] == (
        "结束日期按 2027-07-23 处理会形成跨年长日程，需要确认年份和起止顺序。"
    )
    assert explicit is not None and explicit["needs_clarification"] is False


def test_daily_phrase_preserves_explicit_start_and_finite_range(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 12)

    monkeypatch.setattr(parser, "date", FixedDate)
    bounded = parser._parse_schedule_text_quick(
        "下周一到下周三在上海参加培训，每天上午九点开始"
    )
    open_ended = parser._parse_schedule_text_quick(
        "从下周一开始每天上午九点复习英语"
    )

    assert bounded is not None
    # A finite "每天" range remains a daily recurrence with an end date; it
    # must not be flattened into a one-off event.
    assert bounded["event_type"] == "daily"
    assert bounded["start_date"] == "2026-07-13"
    assert bounded["end_date"] == "2026-07-15"
    assert bounded["spanning"] is True
    assert open_ended is not None
    assert open_ended["event_type"] == "daily"
    assert open_ended["start_date"] == "2026-07-13"
    assert open_ended["end_date"] is None
    assert open_ended["title"] == "复习英语"
    assert open_ended["category"] == "学习"


def test_llm_result_without_spoken_date_or_time_is_forced_to_clarify():
    parsed = parser._normalize_llm_result(
        {
            "title": "确认办理值机",
            "event_type": "once",
            "start_date": "2026-07-10",
            "end_date": None,
            "start_time": None,
            "end_time": None,
            "is_all_day": False,
            "category": "出行",
            "reminder_minutes": 15,
            "confidence": 0.9,
            "needs_clarification": False,
        },
        "提醒我找运营同事确认办理值机",
    )
    assert parsed is not None
    # No spoken date means this is an incomplete draft, not a confirmed
    # all-day event.
    assert parsed["is_all_day"] is False
    assert parsed["reminder_minutes"] is None
    assert parsed["needs_clarification"] is True
    assert "具体日期" in parsed["clarification_question"]


def test_llm_result_uses_default_duration_when_model_repeats_start_time():
    parsed = parser._normalize_llm_result(
        {
            "title": "需求评审",
            "start_date": "2026-08-06",
            "start_time": "14:00",
            "end_time": "14:00",
            "is_all_day": False,
            "category": "工作",
            "needs_clarification": False,
        },
        "2026年8月6日下午两点需求评审",
    )
    assert parsed is not None
    assert parsed["end_time"] == "15:00"


def test_llm_cannot_silently_reverse_a_conflicting_date_range():
    parsed = parser._normalize_llm_result(
        {
            "title": "提交材料",
            "start_date": "2026-07-18",
            "end_date": "2026-07-21",
            "start_time": None,
            "is_all_day": True,
            "category": "工作",
            "needs_clarification": False,
        },
        "7月21号到7月18号提交材料",
    )
    assert parsed is not None
    assert parsed["start_date"] == "2026-07-21"
    assert parsed["end_date"] is None
    assert parsed["needs_clarification"] is True
    assert "先后顺序有矛盾" in parsed["clarification_question"]


def test_clear_spoken_weekday_overrides_model_date(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 10)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "处理核对账单",
            "start_date": "2026-07-16",
            "start_time": "10:20",
            "end_time": None,
            "is_all_day": False,
            "category": "财务",
            "needs_clarification": False,
        },
        "本周五10:20我要处理核对账单",
    )
    assert parsed is not None
    assert parsed["start_date"] == "2026-07-10"
    assert parsed["title"] == "核对账单"


def test_single_corrected_weekday_and_time_override_model_guess(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 12)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "本周五下午三点安全培训",
            "start_date": "2026-07-16",
            "start_time": "14:00",
            "end_time": "15:00",
            "is_all_day": False,
            "category": "学习",
            "needs_clarification": False,
        },
        "把刚才那个安全培训改成本周五下午三点，不是原来的时间。",
    )
    assert parsed is not None
    assert parsed["title"] == "安全培训"
    assert parsed["start_date"] == "2026-07-10"
    assert parsed["start_time"] == "15:00"
    assert parsed["end_time"] == "16:00"


def test_llm_temporal_title_is_rebuilt_from_the_spoken_event(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 12)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "周六凌晨更新预算表",
            "start_date": "2026-07-11",
            "start_time": "01:00",
            "end_time": "02:00",
            "is_all_day": False,
            "category": "工作",
            "needs_clarification": False,
        },
        "帮我记一下。这周六凌晨一点更新预算表。重点是别漏掉白名单。",
    )
    assert parsed is not None
    assert parsed["title"] == "更新预算表"


def test_quick_path_removes_complete_next_month_end_marker_from_title(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 12)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(
        "下月底23:00前必须模拟考试，提前十分钟提醒。"
    )
    assert parsed is not None
    assert parsed["title"] == "模拟考试"
    assert parsed["start_date"] == "2026-08-31"
    assert parsed["reminder_minutes"] == 10


def test_quick_path_repairs_asr_omitted_hour_character(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 12)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(
        "老纪 下周一 上午十点半 提交材料 提前两时提醒"
    )
    assert parsed is not None
    assert parsed["title"] == "提交材料"
    assert parsed["reminder_minutes"] == 120


def test_exact_deadline_with_date_and_clock_does_not_force_clarification():
    question = parser._infer_clarification_question(
        raw_text="买保险截止是下周六中午十二点",
        is_all_day=False,
        start_time="12:00",
        end_date=None,
    )
    assert question is None


def test_broken_date_range_requests_range_clarification():
    question = parser._infer_clarification_question(
        raw_text="从下周一开始到8，别忘了，月5号，把缴纳报名费提交完",
        is_all_day=True,
        start_time=None,
        end_date=None,
    )
    assert question == "听到了日期范围，但开始或结束日期不够清楚，需要确认完整的起止日期。"


def test_recovered_date_range_replaces_model_guess_and_stale_question(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 12)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "缴纳报名费",
            "start_date": "2026-07-13",
            "end_date": "2026-07-19",
            "start_time": None,
            "end_time": None,
            "is_all_day": True,
            "category": "财务",
            "needs_clarification": True,
            "clarification_question": "是否是7月19日？",
        },
        "从下周一开始到8，别忘了，月5号，把缴纳报名费提交完。",
    )
    assert parsed is not None
    assert parsed["start_date"] == "2026-07-13"
    assert parsed["end_date"] == "2026-08-05"
    assert parsed["spanning"] is True
    assert parsed["needs_clarification"] is False
    assert parsed["clarification_question"] is None


def test_explicit_spanning_range_clears_only_range_questions(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    base = {
        "title": "取快递",
        "start_date": "2026-08-02",
        "end_date": "2026-08-05",
        "start_time": None,
        "end_time": None,
        "is_all_day": True,
        "category": "生活",
        "needs_clarification": True,
    }
    range_question = parser._normalize_llm_result(
        {**base, "clarification_question": "您希望在8月2号到8月5号之间的哪一天取快递？"},
        "取快递要在8月2号到8月5号之间处理，别只记一天。",
    )
    location_question = parser._normalize_llm_result(
        {**base, "location": "东门", "clarification_question": "地点是否确定为东门？"},
        "8月2号到8月5号取快递，地点可能是东门。",
    )

    assert range_question is not None
    assert range_question["end_date"] == "2026-08-05"
    assert range_question["needs_clarification"] is False
    assert range_question["clarification_question"] is None
    assert location_question is not None
    assert location_question["needs_clarification"] is True
    assert location_question["clarification_question"] == "地点还不确定，需要确认最终地点。"


def test_same_day_range_clarifies_when_user_explicitly_rejects_a_single_day(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    model_result = {
        "title": "整理发票",
        "event_type": "once",
        "start_date": "2026-07-20",
        "end_date": None,
        "category": "财务",
        "needs_clarification": False,
    }
    contradictory = parser._normalize_llm_result(
        model_result,
        "整理发票要在下周一到7月20日之间处理，别只记一天。",
    )
    ordinary = parser._normalize_llm_result(
        model_result,
        "整理发票要在下周一到7月20日之间处理。",
    )

    assert contradictory is not None
    assert contradictory["start_date"] == "2026-07-20"
    assert contradictory["end_date"] is None
    assert contradictory["needs_clarification"] is True
    assert "落在同一天" in contradictory["clarification_question"]
    assert ordinary is not None
    assert ordinary["needs_clarification"] is False


def test_uncertain_location_is_not_silently_accepted(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    text = "8月2号到8月5号取快递，地点可能是东门。"
    assert parser._should_skip_quick_schedule_parse(text) is True
    parsed = parser._normalize_llm_result(
        {
            "title": "取快递",
            "start_date": "2026-08-02",
            "end_date": "2026-08-05",
            "start_time": None,
            "end_time": None,
            "is_all_day": True,
            "location": "东门",
            "category": "生活",
            "needs_clarification": False,
            "clarification_question": None,
        },
        text,
    )
    assert parsed is not None
    assert parsed["end_date"] == "2026-08-05"
    assert parsed["needs_clarification"] is True
    assert parsed["clarification_question"] == "地点还不确定，需要确认最终地点。"


def test_confirmation_document_is_kept_in_quick_title(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 12)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(
        "2026年8月6日下午四点半考试确认单打印"
    )
    assert parsed is not None
    assert parsed["title"] == "考试确认单打印"


def test_explicit_next_month_day_and_asr_meta_text_are_normalized(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 1)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(
        "日程里加一下下月20号16:40公开课直播声音可能有点小"
    )
    assert parsed is not None
    assert parsed["title"] == "公开课直播"
    assert parsed["start_date"] == "2026-08-20"
    assert parsed["start_time"] == "16:40"


def test_asr_do_not_drop_date_meta_text_does_not_leak_into_title(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 12)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(
        "7月15号10:20亲戚拜访嗯不要漏掉前面日期"
    )
    assert parsed is not None
    assert parsed["title"] == "亲戚拜访"


@pytest.mark.parametrize(
    ("text", "expected_title", "expected_location", "expected_category"),
    [
        ("下周三下午两点到四点在A301复盘项目", "复盘项目", "A301", "工作"),
        ("明天下午三点在图书馆复习英语", "复习英语", "图书馆", "学习"),
        ("周五上午十点在健身房缴水电费", "缴水电费", "健身房", "财务"),
        ("明天上午九点在会议室开会", "开会", "会议室", "工作"),
        ("明天下午三点在家整理房间", "整理房间", "家", "生活"),
        ("周五下午两点在上海图书馆复习", "复习", "上海图书馆", "学习"),
        ("下周一上午九点在图书馆附近集合后出发", "集合后出发", "图书馆附近", "出行"),
    ],
)
def test_quick_path_separates_location_from_following_action(
    monkeypatch,
    text,
    expected_title,
    expected_location,
    expected_category,
):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(text)
    assert parsed is not None
    assert parsed["title"] == expected_title
    assert parsed["location"] == expected_location
    assert parsed["category"] == expected_category


@pytest.mark.parametrize(
    "text",
    [
        "明天下午三点在公司群里确认方案",
        "周五上午十点在家人面前讨论预算",
    ],
)
def test_location_action_split_does_not_match_non_adjacent_actions(text):
    assert parser._extract_location_action(text) is None


@pytest.mark.parametrize(
    "text",
    [
        "明天下午三点在公司群里确认方案",
        "周五上午十点在家人面前讨论预算",
    ],
)
def test_quick_path_does_not_treat_conversation_context_as_location(monkeypatch, text):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_schedule_text_quick(text)
    assert parsed is not None
    assert parsed["location"] is None


def test_compact_prompt_only_requires_model_owned_fields():
    prompt = parser._SYSTEM_PROMPT_TEMPLATE

    # vNext keeps calendar dates/times as evidence phrases and resolves them
    # deterministically after generation; the old start_date-only contract is
    # intentionally no longer part of the model-owned prompt.
    assert len(prompt) < 2600
    assert "JSON 必须包含：title、event_type、category、needs_clarification、date_phrase、time_phrase、recurrence_phrase" in prompt
    assert "color" not in prompt
    assert "confidence" not in prompt
    assert "reminder_minutes" not in prompt


def test_compact_model_fields_are_overridden_by_spoken_schedule_facts(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "核对账单",
            "event_type": "weekly",
            "start_date": "2026-07-17",
            "start_time": "02:34",
            "category": "财务",
            "needs_clarification": False,
        },
        "本周五10:20核对账单，提前十分钟提醒。",
    )

    assert parsed is not None
    assert parsed["event_type"] == "once"
    assert parsed["start_date"] == "2026-07-17"
    assert parsed["start_time"] == "10:20"
    assert parsed["end_time"] == "11:20"
    assert parsed["reminder_minutes"] == 10


def test_model_only_range_evidence_supplies_both_clocks(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 19)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_model_only_result(
        {
            "title": "开会",
            "event_type": "once",
            "category": "工作",
            "needs_clarification": False,
            "date_phrase": "明天",
            "time_phrase": "下午三点半到五点",
            "end_time_phrase": "五点",
        },
        "明天下午三点半到五点开会",
    )

    assert parsed is not None
    assert parsed["start_date"] == "2026-08-20"
    assert parsed["start_time"] == "15:30"
    assert parsed["end_time"] == "17:00"


def test_model_only_range_requires_contiguous_source_evidence():
    parsed = parser._normalize_model_only_result(
        {
            "title": "开会",
            "event_type": "once",
            "category": "工作",
            "needs_clarification": False,
            "date_phrase": "明天",
            "time_phrase": "下午三点半开会到五点",
            "end_time_phrase": "五点",
        },
        "明天下午三点半开会到五点",
    )

    assert parsed is not None
    assert parsed["start_time"] == "15:30"
    assert parsed["end_time"] == "17:00"


def test_corrected_weekday_with_clock_range_is_not_a_date_range(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 15)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "版本复盘",
            "event_type": "once",
            "start_date": "2026-07-23",
            "start_time": "14:00",
            "end_time": "16:00",
            "category": "工作",
            "needs_clarification": False,
        },
        "我想想啊，不是周四，是下周五下午两点到四点在三楼会议室做版本复盘",
    )

    assert parsed is not None
    assert parsed["start_date"] == "2026-07-24"
    assert parsed["start_time"] == "14:00"
    assert parsed["end_time"] == "16:00"
    assert parsed["needs_clarification"] is False
    assert parsed["clarification_question"] is None


def test_reminder_quantity_cannot_become_a_clock_time(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "报名截止处理",
            "event_type": "once",
            "start_date": "2026-07-22",
            "start_time": "02:34",
            "category": "重要",
            "needs_clarification": True,
            "clarification_question": "请确认提醒时间。",
        },
        "报名截止要在下周三到7月18号之间处理，提前两小时提醒。",
    )

    assert parsed is not None
    assert parsed["start_time"] is None
    assert parsed["end_time"] is None
    assert parsed["is_all_day"] is True
    assert parsed["reminder_minutes"] is None
    assert "先后顺序" in parsed["clarification_question"]


def test_optional_model_questions_and_placeholder_locations_are_removed(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._normalize_llm_result(
        {
            "title": "缴水电费",
            "event_type": "once",
            "start_date": "2026-07-17",
            "start_time": "12:00",
            "category": "财务",
            "location": "未指定",
            "needs_clarification": True,
            "clarification_question": "请确认同学群具体有几个人。",
        },
        "本周五中午十二点缴水电费，和同学群一起。",
    )

    assert parsed is not None
    assert parsed["location"] is None
    assert parsed["needs_clarification"] is False
    assert parsed["clarification_question"] is None


def test_sparse_date_noise_is_repaired_before_quick_parsing(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    month_end = parser._parse_schedule_text_quick("老记老记月先这样底10:20同事送别饭")
    split_day = parser._parse_schedule_text_quick("7月1就是5号下午一点半上线前检查")

    assert month_end is not None and month_end["start_date"] == "2026-07-31"
    assert month_end["start_time"] == "10:20"
    assert split_day is not None and split_day["start_date"] == "2026-07-15"
    assert split_day["start_time"] == "13:30"


def test_explicit_month_end_survives_filler_without_leaking_into_title(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    current = parser._parse_schedule_text_quick("7月先这样底安排盘点")
    future = parser._parse_schedule_text_quick("8月差不多末盘点库存")
    range_event = parser._parse_schedule_text_quick("7月18日到8月底整理数据")

    assert current is not None
    assert current["start_date"] == "2026-07-31"
    assert current["title"] == "盘点"
    assert future is not None
    assert future["start_date"] == "2026-08-31"
    assert future["title"] == "盘点库存"
    assert range_event is not None
    assert range_event["start_date"] == "2026-07-18"
    assert range_event["end_date"] == "2026-08-31"


def test_explicit_year_month_end_and_past_month_rollover(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)

    assert parser._parse_explicit_or_relative_date("2027年2月底") == date(2027, 2, 28)
    assert parser._parse_explicit_or_relative_date("6月末") == date(2027, 6, 30)


def test_meta_controls_do_not_hide_real_schedule_requests():
    assert parser._is_non_schedule_control_text("我想看看解析失败时会怎么提示。") is True
    assert parser._is_non_schedule_control_text("明天这个词出现了，但是让我安排明天") is True
    assert parser._is_non_schedule_control_text("今天挺忙，但我还没决定要记什么。") is True
    assert parser._is_non_schedule_control_text("明天下午三点讨论解析失败提示") is False


def test_deferred_detail_model_null_has_limited_rule_fallback(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 14)

    monkeypatch.setattr(parser, "date", FixedDate)
    parsed = parser._parse_llm_response("null", "14:05开发票，日期还没想好。")
    unrelated = parser._parse_llm_response("null", "这只是普通聊天。")

    assert parsed is not None
    assert parsed["title"] == "开发票"
    assert parsed["start_time"] == "14:05"
    assert parsed["needs_clarification"] is True
    assert "具体日期" in parsed["clarification_question"]
    assert unrelated is None
