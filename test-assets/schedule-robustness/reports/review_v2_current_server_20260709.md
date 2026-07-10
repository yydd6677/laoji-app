# LaoJi Schedule Review Diagnostics v2

- Input: `test-assets/schedule-robustness/schedule_review_samples_1000_20260709_v2.txt`
- Endpoint: `http://183.36.243.124:8035/api/laoji/parse`
- Total: 1000
- Rows with issues: 743
- Elapsed: 80789 ms
- Parse sources: `{'rules': 968, 'local_llm': 24, 'None': 8}`
- Duration ms: `{'min': 485, 'median': 514.0, 'mean': 637.9, 'p90': 798, 'max': 6782}`

## Issue Counts
- category_mismatch: 632
- complex_swallowed_by_rules: 207
- date_range_missing_end_date: 57
- parse_error: 8
- slow_call: 4
- negative_false_positive: 3
- recurring_as_once: 2
- ambiguous_no_clarification: 1

## Group Issue Rates
- ambiguous: 84/110 (76.4%)
- asr_style: 75/100 (75.0%)
- date_range: 98/120 (81.7%)
- deadline: 49/100 (49.0%)
- explicit_single: 79/110 (71.8%)
- long_context: 93/130 (71.5%)
- multi_sentence: 95/130 (73.1%)
- negative_or_control: 24/30 (80.0%)
- recurring: 57/80 (71.2%)
- revision_or_correction: 89/90 (98.9%)

## First 80 Issue Rows
### 0002 deadline
- text: 别忘了2026年8月6日上午十点之前护过期检查要交掉，标题写护照过期检查，备注蓝本。，先暂时这样
- issues: `['category_mismatch']`
- source: `rules`, duration: `528 ms`
- parsed: `{"title": "别忘了之前护过期检查交掉，标题写护照过期", "event_type": "once", "start_date": "2026-08-06", "end_date": null, "start_time": "10:00", "end_time": "11:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0005 asr_style
- text: 老纪 月底 下午四点半 预约理发 提前一天提醒
- issues: `['category_mismatch']`
- source: `rules`, duration: `523 ms`
- parsed: `{"title": "预约理发", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "其他", "reminder_minutes": 1440, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0006 negative_or_control
- text: 我想看看解析失会怎么提示。
- issues: `['slow_call']`
- source: `local_llm`, duration: `6782 ms`
- parsed: `{"title": "解析失会提示", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "您想了解的是关于什么的解析失会提示？", "location": null, "parse_source": "local_llm"}`
### 0007 multi_sentence
- text: 把这个放进日程。大后天下午两点换乘提醒。重点是别漏掉尾款。
- issues: `['category_mismatch']`
- source: `rules`, duration: `521 ms`
- parsed: `{"title": "把这个放进。换乘提醒。重点是别漏掉尾款", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0009 multi_sentence
- text: 加个待办。大后天上午九点上线回滚预案。标题不要太长，就，临时，写上线回滚预案。
- issues: `['category_mismatch']`
- source: `rules`, duration: `500 ms`
- parsed: `{"title": "加个。上线回滚预案。标题不太长，就，临时", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0011 explicit_single
- text: 提醒我，下周六早上七点半缴停车费，需要通知爸妈，备注临时码。
- issues: `['category_mismatch']`
- source: `rules`, duration: `510 ms`
- parsed: `{"title": "缴停车费，通知爸妈", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": "07:30", "end_time": "08:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0012 recurring
- text: 麻烦记录，每周一晚上七点提醒我游泳，在咖啡店靠窗位置。
- issues: `['category_mismatch']`
- source: `rules`, duration: `501 ms`
- parsed: `{"title": "麻烦记录，游泳，在咖啡店靠窗位置", "event_type": "weekly", "start_date": "2026-07-13", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "咖啡店靠窗位置", "parse_source": "rules"}`
### 0014 long_context
- text: 提醒我，明天早上七点半我要处理考试确认单打印，这是新的安排不是原来的陏訆那个，提前一天提醒。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `510 ms`
- parsed: `{"title": "我处理考试", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "07:30", "end_time": "08:30", "is_all_day": false, "category": "学习", "reminder_minutes": 1440, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0015 long_context
- text: 日程里加一下，本周五10:20我要处理核对账单，先不要和上周那个混在一起，用公司三楼会议室，提前十分钟提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `1528 ms`
- parsed: `{"title": "里加一下，我处理核对账单，先不和上周那个", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "工作", "reminder_minutes": 10, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0017 deadline
- text: 我需要记住，谁交房租截止是7月15号晚上八点前，需要通知产品同学。
- issues: `['category_mismatch']`
- source: `rules`, duration: `502 ms`
- parsed: `{"title": "我记住，谁交房租截止是前，通知产品同学", "event_type": "once", "start_date": "2026-07-15", "end_date": null, "start_time": "20:00", "end_time": "21:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0018 multi_sentence
- text: 把这个放进日程。下周六晚上七点会议材料最终版。标题不要太长，就写会议材料最终版。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `527 ms`
- parsed: `{"title": "把这个放进。会议材料最终版。标题不太长，", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0019 recurring
- text: 每周五晚上七点买药。
- issues: `['category_mismatch']`
- source: `rules`, duration: `508 ms`
- parsed: `{"title": "买药", "event_type": "weekly", "start_date": "2026-07-10", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "生活", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0020 asr_style
- text: 提醒我周六晚上八点十五瑜伽课声音可能有点小
- issues: `['category_mismatch']`
- source: `rules`, duration: `512 ms`
- parsed: `{"title": "瑜伽课声音可能有点小", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "20:15", "end_time": "21:15", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0024 long_context
- text: 提醒我，本月25号下午四点半我要处理紧急修复线上问题，这是新的安排不是原来的那个，用银行网点，不要提醒。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `510 ms`
- parsed: `{"title": "本月25号我处理紧急修复线上问题，这是新", "event_type": "once", "start_date": "2026-07-25", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "重要", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0025 ambiguous
- text: 明天有个缴水电 然后 费，具体几点还媀偠没定，先记一下。
- issues: `['category_mismatch']`
- source: `rules`, duration: `506 ms`
- parsed: `{"title": "有个缴水电然后费，具体几点还媀偠没定，先", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0026 ambiguous
- text: 上午九点复诊，日期还没想好。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `510 ms`
- parsed: `{"title": "复诊，日期还没想好", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "没有听到具体日期，是否安排在今天？", "location": null, "parse_source": "rules"}`
### 0028 deadline
- text: 别忘了下周二下午五点前文献整理要交掉，标题写文献整理，备注手写版。
- issues: `['category_mismatch']`
- source: `rules`, duration: `515 ms`
- parsed: `{"title": "别忘了前文献整理交掉，标题写文献整理", "event_type": "once", "start_date": "2026-07-14", "end_date": null, "start_time": "17:00", "end_time": "18:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0029 date_range
- text: 从7月18日开始到月底，把行程确认整，顺手，理完，带上小票。
- issues: `['category_mismatch', 'date_range_missing_end_date']`
- source: `rules`, duration: `512 ms`
- parsed: `{"title": "从开始到，把行程", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0031 recurring
- text: 帮我记一下，每周一上午十点半提醒我公开课直播，用学校图书馆。
- issues: `['category_mismatch']`
- source: `rules`, duration: `509 ms`
- parsed: `{"title": "帮我，公开课直播，用学校图书馆", "event_type": "weekly", "start_date": "2026-07-13", "end_date": null, "start_time": "10:30", "end_time": "11:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0032 multi_sentence
- text: 我需要记住。下周四下午两点缴水电费。地点还可能变，先写研发区小会议室。
- issues: `['category_mismatch']`
- source: `rules`, duration: `505 ms`
- parsed: `{"title": "我记住。缴水电费。地点还可能变，先写研发", "event_type": "once", "start_date": "2026-07-16", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0035 ambiguous
- text: 日程里加一下，康复训练，时间我晚点补。
- issues: `['slow_call']`
- source: `local_llm`, duration: `5381 ms`
- parsed: `{"title": "康复训练", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "请补充康复训练的具体时间。", "location": null, "parse_source": "local_llm"}`
### 0036 asr_style
- text: 记一条明天16:40行程确认声音可能有点小
- issues: `['category_mismatch']`
- source: `rules`, duration: `521 ms`
- parsed: `{"title": "记一条行程", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0037 multi_sentence
- text: 麻烦记录。下周一下午三点买药。标题不要太长，就写买药。
- issues: `['category_mismatch']`
- source: `rules`, duration: `516 ms`
- parsed: `{"title": "麻烦记录。买药。标题不太长，就写买药", "event_type": "once", "start_date": "2026-07-13", "end_date": null, "start_time": "15:00", "end_time": "16:00", "is_all_day": false, "category": "生活", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0039 recurring
- text: 记一条，每周一19:30提醒我换手机膜，用社区服务站。
- issues: `['category_mismatch']`
- source: `rules`, duration: `496 ms`
- parsed: `{"title": "记一条，换手机膜，用社区服务站", "event_type": "weekly", "start_date": "2026-07-13", "end_date": null, "start_time": "19:30", "end_time": "20:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0041 multi_sentence
- text: 把这个放进日程。后天10:20护照过期检查。如果冲突我再改。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `520 ms`
- parsed: `{"title": "把这个放进。护照过期检查。如果冲突我再改", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0042 explicit_single
- text: 帮我设一下，下周一下一点半景点预约，用机上，不用提醒，主要确认样机。
- issues: `['category_mismatch']`
- source: `rules`, duration: `503 ms`
- parsed: `{"title": "帮我设一下，下景点预约，用机上，，主", "event_type": "once", "start_date": "2026-07-13", "end_date": null, "start_time": "01:30", "end_time": "02:30", "is_all_day": false, "category": "其他", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0043 long_context
- text: 加个待办，月底下午两点我要处理转账给供应商，先不要和上周那个混在一起，在市民中心。
- issues: `['category_mismatch']`
- source: `rules`, duration: `525 ms`
- parsed: `{"title": "加个，我处理转账给供应商，先不和上周那个", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "市民中心", "parse_source": "rules"}`
### 0044 date_range
- text: 给我安排，投标材料整理要在7月18日到8月5号之间处理，别只记一天，提前半小时提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `523 ms`
- parsed: `{"title": "给我，投标材料整理在之间处理，别只记一天", "event_type": "once", "start_date": "2026-07-18", "end_date": "2026-08-05", "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": 30, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0045 explicit_single
- text: 加个待办，今天16:40整理衣柜，在咖啡店靠窗位置，运营同事也参加，提前半小时提醒，备注尾款。
- issues: `['category_mismatch']`
- source: `rules`, duration: `790 ms`
- parsed: `{"title": "加个，整理衣柜，在咖啡店靠窗位置，运营同", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": 30, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0046 date_range
- text: 7月18日到月底整理数据报表检查。
- issues: `['category_mismatch', 'date_range_missing_end_date']`
- source: `rules`, duration: `531 ms`
- parsed: `{"title": "到整理数据报表检查", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0048 long_context
- text: 加个待办，大后天16:40我要处理投诉回访，先不要和上周那个混在一起，地点在市民中心。
- issues: `['category_mismatch']`
- source: `rules`, duration: `502 ms`
- parsed: `{"title": "加个，我处理投诉回访，先不和上周那个混在", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "在市民中心", "parse_source": "rules"}`
### 0049 explicit_single
- text: 我需要记住，下周二凌晨一点和老同事喝咖啡，带上登记号。
- issues: `['category_mismatch']`
- source: `rules`, duration: `516 ms`
- parsed: `{"title": "我记住，和老同事喝咖啡，带上登记号", "event_type": "once", "start_date": "2026-07-14", "end_date": null, "start_time": "01:00", "end_time": "02:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0050 date_range
- text: 下周三到月底完成交房租。
- issues: `['category_mismatch', 'date_range_missing_end_date']`
- source: `rules`, duration: `509 ms`
- parsed: `{"title": "到交房租", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0052 date_range
- text: 下樉朲周三到8月5号提交小组汇报。
- issues: `['category_mismatch']`
- source: `rules`, duration: `492 ms`
- parsed: `{"title": "下樉朲提交小组汇报", "event_type": "once", "start_date": "2026-07-15", "end_date": "2026-08-05", "start_time": null, "end_time": null, "is_all_day": true, "category": "工作", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0053 negative_or_control
- text: 我想看看鼂解析失败时会怎么提示。
- issues: `['parse_error']`
- source: `None`, duration: `2719 ms`
- parsed: `{}`
### 0054 recurring
- text: 每月二十号16:40统计学练习，到点提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `774 ms`
- parsed: `{"title": "统计学练习", "event_type": "monthly", "start_date": "2026-07-20", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": 0, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0055 revision_or_correction
- text: 把刚才那个出差报销改成明天中午十二点，不是原来蝗梟趥的时间。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `517 ms`
- parsed: `{"title": "把刚才那个出差报销改成，不是原来蝗梟趥的", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "12:00", "end_time": "13:00", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0056 revision_or_correction
- text: 原来想写下午一点半，不对，改成晚上七点还款截止，用社区服务站。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `1414 ms`
- parsed: `{"title": "原来想写，不对，改成还款截止，用社区服务", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "13:30", "end_time": "14:30", "is_all_day": false, "category": "财务", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "没有听到具体日期，是否安排在今天？", "location": null, "parse_source": "rules"}`
### 0057 recurring
- text: 每天凌晨一点血压复查。先暂时这样，别覆盖前面的安排
- issues: `['category_mismatch']`
- source: `rules`, duration: `553 ms`
- parsed: `{"title": "血压复查。先暂时这样，别覆盖前面", "event_type": "daily", "start_date": "2026-07-09", "end_date": null, "start_time": "01:00", "end_time": "02:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0058 date_range
- text: 7月21号到 然后 下周日准备寄文件。
- issues: `['category_mismatch', 'date_range_missing_end_date']`
- source: `rules`, duration: `549 ms`
- parsed: `{"title": "到然后准备寄文件", "event_type": "once", "start_date": "2026-07-21", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0059 recurring
- text: 从现在开始每周一下午四点半都要库存盘点会，先按重复日程记。
- issues: `['category_mismatch']`
- source: `rules`, duration: `511 ms`
- parsed: `{"title": "从现在开始都库存盘点会，先按重复记", "event_type": "weekly", "start_date": "2026-07-13", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0060 multi_sentence
- text: 帮我设一下。8月1号19:30考试确认单打印。这件事和产品同学有关。
- issues: `['category_mismatch']`
- source: `rules`, duration: `529 ms`
- parsed: `{"title": "帮我设一下。考试", "event_type": "once", "start_date": "2026-08-01", "end_date": null, "start_time": "19:30", "end_time": "20:30", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0061 recurring
- text: 我需要记住，每周五晚上八点十五提醒我产品方案讨论，地点在银行孱网点。
- issues: `['category_mismatch']`
- source: `rules`, duration: `540 ms`
- parsed: `{"title": "我记住，产品方案", "event_type": "weekly", "start_date": "2026-07-10", "end_date": null, "start_time": "20:15", "end_time": "21:15", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0062 long_context
- text: 把这个放进日程，下下周二下午两点我要处理同事送别饭，这次主要是提醒我按时到，在咖啡店靠窗位置，提前十分钟提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `539 ms`
- parsed: `{"title": "把这个放进，我处理同事送别饭，这次主是按", "event_type": "once", "start_date": "2026-07-21", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "其他", "reminder_minutes": 10, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0064 revision_or_correction
- text: 原来想写10:20，不对，改成晚上七点交物业费，用健身房。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `580 ms`
- parsed: `{"title": "原来想写，不对，改成交物业费，用健身房", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "没有听到具体日期，是否安排在今天？", "location": null, "parse_source": "rules"}`
### 0065 long_context
- text: 给我安排，后天晚上七点我要处理护照过期检查，不用写太长描述，用线上腾讯会议，提前十五分钟提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `528 ms`
- parsed: `{"title": "给我，我处理护照过期检查，不用写太长描述", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0066 explicit_single
- text: 给我安排，大后天16:40心理咨询，和HR一起，不用提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `514 ms`
- parsed: `{"title": "给我，心理咨询，和HR一起", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0067 long_context
- text: 帮我记一下，今天晚上八点十五我要处理确认收款，标题就写短，可能，一点。
- issues: `['category_mismatch']`
- source: `rules`, duration: `574 ms`
- parsed: `{"title": "帮我，我处理", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "20:15", "end_time": "21:15", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0068 revision_or_correction
- text: 帮我记一下，交房租不是今天，是这周六16:40。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `625 ms`
- parsed: `{"title": "帮我，交房租不是，是", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0069 asr_style
- text: 后天下午一点半洗衣服嗯不要漏掉前面日期
- issues: `['category_mismatch']`
- source: `rules`, duration: `627 ms`
- parsed: `{"title": "洗衣服嗯不漏掉前面日期", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "13:30", "end_time": "14:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0070 asr_style
- text: 后天14:05，就是，缴纳报名费嗯不要漏掉前面日期
- issues: `['category_mismatch']`
- source: `rules`, duration: `587 ms`
- parsed: `{"title": "就是，缴纳报名费嗯不漏掉前面日期", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "14:05", "end_time": "15:05", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0071 revision_or_correction
- text: 日程里加一下，行程确认不是今天，是月底下午两点。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `635 ms`
- parsed: `{"title": "里加一下，行程", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0073 ambiguous
- text: 明天有个需求评审，具体几点还没定，先记一下。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `618 ms`
- parsed: `{"title": "有个需求评审，具体几点还没定，先", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "工作", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0074 explicit_single
- text: 把这个放进日程，本周五上午九点投诉回访，在机场T2。
- issues: `['category_mismatch']`
- source: `rules`, duration: `638 ms`
- parsed: `{"title": "把这个放进，投诉回访，在机场T2", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "机场T2", "parse_source": "rules"}`
### 0075 ambiguous
- text: 加就是个待办，家里大扫除时间我晚点补。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `615 ms`
- parsed: `{"title": "加就是个，家里大扫除时间我晚点补", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "生活", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "这条记录还不够明确，需要补充具体事项或时间。", "location": null, "parse_source": "rules"}`
### 0076 explicit_single
- text: 日程里加一下，下周日下四点半陪孩子逛书店，在市民中心，和运营同一起，带上灰盒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `614 ms`
- parsed: `{"title": "里加一下，下陪孩子逛书店，在市民中心，和", "event_type": "once", "start_date": "2026-07-19", "end_date": null, "start_time": "04:30", "end_time": "05:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0077 explicit_single
- text: 刚才说漏了，麻烦记录，2026年7月31日上午十点半心理咨询，地点在学校图书馆，王姐也参加。
- issues: `['category_mismatch']`
- source: `rules`, duration: `579 ms`
- parsed: `{"title": "刚才说漏了，麻烦记录，心理咨询，地点在学", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": "10:30", "end_time": "11:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0079 ambiguous
- text: 明天有个算法课作业，具体几点还没定，先记一下。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `614 ms`
- parsed: `{"title": "有个算法课作业，具体几点还没定，先", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "学习", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0080 multi_sentence
- text: 提醒我。下周五16:40朋友聚餐。如果冲突我再改。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `622 ms`
- parsed: `{"title": "朋友聚餐。如果冲突我再改", "event_type": "once", "start_date": "2026-07-17", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "社交", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0081 long_context
- text: 我需要记住，今天10:20我要处理家里大扫除，这次主要是提醒我按时到，地点在健身房，提前两小时提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `614 ms`
- parsed: `{"title": "我记住，我处理家里大扫除，这次主是按时到", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "健康", "reminder_minutes": 120, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0082 date_range
- text: 从本月25号开始到7月18号，把投诉回访提交完。
- issues: `['category_mismatch', 'date_range_missing_end_date']`
- source: `rules`, duration: `519 ms`
- parsed: `{"title": "从本月，把投诉回访提交完", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0083 date_range
- text: 7月15号到7月20日持续处理英语听力练习，不要提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `511 ms`
- parsed: `{"title": "持续处理英语听力练习", "event_type": "once", "start_date": "2026-07-15", "end_date": "2026-07-20", "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0084 multi_sentence
- text: 加个待办。下周六中午十二点体检。地点还可能变，先写研发区小会议室，提前半小时提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `531 ms`
- parsed: `{"title": "加个。体检。地点还可能变，先写研发区小会", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": "12:00", "end_time": "13:00", "is_all_day": false, "category": "工作", "reminder_minutes": 30, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0085 explicit_single
- text: 我需要记住，今天下午两点报名截止，地点在高铁南站，需要通知HR紤彬娚，带上回执。
- issues: `['category_mismatch']`
- source: `rules`, duration: `602 ms`
- parsed: `{"title": "我记住，报名截止，地点在高铁南站，通知H", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0089 revision_or_correction
- text: 把刚才那个预算复盘改成下周二下午一点半，不是原来的时间。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `530 ms`
- parsed: `{"title": "把刚才那个预算复盘改成，不是原来的时间", "event_type": "once", "start_date": "2026-07-14", "end_date": null, "start_time": "13:30", "end_time": "14:30", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0090 deadline
- text: 下周五23:00必须值班交接，提前十五分钟提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `504 ms`
- parsed: `{"title": "必须值班交接", "event_type": "once", "start_date": "2026-07-17", "end_date": null, "start_time": "23:00", "end_time": null, "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0091 asr_style
- text: 我需要记住2026年8月6日19:30产品方案讨论声音可能有点小
- issues: `['category_mismatch']`
- source: `rules`, duration: `513 ms`
- parsed: `{"title": "我记住产品方案", "event_type": "once", "start_date": "2026-08-06", "end_date": null, "start_time": "19:30", "end_time": "20:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0092 long_context
- text: 提醒我，7月15号晚上七点我要处理缴水电费，先不要和上周那个混在一起，用健身房，不用提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `520 ms`
- parsed: `{"title": "我处理缴水电费，先不和上周那个混在一起，", "event_type": "once", "start_date": "2026-07-15", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "健康", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0093 explicit_single
- text: 我需要记住，下周日16:40系统停机前备份，地点在客户办公室，需要通知客户那边。
- issues: `['category_mismatch']`
- source: `rules`, duration: `530 ms`
- parsed: `{"title": "我记住，系统停机前备份，地点在客户办公室", "event_type": "once", "start_date": "2026-07-19", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0094 ambiguous
- text: 统计学练习这个事别忘了，先当待办。
- issues: `['category_mismatch']`
- source: `rules`, duration: `512 ms`
- parsed: `{"title": "统计学练习这个事别忘了，先当", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "这条记录还不够明确，需要补充具体事项或时间。", "location": null, "parse_source": "rules"}`
### 0095 deadline
- text: 7月15号上午十点之前必须公开课直，到点醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `507 ms`
- parsed: `{"title": "之前必须公开课直，到点醒", "event_type": "once", "start_date": "2026-07-15", "end_date": null, "start_time": "10:00", "end_time": "11:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0097 date_range
- text: 下周三到7月20日完成统计学练习。
- issues: `['category_mismatch']`
- source: `rules`, duration: `517 ms`
- parsed: `{"title": "统计学练习", "event_type": "once", "start_date": "2026-07-15", "end_date": "2026-07-20", "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0098 revision_or_correction
- text: 把刚才那个上线回滚预案改成本周五14:05，不是原来的时间。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `517 ms`
- parsed: `{"title": "把刚才那个上线回滚预案改成，不是原来的时", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "14:05", "end_time": "15:05", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0099 asr_style
- text: 记一条下周四上午十点半预约理发声音可能有点小
- issues: `['category_mismatch']`
- source: `rules`, duration: `512 ms`
- parsed: `{"title": "记一条预约理发声音可能有点小", "event_type": "once", "start_date": "2026-07-16", "end_date": null, "start_time": "10:30", "end_time": "11:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0100 ambiguous
- text: 合同审批这个事别忘了，先当待办。
- issues: `['category_mismatch']`
- source: `rules`, duration: `520 ms`
- parsed: `{"title": "合同审批这个事别忘了，先当", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "这条记录还不够明确，需要补充具体事项或时间。", "location": null, "parse_source": "rules"}`
### 0103 date_range
- text: 从本月25号开始到7月20日，把火车站接人持续处理完，主要确认备份包。，可能要改但先记着
- issues: `['date_range_missing_end_date']`
- source: `rules`, duration: `521 ms`
- parsed: `{"title": "从本月，把火车站接人持续处理完，主", "event_type": "once", "start_date": "2026-07-20", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "出行", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0105 revision_or_correction
- text: 原来想写晚上八点十五，不对，改成凌晨一点资格考试报名。
- issues: `['complex_swallowed_by_rules']`
- source: `rules`, duration: `514 ms`
- parsed: `{"title": "原来想写，不对，改成资格考试报名", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "20:15", "end_time": "21:15", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "没有听到具体日期，是否安排在今天？", "location": null, "parse_source": "rules"}`
### 0106 revision_or_correction
- text: 把刚才那个邻居沟通装修改成大后天19:30，不是原来的时间。
- issues: `['category_mismatch', 'complex_swallowed_by_rules']`
- source: `rules`, duration: `512 ms`
- parsed: `{"title": "把刚才那个邻居", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "19:30", "end_time": "20:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0107 date_range
- text: 我需要记住，核对账单要在下周一到月底之间处理，别只记一天。
- issues: `['date_range_missing_end_date']`
- source: `rules`, duration: `1537 ms`
- parsed: `{"title": "我记住，核对账单在到之间处理，别只记一天", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "财务", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0108 recurring
- text: 从现在开始每日10:20都要读书会，先按重复日程记。
- issues: `['category_mismatch']`
- source: `rules`, duration: `513 ms`
- parsed: `{"title": "从现在开始都读书会，先按重复记", "event_type": "daily", "start_date": "2026-07-09", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
