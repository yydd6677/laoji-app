# LaoJi Schedule Review Diagnostics v2

- Input: `test-assets/schedule-robustness/schedule_review_samples_1000_20260709_v2.txt`
- Endpoint: `http://183.36.243.124:8035/api/laoji/parse`
- Total: 1000
- Rows with issues: 497
- Elapsed: 246370 ms
- Parse sources: `{'rules': 761, 'local_llm': 216, 'None': 23}`
- Duration ms: `{'min': 489, 'median': 523.0, 'mean': 1944.38, 'p90': 6818, 'max': 9603}`

## Issue Counts
- category_mismatch: 254
- slow_call: 218
- date_range_missing_end_date: 41
- parse_error: 23
- reminder_mismatch: 18
- recurring_as_once: 2
- ambiguous_no_clarification: 1

## Group Issue Rates
- ambiguous: 71/110 (64.5%)
- asr_style: 17/100 (17.0%)
- date_range: 57/120 (47.5%)
- deadline: 62/100 (62.0%)
- explicit_single: 48/110 (43.6%)
- long_context: 66/130 (50.8%)
- multi_sentence: 45/130 (34.6%)
- negative_or_control: 26/30 (86.7%)
- recurring: 16/80 (20.0%)
- revision_or_correction: 89/90 (98.9%)

## First 80 Issue Rows
### 0003 deadline
- text: 下周五晚上八点前必须开发票，提前十分钟提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `540 ms`
- parsed: `{"title": "前必须开发票", "event_type": "once", "start_date": "2026-07-17", "end_date": null, "start_time": "20:00", "end_time": "21:00", "is_all_day": false, "category": "重要", "reminder_minutes": 10, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0010 explicit_single
- text: 加个待办，下月3号下午两点买猫粮，在社区服务站，需要通知测试同学，主要确认蓝本。
- issues: `['category_mismatch']`
- source: `rules`, duration: `523 ms`
- parsed: `{"title": "加个，下月3号买猫粮，在社区服务站，通知", "event_type": "once", "start_date": "2026-08-03", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "社交", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0014 long_context
- text: 提醒我，明天早上七点半我要处理考试确认单打印，这是新的安排不是原来的陏訆那个，提前一天提醒。
- issues: `['category_mismatch', 'reminder_mismatch']`
- source: `local_llm`, duration: `2555 ms`
- parsed: `{"title": "处理考试确认单打印", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "07:30", "end_time": "08:30", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0015 long_context
- text: 日程里加一下，本周五10:20我要处理核对账单，先不要和上周那个混在一起，用公司三楼会议室，提前十分钟提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `510 ms`
- parsed: `{"title": "里加一下，我处理核对账单，先不和上周那个", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "工作", "reminder_minutes": 10, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0016 asr_style
- text: 牢记，本周五下午四点半，交物业费，地点在家附近超 顺手 市
- issues: `['category_mismatch']`
- source: `rules`, duration: `515 ms`
- parsed: `{"title": "交物业费，地点在家附近超顺手市", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "财务", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "在家附近超顺手市", "parse_source": "rules"}`
### 0017 deadline
- text: 我需要记住，谁交房租截止是7月15号晚上八点前，需要通知产品同学。
- issues: `['category_mismatch']`
- source: `rules`, duration: `523 ms`
- parsed: `{"title": "我记住，谁交房租截止是前，通知产品同学", "event_type": "once", "start_date": "2026-07-15", "end_date": null, "start_time": "20:00", "end_time": "21:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0018 multi_sentence
- text: 把这个放进日程。下周六晚上七点会议材料最终版。标题不要太长，就写会议材料最终版。
- issues: `['slow_call']`
- source: `local_llm`, duration: `3193 ms`
- parsed: `{"title": "会议材料最终版", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0024 long_context
- text: 提醒我，本月25号下午四点半我要处理紧急修复线上问题，这是新的安排不是原来的那个，用银行网点，不要提醒。
- issues: `['slow_call']`
- source: `local_llm`, duration: `3686 ms`
- parsed: `{"title": "处理紧急修复线上问题", "event_type": "once", "start_date": "2026-07-25", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "重要", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": "银行网点", "parse_source": "local_llm"}`
### 0025 ambiguous
- text: 明天有个缴水电 然后 费，具体几点还媀偠没定，先记一下。
- issues: `['category_mismatch']`
- source: `rules`, duration: `522 ms`
- parsed: `{"title": "有个缴水电然后费，具体几点还媀偠没定，先", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0026 ambiguous
- text: 上午九点复诊，日期还没想好。
- issues: `['slow_call']`
- source: `local_llm`, duration: `4609 ms`
- parsed: `{"title": "复诊", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "您希望复诊的具体日期是什么时候？", "location": null, "parse_source": "local_llm"}`
### 0032 multi_sentence
- text: 我需要记住。下周四下午两点缴水电费。地点还可能变，先写研发区小会议室。
- issues: `['category_mismatch']`
- source: `rules`, duration: `525 ms`
- parsed: `{"title": "我记住。缴水电费。地点还可能变，先写研发", "event_type": "once", "start_date": "2026-07-16", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0035 ambiguous
- text: 日程里加一下，康复训练，时间我晚点补。
- issues: `['slow_call']`
- source: `local_llm`, duration: `4447 ms`
- parsed: `{"title": "康复训练", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "请补充康复训练的具体时间。", "location": null, "parse_source": "local_llm"}`
### 0040 deadline
- text: 下下周二23:00前必须项目排期会，开始时提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `543 ms`
- parsed: `{"title": "前必须项目排期会", "event_type": "once", "start_date": "2026-07-21", "end_date": null, "start_time": "23:00", "end_time": null, "is_all_day": false, "category": "重要", "reminder_minutes": 0, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0041 multi_sentence
- text: 把这个放进日程。后天10:20护照过期检查。如果冲突我再改。
- issues: `['slow_call']`
- source: `local_llm`, duration: `4855 ms`
- parsed: `{"title": "护照过期检查", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0043 long_context
- text: 加个待办，月底下午两点我要处理转账给供应商，先不要和上周那个混在一起，在市民中心。
- issues: `['category_mismatch']`
- source: `rules`, duration: `534 ms`
- parsed: `{"title": "加个，我处理转账给供应商，先不和上周那个", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "市民中心", "parse_source": "rules"}`
### 0045 explicit_single
- text: 加个待办，今天16:40整理衣柜，在咖啡店靠窗位置，运营同事也参加，提前半小时提醒，备注尾款。
- issues: `['category_mismatch']`
- source: `rules`, duration: `521 ms`
- parsed: `{"title": "加个，整理衣柜，在咖啡店靠窗位置，运营同", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "社交", "reminder_minutes": 30, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0048 long_context
- text: 加个待办，大后天16:40我要处理投诉回访，先不要和上周那个混在一起，地点在市民中心。
- issues: `['category_mismatch']`
- source: `rules`, duration: `1356 ms`
- parsed: `{"title": "加个，我处理投诉回访，先不和上周那个混在", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "在市民中心", "parse_source": "rules"}`
### 0051 recurring
- text: 我需要记住，每周一上午十，可能，点半提醒我买菜，地点在客户办公室。
- issues: `['category_mismatch']`
- source: `rules`, duration: `518 ms`
- parsed: `{"title": "我记住，上午十，可能，点半买菜，地点在客", "event_type": "weekly", "start_date": "2026-07-13", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "工作", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": "在客户办公室", "parse_source": "rules"}`
### 0052 date_range
- text: 下樉朲周三到8月5号提交小组汇报。
- issues: `['category_mismatch']`
- source: `rules`, duration: `512 ms`
- parsed: `{"title": "下樉朲提交小组汇报", "event_type": "once", "start_date": "2026-07-15", "end_date": "2026-08-05", "start_time": null, "end_time": null, "is_all_day": true, "category": "工作", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0053 negative_or_control
- text: 我想看看鼂解析失败时会怎么提示。
- issues: `['parse_error']`
- source: `None`, duration: `4341 ms`
- parsed: `{}`
### 0055 revision_or_correction
- text: 把刚才那个出差报销改成明天中午十二点，不是原来蝗梟趥的时间。
- issues: `['slow_call']`
- source: `local_llm`, duration: `4262 ms`
- parsed: `{"title": "出差报销", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "12:00", "end_time": "13:00", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0056 revision_or_correction
- text: 原来想写下午一点半，不对，改成晚上七点还款截止，用社区服务站。
- issues: `['slow_call']`
- source: `local_llm`, duration: `4920 ms`
- parsed: `{"title": "还款截止", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "这个表达更像截止时间或模糊时间，需要我按当前日期保存，还是换成具体某一天/某个时间？", "location": "社区服务站", "parse_source": "local_llm"}`
### 0058 date_range
- text: 7月21号到 然后 下周日准备寄文件。
- issues: `['date_range_missing_end_date']`
- source: `rules`, duration: `529 ms`
- parsed: `{"title": "到然后准备寄文件", "event_type": "once", "start_date": "2026-07-21", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "生活", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0060 multi_sentence
- text: 帮我设一下。8月1号19:30考试确认单打印。这件事和产品同学有关。
- issues: `['category_mismatch']`
- source: `rules`, duration: `516 ms`
- parsed: `{"title": "帮我设一下。考试", "event_type": "once", "start_date": "2026-08-01", "end_date": null, "start_time": "19:30", "end_time": "20:30", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0063 long_context
- text: 加个待办，下周五上午十点半我要处理报销提交，先不要和上周那个混在一起，地点在客户办公室，开始时提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `554 ms`
- parsed: `{"title": "加个，我处理报销提交，先不和上周那个混在", "event_type": "once", "start_date": "2026-07-17", "end_date": null, "start_time": "10:30", "end_time": "11:30", "is_all_day": false, "category": "工作", "reminder_minutes": 0, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0064 revision_or_correction
- text: 原来想写10:20，不对，改成晚上七点交物业费，用健身房。
- issues: `['category_mismatch', 'slow_call']`
- source: `local_llm`, duration: `4230 ms`
- parsed: `{"title": "交物业费", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0068 revision_or_correction
- text: 帮我记一下，交房租不是今天，是这周六16:40。
- issues: `['slow_call']`
- source: `local_llm`, duration: `4612 ms`
- parsed: `{"title": "交房租", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "财务", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0071 revision_or_correction
- text: 日程里加一下，行程确认不是今天，是月底下午两点。
- issues: `['slow_call']`
- source: `local_llm`, duration: `5317 ms`
- parsed: `{"title": "行程确认", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0072 deadline
- text: 加个待办，还贷款截止是下周四上午十点之前，需要通知运营同事。
- issues: `['category_mismatch']`
- source: `rules`, duration: `518 ms`
- parsed: `{"title": "加个，还贷款截止是之前，通知运营同事", "event_type": "once", "start_date": "2026-07-16", "end_date": null, "start_time": "10:00", "end_time": "11:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0073 ambiguous
- text: 明天有个需求评审，具体几点还没定，先记一下。
- issues: `['slow_call']`
- source: `local_llm`, duration: `5883 ms`
- parsed: `{"title": "需求评审", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": null, "end_time": null, "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "请确认需求评审的具体时间。", "location": null, "parse_source": "local_llm"}`
### 0074 explicit_single
- text: 把这个放进日程，本周五上午九点投诉回访，在机场T2。
- issues: `['category_mismatch']`
- source: `rules`, duration: `515 ms`
- parsed: `{"title": "把这个放进，投诉回访，在机场T2", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "机场T2", "parse_source": "rules"}`
### 0075 ambiguous
- text: 加就是个待办，家里大扫除时间我晚点补。
- issues: `['slow_call']`
- source: `local_llm`, duration: `6497 ms`
- parsed: `{"title": "家里大扫除", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "生活", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "您希望将大扫除安排在什么时候？", "location": null, "parse_source": "local_llm"}`
### 0076 explicit_single
- text: 日程里加一下，下周日下四点半陪孩子逛书店，在市民中心，和运营同一起，带上灰盒。
- issues: `['category_mismatch', 'slow_call']`
- source: `rules`, duration: `3767 ms`
- parsed: `{"title": "里加一下，下陪孩子逛书店，在市民中心，和", "event_type": "once", "start_date": "2026-07-19", "end_date": null, "start_time": "04:30", "end_time": "05:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0079 ambiguous
- text: 明天有个算法课作业，具体几点还没定，先记一下。
- issues: `['slow_call']`
- source: `local_llm`, duration: `6494 ms`
- parsed: `{"title": "算法课作业", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": null, "end_time": null, "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "请确认算法课作业的具体时间。", "location": null, "parse_source": "local_llm"}`
### 0080 multi_sentence
- text: 提醒我。下周五16:40朋友聚餐。如果冲突我再改。
- issues: `['slow_call']`
- source: `local_llm`, duration: `7471 ms`
- parsed: `{"title": "朋友聚餐", "event_type": "once", "start_date": "2026-07-17", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "社交", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0081 long_context
- text: 我需要记住，今天10:20我要处理家里大扫除，这次主要是提醒我按时到，地点在健身房，提前两小时提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `533 ms`
- parsed: `{"title": "我记住，我处理家里大扫除，这次主是按时到", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "健康", "reminder_minutes": 120, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0082 date_range
- text: 从本月25号开始到7月18号，把投诉回访提交完。
- issues: `['category_mismatch', 'date_range_missing_end_date']`
- source: `rules`, duration: `533 ms`
- parsed: `{"title": "从本月，把投诉回访提交完", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "其他", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0084 multi_sentence
- text: 加个待办。下周六中午十二点体检。地点还可能变，先写研发区小会议室，提前半小时提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `520 ms`
- parsed: `{"title": "加个。体检。地点还可能变，先写研发区小会", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": "12:00", "end_time": "13:00", "is_all_day": false, "category": "工作", "reminder_minutes": 30, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0089 revision_or_correction
- text: 把刚才那个预算复盘改成下周二下午一点半，不是原来的时间。
- issues: `['slow_call']`
- source: `local_llm`, duration: `5399 ms`
- parsed: `{"title": "预算复盘", "event_type": "once", "start_date": "2026-07-13", "end_date": null, "start_time": "13:30", "end_time": "14:30", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0090 deadline
- text: 下周五23:00必须值班交接，提前十五分钟提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `517 ms`
- parsed: `{"title": "必须值班交接", "event_type": "once", "start_date": "2026-07-17", "end_date": null, "start_time": "23:00", "end_time": null, "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0092 long_context
- text: 提醒我，7月15号晚上七点我要处理缴水电费，先不要和上周那个混在一起，用健身房，不用提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `538 ms`
- parsed: `{"title": "我处理缴水电费，先不和上周那个混在一起，", "event_type": "once", "start_date": "2026-07-15", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "健康", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0093 explicit_single
- text: 我需要记住，下周日16:40系统停机前备份，地点在客户办公室，需要通知客户那边。
- issues: `['category_mismatch']`
- source: `rules`, duration: `514 ms`
- parsed: `{"title": "我记住，系统停机前备份，地点在客户办公室", "event_type": "once", "start_date": "2026-07-19", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0095 deadline
- text: 7月15号上午十点之前必须公开课直，到点醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `509 ms`
- parsed: `{"title": "之前必须公开课直，到点醒", "event_type": "once", "start_date": "2026-07-15", "end_date": null, "start_time": "10:00", "end_time": "11:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0098 revision_or_correction
- text: 把刚才那个上线回滚预案改成本周五14:05，不是原来的时间。
- issues: `['slow_call']`
- source: `local_llm`, duration: `5454 ms`
- parsed: `{"title": "上线回滚预案", "event_type": "once", "start_date": "2026-07-16", "end_date": null, "start_time": "14:05", "end_time": "15:05", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0103 date_range
- text: 从本月25号开始到7月20日，把火车站接人持续处理完，主要确认备份包。，可能要改但先记着
- issues: `['date_range_missing_end_date']`
- source: `rules`, duration: `533 ms`
- parsed: `{"title": "从本月，把火车站接人持续处理完，主", "event_type": "once", "start_date": "2026-07-20", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "出行", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0105 revision_or_correction
- text: 原来想写晚上八点十五，不对，改成凌晨一点资格考试报名。
- issues: `['slow_call']`
- source: `local_llm`, duration: `5041 ms`
- parsed: `{"title": "资格考试报名", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "01:15", "end_time": "02:15", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0106 revision_or_correction
- text: 把刚才那个邻居沟通装修改成大后天19:30，不是原来的时间。
- issues: `['category_mismatch', 'slow_call']`
- source: `local_llm`, duration: `6103 ms`
- parsed: `{"title": "邻居沟通装修改时间", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "19:30", "end_time": "20:30", "is_all_day": false, "category": "生活", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0116 date_range
- text: 从下周一开始 然后 到7月18号，把模拟考试跟进完，带上座位号。
- issues: `['date_range_missing_end_date']`
- source: `rules`, duration: `512 ms`
- parsed: `{"title": "从开始然后到，把模拟考试跟进完，带上座位", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "学习", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0117 multi_sentence
- text: 帮我一下。明天10:20邻居沟通装修。地点还可能变，先写线上飞会议。
- issues: `['category_mismatch']`
- source: `rules`, duration: `517 ms`
- parsed: `{"title": "帮我一下。邻居", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0118 date_range
- text: 从8月2号开始到下周日，把换手机膜持续处理完，主要确认签收码。
- issues: `['date_range_missing_end_date']`
- source: `rules`, duration: `516 ms`
- parsed: `{"title": "把换手机膜持续处理完，主", "event_type": "once", "start_date": "2026-08-02", "end_date": null, "start_time": null, "end_time": null, "is_all_day": true, "category": "生活", "reminder_minutes": null, "needs_clarification": true, "clarification_question": "没有听到具体时间，是否作为全天事项保存？", "location": null, "parse_source": "rules"}`
### 0119 revision_or_correction
- text: 原来想写上午十点半，不对，改成19:30文献整理，地点在家附近超市。
- issues: `['slow_call']`
- source: `local_llm`, duration: `5986 ms`
- parsed: `{"title": "文献整理", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "19:30", "end_time": "20:30", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "家附近超市", "parse_source": "local_llm"}`
### 0120 revision_or_correction
- text: 原来想写上午十点半，不对，成19:30投标材料整理，在市民中心。
- issues: `['slow_call']`
- source: `local_llm`, duration: `4660 ms`
- parsed: `{"title": "投标材料整理", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "19:30", "end_time": "20:30", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "市民中心", "parse_source": "local_llm"}`
### 0121 negative_or_control
- text: 我想想啊，如果我说开会两个字，临时，你先别自动保存。
- issues: `['parse_error']`
- source: `None`, duration: `512 ms`
- parsed: `{}`
### 0122 revision_or_correction
- text: 记一条，交房租不是今天，是这周六下午一点半。
- issues: `['slow_call']`
- source: `local_llm`, duration: `6510 ms`
- parsed: `{"title": "交房租", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "13:30", "end_time": "14:30", "is_all_day": false, "category": "财务", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0123 deadline
- text: 下月底23:00前必须模拟考试，提前十分钟提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `508 ms`
- parsed: `{"title": "下前必须模拟考试", "event_type": "once", "start_date": "2026-08-31", "end_date": null, "start_time": "23:00", "end_time": null, "is_all_day": false, "category": "重要", "reminder_minutes": 10, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0124 date_range
- text: 从7月15号开始到7月18号，把更新预算别忘了表提交完，主要确认侧门。
- issues: `['category_mismatch']`
- source: `rules`, duration: `513 ms`
- parsed: `{"title": "把更新预算别忘了表提交完，主", "event_type": "once", "start_date": "2026-07-15", "end_date": "2026-07-18", "start_time": null, "end_time": null, "is_all_day": true, "category": "工作", "reminder_minutes": null, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0125 negative_or_control
- text: 下午三点只是举例，不，可能，要保存。
- issues: `['parse_error']`
- source: `None`, duration: `518 ms`
- parsed: `{}`
### 0126 multi_sentence
- text: 加个待办。下周廴三下午四点半牙医预约。地点还可能变，先写研发区小会议室，用提醒
- issues: `['category_mismatch']`
- source: `rules`, duration: `523 ms`
- parsed: `{"title": "加个。下周廴三牙医预约。地点还可能变，先", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "没有听到具体日期，是否安排在今天？", "location": null, "parse_source": "rules"}`
### 0129 explicit_single
- text: 提醒我，本周五下午四点半给爸妈打电话，用客户办公室，带上封面。
- issues: `['category_mismatch']`
- source: `rules`, duration: `508 ms`
- parsed: `{"title": "给爸妈打电话，用客户办公室，带上封面", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0130 revision_or_correction
- text: 提交截止材料先记月底下午四点半，如果我后面再说另一个时间，以后面的为准。
- issues: `['slow_call']`
- source: `local_llm`, duration: `6046 ms`
- parsed: `{"title": "提交截止材料", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "这个表达更像截止时间或模糊时间，需要我按当前日期保存，还是换成具体某一天/某个时间？", "location": null, "parse_source": "local_llm"}`
### 0133 ambiguous
- text: 把这个放进日程，项目风险同步，时间我晚点补。
- issues: `['slow_call']`
- source: `local_llm`, duration: `6194 ms`
- parsed: `{"title": "项目风险同步", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "您希望将项目风险同步安排在什么时间？", "location": null, "parse_source": "local_llm"}`
### 0134 recurring
- text: 加个待办，每年7月20号16:40提醒我交物业费就是，用客户办公室。
- issues: `['category_mismatch']`
- source: `rules`, duration: `528 ms`
- parsed: `{"title": "加个，交物业费就是，用客户办公室", "event_type": "yearly", "start_date": "2026-07-20", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0135 explicit_single
- text: 提醒我，本周五晚上七点买猫粮，地点在研发区小会议室，和爸妈一起，提前十五分钟提醒，备注登记号。
- issues: `['category_mismatch']`
- source: `rules`, duration: `507 ms`
- parsed: `{"title": "买猫粮，地点在研发区小会议室，和爸妈一起", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "在研发区小", "parse_source": "rules"}`
### 0136 deadline
- text: 2026年8月6日23:00前必须统计学练习，提前两小时提醒。
- issues: `['category_mismatch']`
- source: `rules`, duration: `511 ms`
- parsed: `{"title": "前必须统计学练习", "event_type": "once", "start_date": "2026-08-06", "end_date": null, "start_time": "23:00", "end_time": null, "is_all_day": false, "category": "重要", "reminder_minutes": 120, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0138 explicit_single
- text: 日程里加一下，下周日上午九点整理发票，用研发区小会议室，运营同事也参加，带上小票。
- issues: `['category_mismatch']`
- source: `rules`, duration: `524 ms`
- parsed: `{"title": "里加一下，整理发票，用研发区小会议室，运", "event_type": "once", "start_date": "2026-07-19", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0140 explicit_single
- text: 帮我设一下，2026年，先这样，7月31日下午两点开发票，地点在线上飞书会议，产品同学也参加，到点提醒，带上小票。
- issues: `['category_mismatch']`
- source: `rules`, duration: `524 ms`
- parsed: `{"title": "帮我设一下，2026年，先这样，开发票，", "event_type": "once", "start_date": "2026-07-31", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "工作", "reminder_minutes": 0, "needs_clarification": false, "clarification_question": null, "location": "在线上飞书", "parse_source": "rules"}`
### 0141 asr_style
- text: 本月25号下午一点半陪孩子逛书店嗯不要漏掉前面日期。我想想啊，别覆盖前面的安排
- issues: `['category_mismatch']`
- source: `rules`, duration: `514 ms`
- parsed: `{"title": "本月25号陪孩子逛书店嗯不漏掉前面日期。", "event_type": "once", "start_date": "2026-07-25", "end_date": null, "start_time": "13:30", "end_time": "14:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0143 revision_or_correction
- text: 原来想写10:20，不对，改成下午两点紧急修复线上问题。
- issues: `['slow_call']`
- source: `local_llm`, duration: `5494 ms`
- parsed: `{"title": "紧急修复线上问题", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "14:20", "end_time": "15:20", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0144 recurring
- text: 加个待办，每周三下午一点半提醒我康复训练，在会议室B。
- issues: `['category_mismatch']`
- source: `rules`, duration: `523 ms`
- parsed: `{"title": "加个，康复训练，在会议室B", "event_type": "weekly", "start_date": "2026-07-15", "end_date": null, "start_time": "13:30", "end_time": "14:30", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "会议室B", "parse_source": "rules"}`
### 0145 revision_or_correction
- text: 应该没记错的话，把刚才那个安全培训改成本周五下午三点，不是原来的时间。
- issues: `['category_mismatch', 'slow_call']`
- source: `local_llm`, duration: `6419 ms`
- parsed: `{"title": "安全培训", "event_type": "once", "start_date": "2026-07-16", "end_date": null, "start_time": "15:00", "end_time": "16:00", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0146 asr_style
- text: 老纪 下月3号 16:40 资格考先这样试报名 开始时提醒
- issues: `['category_mismatch']`
- source: `rules`, duration: `519 ms`
- parsed: `{"title": "下月3号资格考先这样试报名", "event_type": "once", "start_date": "2026-08-03", "end_date": null, "start_time": "16:40", "end_time": "17:40", "is_all_day": false, "category": "其他", "reminder_minutes": 0, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0150 explicit_single
- text: 提醒我，下月3号10:20系统停机前备份，地点在市民中心，供应商也参加，主要确认回执。
- issues: `['category_mismatch']`
- source: `rules`, duration: `524 ms`
- parsed: `{"title": "下月3号系统停机前备份，地点在市民中心，", "event_type": "once", "start_date": "2026-08-03", "end_date": null, "start_time": "10:20", "end_time": "11:20", "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0152 deadline
- text: 把这个放进日程，转账给供应商截止是下周六中午十二点前脣歯惗，和客户那边一起。
- issues: `['category_mismatch']`
- source: `rules`, duration: `517 ms`
- parsed: `{"title": "把这个放进，转账给供应商截止是前脣歯惗，", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": "12:00", "end_time": "13:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0153 ambiguous
- text: 帮我设一下，合同最后确认，时间我晚点补。
- issues: `['category_mismatch', 'slow_call']`
- source: `local_llm`, duration: `5952 ms`
- parsed: `{"title": "合同最后确认", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": null, "end_time": null, "is_all_day": false, "category": "工作", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "您希望将合同最后确认设置为全天事件还是具体时间？", "location": null, "parse_source": "local_llm"}`
### 0154 long_context
- text: 记一条，下周一上午十点半我要处理朋友接机，先不要和上周那个混在一起。
- issues: `['category_mismatch']`
- source: `rules`, duration: `513 ms`
- parsed: `{"title": "记一条，我处理朋友接机，先不和上周那个混", "event_type": "once", "start_date": "2026-07-13", "end_date": null, "start_time": "10:30", "end_time": "11:30", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": "一起", "parse_source": "rules"}`
### 0155 long_context
- text: 我需要记住，下月3号上午九点我要处理报名截止，这是新的安排不是原来的那个。
- issues: `['slow_call']`
- source: `local_llm`, duration: `6601 ms`
- parsed: `{"title": "处理报名截止", "event_type": "once", "start_date": "2026-08-03", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "重要", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "这个表达更像截止时间或模糊时间，需要我按当前日期保存，还是换成具体某一天/某个时间？", "location": null, "parse_source": "local_llm"}`
### 0156 revision_or_correction
- text: 原来想写晚上七点，不对，改成上午十点半朋友聚餐。
- issues: `['slow_call']`
- source: `local_llm`, duration: `7647 ms`
- parsed: `{"title": "朋友聚餐", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "10:30", "end_time": "11:30", "is_all_day": false, "category": "社交", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
### 0157 ambiguous
- text: 10:院20算法课作业，日期还没想好。
- issues: `['slow_call']`
- source: `local_llm`, duration: `8499 ms`
- parsed: `{"title": "算法课作业", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "10:00", "end_time": "11:00", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": true, "clarification_question": "您是否已经确定了作业的提交日期？", "location": null, "parse_source": "local_llm"}`
### 0158 revision_or_correction
- text: 把这个放进日程，整理发票不呃是今天，是下周二下午四点半。
- issues: `['category_mismatch']`
- source: `rules`, duration: `792 ms`
- parsed: `{"title": "把这个放进，整理发票不呃是，是", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "16:30", "end_time": "17:30", "is_all_day": false, "category": "财务", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "rules"}`
### 0159 revision_or_correction
- text: 把刚才那个景点预约槔改成下月3号14:05，不是原来的时间。
- issues: `['slow_call']`
- source: `local_llm`, duration: `8007 ms`
- parsed: `{"title": "景点预约", "event_type": "once", "start_date": "2026-08-03", "end_date": null, "start_time": "14:05", "end_time": "15:05", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "clarification_question": null, "location": null, "parse_source": "local_llm"}`
