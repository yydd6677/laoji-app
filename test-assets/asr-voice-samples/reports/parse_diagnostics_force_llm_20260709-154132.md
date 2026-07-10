# LaoJi Force LLM Parse Diagnostics 20260709-154132

- Total: 68
- OK: 56
- Failed: 12
- Mismatch rows: 11
- Elapsed: 91.61s
- Parse sources: {'local_llm': 67, 'NULL': 1}

## Bad Rows

### 004 None
- source: local_llm
- parsed: title=周会, event_type=once, start_date=2026-07-12, end_date=None, start_time=10:00, end_time=11:00, category=工作, clarify=False
- mismatches: {"start_date": {"expected": "2026-07-13", "actual": "2026-07-12"}}
- error: None

### 010 None
- source: local_llm
- parsed: title=整理东西, event_type=once, start_date=2026-07-10, end_date=None, start_time=None, end_time=None, category=生活, clarify=True
- mismatches: {"category": {"expected": "其他", "actual": "生活"}}
- error: None

### 014 None
- source: local_llm
- parsed: title=参加培训, event_type=once, start_date=2026-07-10, end_date=2026-07-14, start_time=None, end_time=None, category=学习, clarify=True
- mismatches: {"end_date": {"expected": "2026-07-13", "actual": "2026-07-14"}}
- error: None

### 018 None
- source: local_llm
- parsed: title=完成报告, event_type=once, start_date=2026-07-12, end_date=2026-07-14, start_time=None, end_time=None, category=工作, clarify=True
- mismatches: {"start_date": {"expected": "2026-07-13", "actual": "2026-07-12"}, "end_date": {"expected": "2026-07-15", "actual": "2026-07-14"}}
- error: None

### 028 None
- source: local_llm
- parsed: title=交材料, event_type=once, start_date=2026-07-10, end_date=None, start_time=10:00, end_time=10:00, category=工作, clarify=False
- mismatches: {"reminder_minutes": {"expected": 30, "actual": 15}}
- error: None

### 029 None
- source: local_llm
- parsed: title=还款, event_type=once, start_date=2026-07-09, end_date=None, start_time=17:00, end_time=18:00, category=财务, clarify=False
- mismatches: {"reminder_minutes": {"expected": 60, "actual": 15}}
- error: None

### 030 None
- source: local_llm
- parsed: title=明天晚上聚餐, event_type=once, start_date=2026-07-10, end_date=None, start_time=19:00, end_time=20:00, category=社交, clarify=False
- mismatches: {"reminder_minutes": {"expected": 0, "actual": 15}}
- error: None

### 042 None
- source: None
- parsed: title=None, event_type=None, start_date=None, end_date=None, start_time=None, end_time=None, category=None, clarify=None
- mismatches: {}
- error: parse returned null

### 044 None
- source: local_llm
- parsed: title=阅读论文, event_type=once, start_date=2026-07-16, end_date=None, start_time=None, end_time=None, category=学习, clarify=True
- mismatches: {"start_date": {"expected": "2026-07-10", "actual": "2026-07-16"}}
- error: None

### 051 None
- source: local_llm
- parsed: title=整理文件, event_type=once, start_date=2026-07-11, end_date=None, start_time=None, end_time=None, category=工作, clarify=True
- mismatches: {"category": {"expected": "其他", "actual": "工作"}}
- error: None

### 054 None
- source: local_llm
- parsed: title=和朋友吃饭, event_type=once, start_date=2026-07-16, end_date=None, start_time=19:00, end_time=20:00, category=社交, clarify=False
- mismatches: {"start_date": {"expected": "2026-07-10", "actual": "2026-07-16"}}
- error: None

### 060 None
- source: local_llm
- parsed: title=给妈妈打电话, event_type=once, start_date=2026-07-10, end_date=None, start_time=20:00, end_time=21:00, category=生活, clarify=False
- mismatches: {"category": {"expected": "其他", "actual": "生活"}}
- error: None
