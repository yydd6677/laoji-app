# LaoJi Schedule Robustness 1000-Sample Results

- Sample file: `/home/yydd/LaoJi/mobile/test-assets/schedule-robustness/schedule_robustness_samples_1000_20260709.json`
- Total: 1000
- OK: 680
- Failed: 320
- Pass rate: 68.00%
- Parse sources: `{'rules': 967, 'local_llm': 33}`
- Duration ms: `{'min': 483, 'median': 582.0, 'mean': 799.87, 'p90': 1587, 'max': 8423}`

## Groups
- oral_repeat: total 200, ok 106, failed 94, pass 53.00%
- complex_range: total 200, ok 148, failed 52, pass 74.00%
- ambiguous_clarify: total 200, ok 178, failed 22, pass 89.00%
- noise: total 200, ok 162, failed 38, pass 81.00%
- adversarial_asr: total 200, ok 86, failed 114, pass 43.00%

## Mismatch Fields
- category: 137
- start_date: 92
- start_time: 90
- end_time: 90
- end_date: 20
- location_contains: 11

## Failed Tags
- 修正: 151
- 否定前值: 56
- 否定时间: 50
- 否定日期: 45
- 跨日期: 44
- 口语: 38
- 范围: 34
- 噪音: 25
- 追问: 22
- 时间范围: 19
- 提醒: 14
- 重复: 13
- 明确字段: 13
- 随机词噪音: 13
- 地点: 11
- 截止: 11
- 全天: 11
- 否定干扰: 11
- 周几: 11
- 模糊时间: 9

## First 30 Failures
### RB0002 oral_repeat
- text: 先给我记个背单词，时间是这周六上午八点半，嗯。
- source: rules
- mismatches: `{"category": {"expected": "学习", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-11", "start_time": "08:30", "end_time": "09:30", "category": "学习"}`
- parsed: `{"title": "先给我记个背单词，时间是，嗯", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "08:30", "end_time": "09:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0009 oral_repeat
- text: 先给我记个系统维护，时间是七月十九号晚上九点，我想想啊。
- source: rules
- mismatches: `{"category": {"expected": "工作", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-19", "start_time": "21:00", "end_time": "22:00", "category": "工作"}`
- parsed: `{"title": "先给我记个系统维护，时间是，我想想啊", "event_type": "once", "start_date": "2026-07-19", "end_date": null, "start_time": "21:00", "end_time": "22:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0010 oral_repeat
- text: 七月十九号上午九点半背单词，嗯对，上午九点半，不是别的时间。
- source: rules
- mismatches: `{"category": {"expected": "学习", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-19", "start_time": "09:30", "end_time": "10:30", "category": "学习"}`
- parsed: `{"title": "背单词，嗯对，，不是别的时间", "event_type": "once", "start_date": "2026-07-19", "end_date": null, "start_time": "09:30", "end_time": "10:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0025 oral_repeat
- text: 老记，七月二十号上午九点半系统维护，我再说一遍。
- source: rules
- mismatches: `{"category": {"expected": "工作", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-20", "start_time": "09:30", "end_time": "10:30", "category": "工作"}`
- parsed: `{"title": "系统维护，我再说一遍", "event_type": "once", "start_date": "2026-07-20", "end_date": null, "start_time": "09:30", "end_time": "10:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0033 oral_repeat
- text: 先给我记个检查服务器，时间是下周四上午八点半，老记。
- source: rules
- mismatches: `{"category": {"expected": "工作", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-16", "start_time": "08:30", "end_time": "09:30", "category": "工作"}`
- parsed: `{"title": "先给我记个检查服务器，时间是，老记", "event_type": "once", "start_date": "2026-07-16", "end_date": null, "start_time": "08:30", "end_time": "09:30", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0036 oral_repeat
- text: 提醒一下，这周日上午十点系统维护，麻烦记下。
- source: rules
- mismatches: `{"category": {"expected": "工作", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "10:00", "end_time": "11:00", "category": "工作"}`
- parsed: `{"title": "提醒一下，系统维护，麻烦记下", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "10:00", "end_time": "11:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0039 oral_repeat
- text: 麻烦记下，这周六中午十二点检查服务器，我想想啊。
- source: rules
- mismatches: `{"category": {"expected": "工作", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-11", "start_time": "12:00", "end_time": "13:00", "category": "工作"}`
- parsed: `{"title": "麻烦记下，检查服务器，我想想啊", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "12:00", "end_time": "13:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0040 oral_repeat
- text: 我想想啊，下周三上午九点大扫除，我想想啊。
- source: rules
- mismatches: `{"category": {"expected": "生活", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-15", "start_time": "09:00", "end_time": "10:00", "category": "生活"}`
- parsed: `{"title": "我想想啊，大扫除，我想想啊", "event_type": "once", "start_date": "2026-07-15", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0042 oral_repeat
- text: 我想想啊，后天，上午九点，系统维护，我再确认一下就是后天上午九点。
- source: rules
- mismatches: `{"category": {"expected": "工作", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-11", "start_time": "09:00", "end_time": "10:00", "category": "工作"}`
- parsed: `{"title": "我想想啊，，，系统维护，我再", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0052 oral_repeat
- text: 先给我记个背单词，时间是本周日下午三点，嗯。
- source: rules
- mismatches: `{"category": {"expected": "学习", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "15:00", "end_time": "16:00", "category": "学习"}`
- parsed: `{"title": "先给我记个背单词，时间是，嗯", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "15:00", "end_time": "16:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0054 oral_repeat
- text: 别弄错，这周日，上午九点，背单词，我再确认一下就是这周日上午九点。
- source: rules
- mismatches: `{"category": {"expected": "学习", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "09:00", "end_time": "10:00", "category": "学习"}`
- parsed: `{"title": "别弄错，，，背单词，我再", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0055 oral_repeat
- text: 下周三下午五点大扫除，嗯对，下午五点，不是别的时间。
- source: rules
- mismatches: `{"category": {"expected": "生活", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-15", "start_time": "17:00", "end_time": "18:00", "category": "生活"}`
- parsed: `{"title": "大扫除，嗯对，，不是别的时间", "event_type": "once", "start_date": "2026-07-15", "end_date": null, "start_time": "17:00", "end_time": "18:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0064 oral_repeat
- text: 先给我记个大扫除，时间是七月十八号下午两点，对了。
- source: rules
- mismatches: `{"category": {"expected": "生活", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-18", "start_time": "14:00", "end_time": "15:00", "category": "生活"}`
- parsed: `{"title": "先给我记个大扫除，时间是，对了", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": "14:00", "end_time": "15:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0081 oral_repeat
- text: 不是星期日，是星期五上午九点报销发票。
- source: rules
- mismatches: `{"start_date": {"expected": "2026-07-10", "actual": "2026-07-12"}}`
- expected: `{"start_date": "2026-07-10", "start_time": "09:00", "end_time": "10:00", "category": "财务"}`
- parsed: `{"title": "不是，是报销发票", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "财务", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0082 oral_repeat
- text: 礼拜六上午九点，不对，改成晚上八点朋友聚餐。
- source: rules
- mismatches: `{"start_time": {"expected": "20:00", "actual": "09:00"}, "end_time": {"expected": "21:00", "actual": "10:00"}}`
- expected: `{"start_date": "2026-07-11", "start_time": "20:00", "end_time": "21:00", "category": "社交"}`
- parsed: `{"title": "不对，改成朋友聚餐", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "社交", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0083 oral_repeat
- text: 大后天晚上八点说错了，最终是下周五下午五点健身核心训练。
- source: rules
- mismatches: `{"start_date": {"expected": "2026-07-17", "actual": "2026-07-12"}, "start_time": {"expected": "17:00", "actual": "20:00"}, "end_time": {"expected": "18:00", "actual": "21:00"}}`
- expected: `{"start_date": "2026-07-17", "start_time": "17:00", "end_time": "18:00", "category": "健康"}`
- parsed: `{"title": "说错了，最终是健身核心训练", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "20:00", "end_time": "21:00", "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0084 oral_repeat
- text: 不是下周六，是周五晚上九点还房贷。
- source: rules
- mismatches: `{"start_date": {"expected": "2026-07-10", "actual": "2026-07-18"}}`
- expected: `{"start_date": "2026-07-10", "start_time": "21:00", "end_time": "22:00", "category": "财务"}`
- parsed: `{"title": "不是，是还房贷", "event_type": "once", "start_date": "2026-07-18", "end_date": null, "start_time": "21:00", "end_time": "22:00", "is_all_day": false, "category": "财务", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0085 oral_repeat
- text: 本周日中午十二点，不对，改成下午三点系统维护。
- source: rules
- mismatches: `{"start_time": {"expected": "15:00", "actual": "12:00"}, "end_time": {"expected": "16:00", "actual": "13:00"}, "category": {"expected": "工作", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "15:00", "end_time": "16:00", "category": "工作"}`
- parsed: `{"title": "不对，改成系统维护", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "12:00", "end_time": "13:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0086 oral_repeat
- text: 星期天中午十二点说错了，最终是大后天晚上八点整理文件。
- source: rules
- mismatches: `{"start_time": {"expected": "20:00", "actual": "12:00"}, "end_time": {"expected": "21:00", "actual": "13:00"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "20:00", "end_time": "21:00", "category": "其他"}`
- parsed: `{"title": "说错了，最终是整理文件", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "12:00", "end_time": "13:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0087 oral_repeat
- text: 不是礼拜天，是下周五晚上八点跑步。
- source: rules
- mismatches: `{"start_date": {"expected": "2026-07-17", "actual": "2026-07-12"}}`
- expected: `{"start_date": "2026-07-17", "start_time": "20:00", "end_time": "21:00", "category": "健康"}`
- parsed: `{"title": "不是，是跑步", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "20:00", "end_time": "21:00", "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0088 oral_repeat
- text: 礼拜五上午九点，不对，改成下午五点搬家。
- source: rules
- mismatches: `{"start_time": {"expected": "17:00", "actual": "09:00"}, "end_time": {"expected": "18:00", "actual": "10:00"}}`
- expected: `{"start_date": "2026-07-10", "start_time": "17:00", "end_time": "18:00", "category": "生活"}`
- parsed: `{"title": "不对，改成搬家", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "生活", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0089 oral_repeat
- text: 下周三下午三点说错了，最终是大后天中午十二点去车站。
- source: rules
- mismatches: `{"start_time": {"expected": "12:00", "actual": "15:00"}, "end_time": {"expected": "13:00", "actual": "16:00"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "12:00", "end_time": "13:00", "category": "出行"}`
- parsed: `{"title": "说错了，最终是去车站", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "15:00", "end_time": "16:00", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0090 oral_repeat
- text: 不是本周六，是周日晚上八点参加培训。
- source: rules
- mismatches: `{"start_date": {"expected": "2026-07-12", "actual": "2026-07-11"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "20:00", "end_time": "21:00", "category": "学习"}`
- parsed: `{"title": "不是，是参加培训", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "20:00", "end_time": "21:00", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0091 oral_repeat
- text: 下周四上午九点，不对，改成晚上九点吃药。
- source: rules
- mismatches: `{"start_time": {"expected": "21:00", "actual": "09:00"}, "end_time": {"expected": "22:00", "actual": "10:00"}}`
- expected: `{"start_date": "2026-07-16", "start_time": "21:00", "end_time": "22:00", "category": "健康"}`
- parsed: `{"title": "不对，改成吃药", "event_type": "once", "start_date": "2026-07-16", "end_date": null, "start_time": "09:00", "end_time": "10:00", "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0092 oral_repeat
- text: 星期天上午八点半说错了，最终是本周日下午两点参加培训。
- source: rules
- mismatches: `{"start_time": {"expected": "14:00", "actual": "08:30"}, "end_time": {"expected": "15:00", "actual": "09:30"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "14:00", "end_time": "15:00", "category": "学习"}`
- parsed: `{"title": "说错了，最终是参加培训", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "08:30", "end_time": "09:30", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0093 oral_repeat
- text: 不是周六，是周天下午五点旅行。
- source: rules
- mismatches: `{"start_date": {"expected": "2026-07-12", "actual": "2026-07-11"}}`
- expected: `{"start_date": "2026-07-12", "start_time": "17:00", "end_time": "18:00", "category": "出行"}`
- parsed: `{"title": "不是，是旅行", "event_type": "once", "start_date": "2026-07-11", "end_date": null, "start_time": "17:00", "end_time": "18:00", "is_all_day": false, "category": "出行", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0094 oral_repeat
- text: 这周五下午三点，不对，改成晚上七点背单词。
- source: rules
- mismatches: `{"start_time": {"expected": "19:00", "actual": "15:00"}, "end_time": {"expected": "20:00", "actual": "16:00"}, "category": {"expected": "学习", "actual": "其他"}}`
- expected: `{"start_date": "2026-07-10", "start_time": "19:00", "end_time": "20:00", "category": "学习"}`
- parsed: `{"title": "不对，改成背单词", "event_type": "once", "start_date": "2026-07-10", "end_date": null, "start_time": "15:00", "end_time": "16:00", "is_all_day": false, "category": "其他", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0095 oral_repeat
- text: 周天下午五点说错了，最终是下周三中午十二点阅读论文。
- source: rules
- mismatches: `{"start_date": {"expected": "2026-07-15", "actual": "2026-07-12"}, "start_time": {"expected": "12:00", "actual": "17:00"}, "end_time": {"expected": "13:00", "actual": "18:00"}}`
- expected: `{"start_date": "2026-07-15", "start_time": "12:00", "end_time": "13:00", "category": "学习"}`
- parsed: `{"title": "说错了，最终是阅读论文", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "17:00", "end_time": "18:00", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0096 oral_repeat
- text: 不是星期天，是下周二上午八点半上课。
- source: rules
- mismatches: `{"start_date": {"expected": "2026-07-14", "actual": "2026-07-12"}}`
- expected: `{"start_date": "2026-07-14", "start_time": "08:30", "end_time": "09:30", "category": "学习"}`
- parsed: `{"title": "不是，是上课", "event_type": "once", "start_date": "2026-07-12", "end_date": null, "start_time": "08:30", "end_time": "09:30", "is_all_day": false, "category": "学习", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
### RB0097 oral_repeat
- text: 今天晚上七点，不对，改成上午九点跑步。
- source: rules
- mismatches: `{"start_time": {"expected": "09:00", "actual": "19:00"}, "end_time": {"expected": "10:00", "actual": "20:00"}}`
- expected: `{"start_date": "2026-07-09", "start_time": "09:00", "end_time": "10:00", "category": "健康"}`
- parsed: `{"title": "不对，改成跑步", "event_type": "once", "start_date": "2026-07-09", "end_date": null, "start_time": "19:00", "end_time": "20:00", "is_all_day": false, "category": "健康", "reminder_minutes": 15, "needs_clarification": false, "location": null, "parse_source": "rules", "confidence": 0.97}`
