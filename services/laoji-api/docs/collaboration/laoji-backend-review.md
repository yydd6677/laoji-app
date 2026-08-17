# LaoJi Backend Collaboration Review

## 2026-07-16 Guest Transcript Disconnect Recovery

### Summary
- Added a token-scoped, process-local transcript buffer for active guest realtime meeting sessions.
- Qwen meeting WebSocket final lines now enter that buffer instead of attempting to write a guest ID into the account meeting database.
- Added `GET /api/laoji/meetings/guest-sessions/{meeting_id}/transcripts` with `X-Guest-Session-Token`, `offset`, and `limit` so the Android client can reconcile lines before revoking the guest session.
- The buffer follows the existing two-hour session TTL and is removed immediately on revoke or expiry. It does not extend TTL and does not add per-hour, 500-line, or 50,000-character product limits.

### Files Changed
- `backend/app/services/guest_meeting_session_service.py`
- `backend/app/api/app_meetings.py`
- `backend/app/api/qwen_ws.py`
- `backend/tests/test_guest_meeting_session_service.py`
- `backend/tests/test_guest_transcript_api.py`
- `backend/tests/test_qwen_realtime_ws.py`
- `backend/docs/collaboration/laoji-backend-review.md`
- `/home/zhong/laoji-service-platform/docs/workspace-review.md`

### Verification
- Focused guest-session, endpoint, Qwen routing, WebSocket auth, and existing guest database-boundary tests pass: `19 passed in 1.50s`.
- Python compile checks pass for every changed source and test file.
- A real Qwen meeting probe returned two final lines over WebSocket and the new endpoint returned the same two lines with stable IDs before cleanup; `ready_to_stop` arrived 28 ms after the stop frame and session revoke returned HTTP 204.

### Rollback
- Restore the pre-change copies from `/home/zhong/laoji-service-platform/backups/20260716-guest-transcript-recovery` and restart only the owned `18020` backend after checking active WebSocket connections.
- No database rollback is required because guest transcript recovery is process-local and does not add a table or write account meeting rows.

## 2026-07-11 Production HTTPS/WSS Proxy Template

### Summary
- Added an inactive, single-domain Nginx template for a future publicly trusted
  LaoJi App HTTPS/WSS endpoint.
- Routed auth, profile, schedule events, parse, and clarify to `127.0.0.1:18035`;
  routed App meetings, audio, transcripts, summaries, HTTP ASR, parse-audio, and
  WebSocket ASR to `127.0.0.1:18020`.
- Preserved the current collaborator-owned system Nginx site. No configuration
  was enabled, no service was reloaded, and no running process or database was
  changed.

### Files Changed
- `deploy/nginx/laoji-app-production.conf.example`
- `deploy/nginx/README-laoji-app-production.md`
- `backend/docs/collaboration/laoji-backend-review.md`

### Public Interface Changes
- No API contract changed in this maintenance step.
- The template reserves one future trusted origin for `/api/auth/*`, selected
  `/api/laoji/*` routes, `/ws/*`, `/health`, and `/health/schedule`.
- Unknown paths return HTTP 404; cleartext HTTP redirects to HTTPS except for the
  ACME challenge path.

### Verification
- Rendered all placeholders with a test hostname and the existing workspace
  self-signed certificate; the rendered file contained zero placeholders.
- `/usr/sbin/nginx -t` on the server returned both `syntax is ok` and
  `test is successful`. Because the unprivileged `zhong` account cannot bind
  ports 80/443 during `nginx -t`, only the disposable validation copy was changed
  to loopback ports 38080/38443; the production template remains on 80/443.
- Started the rendered configuration briefly on those two loopback-only test
  ports and verified routing: meeting health returned HTTP 200 from 18020,
  schedule health returned HTTP 200 with `service=laoji` from 18035, auth,
  events, and meetings returned HTTP 401 without credentials, the root returned HTTP 404,
  and cleartext HTTP returned a 301 redirect to HTTPS.
- The temporary main configuration and rendered site were removed automatically.
  No file under `/etc/nginx` was created or changed, and Nginx was not reloaded.
- Live post-check retained the original processes (18020 PID 3112724 and 18035
  PID 2918785), both health endpoints returned `status=ok`, port 443 remained
  closed, and the enabled system site still resolved to the collaborator-owned
  `/home/zhong/SMART-MEETING/.../smart-meeting-ai.conf`.
- Runtime activation is intentionally out of scope until a real DNS name and
  public-CA certificate are provided.

### Rollback
- Delete the two new files under `deploy/nginx/` and remove this review entry.
- No service restart or database rollback is required because the template was
  never enabled.

## 2026-07-09 Cross-Date Event Contract

### Summary
- Added server-side support for cross-date LaoJi events through `end_date`.
- Promoted mobile/design fields into the backend event contract: `color`, `spanning`, `location`, `category`, `detail`, `status`, `reminder_minutes`.
- Updated natural-language parsing output so `/api/laoji/parse`, `/api/laoji/clarify`, and `/api/laoji/parse-audio` can return the expanded structure.
- Restarted the LaoJi backend on port `8035` after code changes.

### Files Changed
- `app/schemas/schedule.py`
- `app/laoji/router.py`
- `app/services/schedule_db_service.py`
- `app/services/schedule_parser_service.py`

Backups were created before editing with suffix:

```text
.bak-20260709-102915-cross-date
```

### Public Interface Changes
- Parse response adds:
  - `end_date: string | null`
  - `color: string | null`
  - `spanning: boolean`
  - `location: string | null`
  - `category: string | null`
  - `detail: string | null`
  - `status: string | null`
  - `reminder_minutes: number | null`
- Event create/update/list/get response adds the same event fields.
- `GET /api/laoji/events?year=&month=` now returns one-off events whose `[start_date, end_date]` overlaps the requested month, not only events whose `start_date` is inside that month.
- `day` queries in the DB helper also include events whose date range covers the requested day.

### Verification
- `python3 -m py_compile app/schemas/schedule.py app/laoji/router.py app/services/schedule_db_service.py app/services/schedule_parser_service.py`: passed.
- Direct parser checks:
  - `7月19日到7月25日完成笔记本制作` returns `start_date=2026-07-19`, `end_date=2026-07-25`, `spanning=true`, `is_all_day=true`, `needs_clarification=false`.
  - `今天下午三点开会` returns `start_time=15:00`, `end_time=16:00`, `reminder_minutes=15`.
- Temp SQLite check confirmed a `2026-07-30` to `2026-08-02` event appears in July query, August query, and `2026-08-01` day query.
- Runtime HTTP checks after restart:
  - `GET http://127.0.0.1:8035/health` returned `{"status":"ok","env":"local","service":"laoji"}`.
  - `POST /api/laoji/parse` returned the expanded fields above.

### Rollback
- Stop the current `8035` process.
- Restore the four `.bak-20260709-102915-cross-date` files over their active paths.
- Restart the previous command:

```text
./.venv/bin/python3.11 -m uvicorn app.laoji.main:app --host 0.0.0.0 --port 8035
```

SQLite migration only adds nullable columns and indexes; old clients can ignore the new response fields.


## 2026-07-09 Schedule Category Rules Expansion

### Summary
- Expanded LaoJi quick parser category inference from four practical categories to seven canonical categories: `工作`, `学习`, `健康`, `社交`, `出行`, `重要`, `生活`.
- Updated the schedule LLM prompt so model output should use the same canonical category set when a category can be inferred.
- Added server-side normalization for LLM category output: canonical values are kept; non-canonical labels are rechecked against the same keyword rules; otherwise `category` remains `null`.

### Files Changed
- `app/services/schedule_parser_service.py`
- `docs/collaboration/laoji-backend-review.md`

Backups were created before editing with suffix:

```text
.bak-20260709-121406-category-rules
```

### Category Rules
- `工作`: 工作、会议、开会、周会、周报、项目、评审、复盘、需求、汇报、报告、预算
- `学习`: 学习、上课、课程、考试、作业、论文、阅读、培训
- `健康`: 健康、健身、运动、跑步、训练、复诊、体检、看病、服药、吃药
- `社交`: 社交、聚餐、约会、朋友、生日
- `出行`: 出行、旅行、旅游、交通、航班、飞机、高铁、火车、车票、机票、打车、坐车
- `重要`: 重要、截止、紧急、缴费、交费、还款、账单
- `生活`: 生活、家务、购物、买、取、家、个人、提醒、快递

### Verification
- Pending in this entry: run `python3 -m py_compile app/services/schedule_parser_service.py`, direct parser samples, and runtime `/api/laoji/parse` checks after restart.

### Rollback
- Restore `app/services/schedule_parser_service.py.bak-20260709-121406-category-rules` over `app/services/schedule_parser_service.py`.
- Restart the LaoJi backend process on port `8035`.


## 2026-07-09 Fixed Schedule Category Enum

### Summary
- Replaced the interim seven-category parser design with a fixed shared category enum for backend and client: `工作`, `学习`, `健康`, `生活`, `社交`, `出行`, `财务`, `重要`, `其他`.
- Backend schema now exposes `category` as this fixed enum where schedule create/update/response schemas carry the field.
- Server parsing normalizes keywords into the fixed enum. Unknown or uncategorized events now become `其他` instead of arbitrary labels.
- `财务` owns payment/accounting keywords such as `缴费`, `还款`, `账单`, `发票`, `报销`; `重要` is reserved for priority/deadline keywords such as `截止`, `紧急`, `到期`, `必须`, `尽快`.

### Files Changed
- `app/schemas/schedule.py`
- `app/services/schedule_parser_service.py`
- `docs/collaboration/laoji-backend-review.md`

Backups were created before editing with suffix:

```text
.bak-20260709-121609-fixed-category-enum
```

### Category Rules
- `工作`: 工作、会议、开会、周会、周报、项目、评审、复盘、需求、汇报、报告、预算
- `学习`: 学习、上课、课程、考试、作业、论文、阅读、培训
- `健康`: 健康、健身、运动、跑步、训练、复诊、体检、看病、服药、吃药
- `生活`: 生活、家务、购物、买、取、家、个人、提醒、快递
- `社交`: 社交、聚餐、约会、朋友、生日
- `出行`: 出行、旅行、旅游、交通、航班、飞机、高铁、火车、车票、机票、打车、坐车
- `财务`: 财务、钱、付款、付钱、支付、缴费、交费、还款、账单、发票、报销、工资、收入、贷款、房贷、信用卡
- `重要`: 重要、截止、紧急、到期、必须、尽快、加急、ddl、deadline
- `其他`: 未命中以上规则的默认分类

### Verification
- Pending in this entry: run schema/parser compile checks, direct parser samples, OpenAPI enum check, and runtime `/api/laoji/parse` checks after restarting port `8035`.

### Rollback
- Restore `app/schemas/schedule.py.bak-20260709-121609-fixed-category-enum` and `app/services/schedule_parser_service.py.bak-20260709-121609-fixed-category-enum` over the active files.
- Restart the LaoJi backend process on port `8035`.


### Verification Update - 2026-07-09 Fixed Category Enum
- `python3 -m py_compile app/schemas/schedule.py app/services/schedule_parser_service.py app/laoji/router.py`: passed.
- Restarted LaoJi backend on port `8035`: old PID `916764`, new PID `1268069`.
- `GET http://127.0.0.1:8035/health` returned `{"status":"ok","env":"local","service":"laoji"}`.
- OpenAPI now exposes `category` enum on `ScheduleEventCreate`, `ScheduleEventUpdate`, `ScheduleEvent`, and `ScheduleParseResponse`: `工作`, `学习`, `健康`, `生活`, `社交`, `出行`, `财务`, `重要`, `其他`.
- Runtime `/api/laoji/parse` checks returned expected categories:
  - `明天下午三点开会` -> `工作`
  - `下周一学习课程` -> `学习`
  - `今天晚上跑步训练` -> `健康`
  - `后天取快递` -> `生活`
  - `周六朋友聚餐` -> `社交`
  - `明天买高铁车票` -> `出行`
  - `今天缴费还款` -> `财务`
  - `明天下午截止提交材料` -> `重要`
  - `明天整理东西` -> `其他`


## 2026-07-09 LaoJi Quality Diagnostics API

### Summary
- Added authenticated diagnostics endpoints for server-side quality checks without requiring Android device interaction.
- `POST /api/laoji/diagnostics/parse-quality` evaluates natural-language text samples against expected structured schedule fields.
- `POST /api/laoji/diagnostics/audio-quality` evaluates audio ASR text, optional transcript similarity, and parsed schedule fields.
- Endpoints require Bearer auth through existing LaoJi auth to avoid exposing batch ASR/LLM work as an unauthenticated public workload.

### Files Changed
- `app/schemas/schedule.py`
- `app/laoji/router.py`
- `docs/collaboration/laoji-backend-review.md`

Backups were created before editing with suffix:

```text
.bak-20260709-122316-quality-diagnostics
```

### Interface
- Text samples: up to 30 per request, each with `text` and optional `expected` fields.
- Audio samples: up to 8 per request, each with `audio_base64`, `filename`, optional `expected_text`, and optional `expected` parse fields.
- Audio formats are decoded by the existing schedule ASR path, including wav/mp3/aac/m4a when ffmpeg/libsndfile can decode them.

### Verification
- Pending in this entry: compile checks, direct route logic checks, OpenAPI checks, and HTTP auth-guard checks after restart.

### Rollback
- Restore `app/schemas/schedule.py.bak-20260709-122316-quality-diagnostics` and `app/laoji/router.py.bak-20260709-122316-quality-diagnostics` over active files.
- Restart the LaoJi backend process on port `8035`.


### Verification Update - 2026-07-09 Quality Diagnostics API
- `python3 -m py_compile app/schemas/schedule.py app/laoji/router.py app/services/schedule_parser_service.py`: passed.
- Direct diagnostic comparison helper checks passed for:
  - `明天下午三点开会` -> `category=工作`, `start_time=15:00`
  - `今天缴费还款` -> `category=财务`
  - `明天整理东西` -> `category=其他`
- Restarted LaoJi backend on port `8035`: old PID `1268069`, new PID `1283315`.
- `GET http://127.0.0.1:8035/health` returned `{"status":"ok","env":"local","service":"laoji"}`.
- OpenAPI exposes diagnostic paths:
  - `/api/laoji/diagnostics/parse-quality`
  - `/api/laoji/diagnostics/audio-quality`
- Diagnostic endpoints are protected by `HTTPBearer`; unauthenticated `POST /api/laoji/diagnostics/parse-quality` returned `401 {"detail":"请先登录"}`.

### Suggested Diagnostic Samples
- Text parse samples should cover: relative dates, explicit dates, cross-date ranges, repeat rules, fixed categories, reminders, no-reminder cases, missing time clarification, and unknown category fallback.
- Audio samples should reuse the same utterances where possible and be provided as `wav`, `mp3`, `aac`, or `m4a`; the request should include `expected_text` plus the same `expected` parse fields.


## 2026-07-09 LaoJi Schedule LLM Fallback Availability

### Summary
- Fixed the schedule parser LLM fallback path timing out before Qwen could return.
- Kept the existing fast rule parser as the first path; only rule misses use the local LLM fallback.
- Added a per-call output token cap for schedule parsing so it no longer inherits the meeting-summary token budget.

### Files Changed
- `../meetingsummary/ollama_client.py`
- `app/services/schedule_parser_service.py`
- `docs/collaboration/laoji-backend-review.md`

Backups were created before editing with suffix:

```text
.bak-20260709-llm-fallback-availability
```

### Interface / Runtime Behavior
- Existing callers of `call_ollama(...)` remain compatible.
- `call_ollama(...)` now accepts optional `max_tokens`; when omitted, it still uses `MEETING_SUMMARY_MAX_TOKENS`.
- Schedule parsing now uses:
  - `SCHEDULE_LLM_TIMEOUT`, default `45` seconds, minimum `10`.
  - `SCHEDULE_LLM_MAX_TOKENS`, default `384`, clamped to `128..1024`.
- The default schedule model remains `SCHEDULE_OLLAMA_MODEL` or `qwen3:8b`.

### Verification
- Pending in this entry: compile checks, direct parser fallback checks, HTTP `/api/laoji/parse` checks, and restart of port `8035`.

### Rollback
- Restore `../meetingsummary/ollama_client.py.bak-20260709-llm-fallback-availability` and `app/services/schedule_parser_service.py.bak-20260709-llm-fallback-availability` over active files.
- Restart the LaoJi backend process on port `8035`.


### Verification Update - 2026-07-09 Schedule LLM Fallback Availability
- `python3 -m py_compile meetingsummary/ollama_client.py backend/app/services/schedule_parser_service.py backend/app/laoji/router.py`: passed.
- Restarted LaoJi backend on port `8035`: old PID `1283315`, new PID `1883790`.
- `GET http://127.0.0.1:8035/health` returned `{"status":"ok","env":"local","service":"laoji"}`.
- Direct reproduction before the change: `POST /api/laoji/parse` for `十分钟后提醒我喝水` and `下午开会` timed out after 12 seconds and returned `422`.
- After the change, the eight previous rule-miss samples all returned HTTP success with `parse_source=local_llm`:
  - `十分钟后提醒我喝水`: 20.14s
  - `一小时后提醒我打电话`: 18.50s
  - `下午开会`: 18.44s
  - `晚上去健身`: 18.20s
  - `下个月交报告`: 17.88s
  - `周末聚餐`: 18.37s
  - `有空的时候整理资料`: 17.82s
  - `记一下那个事情`: 18.19s
- Remaining scope: this change restores LLM fallback availability. It does not claim all model-derived date/time choices are semantically correct; parse quality still needs separate sample-driven tuning.


## 2026-07-09 LaoJi Schedule Parser Accuracy And LLM Cost Tuning

### Summary
- Improved quick-rule parsing for Chinese date ranges, same-day ranges, yearly repeats, explicit time ranges, and fixed-category inference.
- Added current clock time to the schedule LLM prompt and added hard post-processing for relative offsets such as `十分钟后` and vague `下个月`.
- Reduced schedule LLM fallback cost by sending a small context window and lower output cap for LaoJi schedule parsing only.
- Corrected local diagnostic sample `012`: on `2026-07-09`, `明天` and `周五` are both `2026-07-10`, so the sample is not cross-date.

### Files Changed
- `../meetingsummary/ollama_client.py`
- `app/services/schedule_parser_service.py`
- `docs/collaboration/laoji-backend-review.md`
- Local mobile diagnostic manifest: `test-assets/asr-voice-samples/manifest.json`

Backups were created before editing with suffix:

```text
.bak-20260709-parser-accuracy-speed
```

### Interface / Runtime Behavior
- Existing `call_ollama(...)` callers remain compatible.
- `call_ollama(...)` now accepts optional provider `options`.
- Schedule LLM fallback now sends:
  - `SCHEDULE_LLM_MAX_TOKENS`, default `256`.
  - `SCHEDULE_LLM_NUM_CTX`, default `2048`.
- Quick parser changes:
  - Supports 3-character Chinese day numbers such as `二十五`, `二十二`, `三十一`.
  - Supports `开始到` in date ranges.
  - Treats same-day ranges as single-day events with `end_date=null`.
  - Parses `上午九点到十一点` and `下午两点到四点` as explicit time ranges.
  - Adds `出差/机场/车站` to `出行`, `睡觉/喝水` to `生活`, and removes action word `提醒` from category inference.
  - Returns a low-confidence clarification draft for explicit note-taking intents such as `记一下那个事情` instead of returning null.
- LLM output normalization now lets fixed server keyword rules override model categories when the raw text has a clear category keyword.

### Performance Note
- A read-only resource investigation found `qwen3:8b` hot inference for the schedule payload is about 1.4s, while the previous 18-20s behavior is consistent with cold loading, shared-GPU pressure, and oversized 32K context allocation.
- This change only applies low-risk request-level tuning. It does not restart Ollama or change shared environment variables such as `CUDA_LAUNCH_BLOCKING=1`.

### Verification
- Pending in this entry: compile checks, direct parser samples, HTTP parse checks, and full 68-sample diagnostics after restarting port `8035`.

### Rollback
- Restore `../meetingsummary/ollama_client.py.bak-20260709-parser-accuracy-speed` and `app/services/schedule_parser_service.py.bak-20260709-parser-accuracy-speed` over active files.
- Restore the previous local `test-assets/asr-voice-samples/manifest.json` from source control or the previous generated copy if needed.
- Restart the LaoJi backend process on port `8035`.


### Verification Update - 2026-07-09 Parser Accuracy And LLM Cost Tuning
- `python3 -m py_compile meetingsummary/ollama_client.py backend/app/services/schedule_parser_service.py backend/app/laoji/router.py`: passed.
- Restarted LaoJi backend on port `8035`: old PID `2183868`, new PID `2193981`.
- `GET http://127.0.0.1:8035/health` returned `{"status":"ok","env":"local","service":"laoji"}`.
- Direct HTTP checks passed for previous rule errors:
  - `七月十九日到七月二十五日完成笔记本制作` -> `end_date=2026-07-25`.
  - `七月二十号到二十二号家里大扫除` -> `end_date=2026-07-22`.
  - `下周一开始到周三完成预算报告` -> `end_date=2026-07-15`.
  - `下周二上午九点到十一点参加培训` -> `end_time=11:00`.
  - `七月二十号下午两点到四点做需求评审` -> `end_time=16:00`.
  - `每年十二月三十一号做年度复盘` -> `event_type=yearly`.
  - `明天下午三点去机场` -> `category=出行`.
  - `每天晚上十点睡觉` -> `category=生活`.
  - `明天晚上八点提醒我给妈妈打电话` -> `category=其他`.
- LLM fallback checks:
  - `十分钟后提醒我喝水` cold call: 6.66s, `parse_source=local_llm`, `reminder_minutes=0`, context length now `2048`.
  - Hot fallback calls for `一小时后提醒我打电话`, `下个月交报告`, and `周末聚餐`: about 1.3s each.
  - `下午开会` now returns `start_time=null`, `needs_clarification=true`; it no longer guesses a clock time.
- Full MP3 diagnostics:
  - Report: `test-assets/asr-voice-samples/reports/asr_diagnostics_mp3_20260709-150727.json`.
  - Total `68`; OK `68`; failed `0`; mismatch rows `0`.
  - Parse source counts: `rules=63`, `local_llm=5`.
  - Transcript score: avg `1.0`, min `1.0`.
  - Total elapsed: `114.88s`; first batch included ASR/model warm-up, later batches were 2.6-7.6s.


## 2026-07-09 LaoJi Force LLM Parse Test Mode

### Summary
- Added a runtime test switch to bypass quick rule parsing and send all schedule text parsing to the local LLM path.
- This is intended for temporary measurement of model-only behavior; default behavior remains rule-first unless the environment variable is enabled.

### Files Changed
- `app/services/schedule_parser_service.py`
- `docs/collaboration/laoji-backend-review.md`

Backups were created before editing with suffix:

```text
.bak-20260709-force-llm-test
```

### Runtime Behavior
- `SCHEDULE_FORCE_LLM=1` skips `_parse_schedule_text_quick(...)` in both async and sync schedule parsing paths.
- When `SCHEDULE_FORCE_LLM` is absent or false, behavior returns to the normal rule-first path.
- This switch affects `/api/laoji/parse`, `/api/laoji/parse-audio`, clarification follow-up calls that use `parse_schedule_text_sync`, and diagnostics endpoints that call the parser.

### Verification
- Pending in this entry: compile check, restart with `SCHEDULE_FORCE_LLM=1`, and HTTP parse checks showing `parse_source=local_llm` for formerly rule-parsed samples.

### Rollback / Restore Rule-First
- Restart the `8035` LaoJi backend without `SCHEDULE_FORCE_LLM=1`.
- If code rollback is needed, restore `app/services/schedule_parser_service.py.bak-20260709-force-llm-test` over the active file and restart.


### Verification Update - 2026-07-09 Force LLM Parse Test Mode
- `python3 -m py_compile backend/app/services/schedule_parser_service.py backend/app/laoji/router.py`: passed.
- Restarted LaoJi backend on port `8035` with `SCHEDULE_FORCE_LLM=1`: old PID `2193981`, new PID `2289075`.
- `GET http://127.0.0.1:8035/health` returned `{"status":"ok","env":"local","service":"laoji"}`.
- Direct HTTP checks confirmed formerly rule-parsed samples now return `parse_source=local_llm`:
  - `明天下午三点开会`: 7.15s cold call, `start_date=2026-07-10`, `start_time=15:00`, `category=工作`.
  - `七月十九日到七月二十五日完成笔记本制作`: 1.35s hot call, `end_date=2026-07-25`.
  - `下周二上午九点到十一点参加培训`: 1.44s hot call, but model returned `start_date=2026-07-13`, showing model-only date quality risk.
  - `每天晚上十点睡觉`: 1.28s hot call, `event_type=daily`.
  - `记一下那个事情`: 1.35s hot call, `needs_clarification=true`.
- Full text-only diagnostics with force-LLM mode:
  - Report: `test-assets/asr-voice-samples/reports/parse_diagnostics_force_llm_20260709-154132.json`.
  - Total `68`; OK `56`; failed/mismatch rows `12`; mismatch rows `11`; parse source counts `local_llm=67`, `NULL=1`.
  - Total elapsed `91.61s` for 68 model calls.
  - Main model-only issues: weekday/date offsets, reminder minutes, borderline categories, and one low-information note returning null.
- Current runtime remains in force-LLM test mode until the `8035` backend is restarted without `SCHEDULE_FORCE_LLM=1`.

### Verification Update - 2026-07-09 Restore Rule-First Runtime
- Restarted LaoJi backend on port `8035` without `SCHEDULE_FORCE_LLM`: old PID `2289075`, new PID `2424057`.
- Current process environment no longer contains `SCHEDULE_FORCE_LLM`.
- `GET http://127.0.0.1:8035/health` returned `{"status":"ok","env":"local","service":"laoji"}`.
- Direct HTTP check `周日上午十点吃饭` returned `start_date=2026-07-12`, `start_time=10:00`, `end_time=11:00`, `parse_source=rules`, `needs_clarification=false`.
- Rollback note: restore force-LLM test behavior only by restarting `8035` with `SCHEDULE_FORCE_LLM=1`; default shared runtime should remain rule-first.


## 2026-07-09 Review V2 Schedule Parser Routing, Category, Range, Reminder Hardening

### Summary
- Ran the new 1000-row schedule review sample set from the LaoJi mobile workspace against `/api/laoji/parse`.
- Current rule-first behavior over-matched complex correction/noise inputs: before this change, 968/1000 rows used `rules`, only 24 used `local_llm`, and 207 complex rows were swallowed by quick rules.
- Updated the parser to keep simple inputs fast while routing correction/control/ambiguous-complex text to the LLM path.
- Added deterministic post-processing for explicit reminder phrases so LLM output cannot ignore `提前十分钟提醒`, `提前半小时提醒`, `提前一天提醒`, `开始时提醒`, or no-reminder phrases.

### Files Changed
- `app/services/schedule_parser_service.py`
- `docs/collaboration/laoji-backend-review.md`

Backups were created before editing:

```text
app/services/schedule_parser_service.py.bak-20260709-review-v2-routing
app/services/schedule_parser_service.py.bak-20260709-review-v2-reminder
```

### Interface / Behavior Changes
- `/api/laoji/parse` and `/api/laoji/parse-audio` still use rule-first parsing for simple, complete inputs.
- Quick rules are skipped when normalized text contains correction/control signals such as `不是`, `不对`, `说错`, `改成`, `最终`, `不要保存`, `只是测试`, `不是日程`, `晚点补`, `还没定`, or `如果冲突`.
- Explicit non-schedule control text such as `不要真的创建日程`, `只是测试`, `测试麦克风`, `识别效果`, and `随便说一句话` now returns parse failure instead of creating a draft event.
- Quick range parsing now recognizes `月底/月末/下月底/下月末` inside date ranges.
- Fixed category enum remains `工作/学习/健康/生活/社交/出行/财务/重要/其他`; keyword coverage was expanded for common LaoJi sample terms.
- LLM-normalized `reminder_minutes` is overridden by explicit reminder phrases in the original text.

### Diagnostics
- Before change:
  - Report: `mobile/test-assets/schedule-robustness/reports/review_v2_current_server_20260709.json`.
  - Sources: `rules=968`, `local_llm=24`, `None=8`.
  - Rows with diagnostic issues: `743`.
  - Main issues: `category_mismatch=632`, `complex_swallowed_by_rules=207`, `date_range_missing_end_date=57`.
  - Duration: elapsed `80.789s`, median `514ms`, p90 `798ms`.
- After routing/category/range change:
  - Report: `mobile/test-assets/schedule-robustness/reports/review_v2_after_routing_category_range_20260709.json`.
  - Sources: `rules=761`, `local_llm=216`, `None=23`.
  - Rows with diagnostic issues: `497`; ignoring intended negative-control parse failures: `474`.
  - Complex-swallowed-by-rules dropped from `207` to `0`.
  - Category mismatch dropped from `632` to `254`.
  - Date-range-missing-end-date dropped from `57` to `41`; remaining rows are mostly invalid reverse ranges or noise-broken dates.
  - Runtime cost increased: elapsed `246.370s`, median `523ms`, p90 `6818ms`.

### Verification
- `./.venv/bin/python3 -m py_compile app/services/schedule_parser_service.py app/laoji/router.py`: passed.
- Restarted LaoJi backend on port `8035`: old PIDs `2424057` then `2892109`; current PID `2913345`.
- `GET http://127.0.0.1:8035/health` returned `{"status":"ok","env":"local","service":"laoji"}`.
- Direct HTTP checks:
  - `明天下午三点背单词` returned `parse_source=rules`, `category=学习`.
  - `7月18日到月底整理数据报表检查` returned `start_date=2026-07-18`, `end_date=2026-07-31`, `category=工作`.
  - `原来想写下午一点半，不对，改成晚上七点还款截止` returned `parse_source=local_llm`, `start_time=19:00`, `category=重要`.
  - `我刚才只是测试麦克风，不要真的创建日程` returned HTTP `422`.
- Targeted reminder regression over the 18 previous reminder-mismatch rows passed `18/18`.

### Rollback
- To restore the pre-routing behavior, copy `app/services/schedule_parser_service.py.bak-20260709-review-v2-routing` over `app/services/schedule_parser_service.py` and restart port `8035`.
- To keep routing/category/range changes but undo reminder post-processing, copy `app/services/schedule_parser_service.py.bak-20260709-review-v2-reminder` over `app/services/schedule_parser_service.py` and restart port `8035`.


## 2026-07-11 Account Deletion, Legal Pages, And Late-Write Protection

### Scope And Ownership
- All changes are confined to the canonical LaoJi workspace at
  `/home/zhong/laoji-service-platform`; no collaborator workspace or system
  Nginx configuration was modified.
- Shared Ollama configuration and model processes were not changed.
- Ports `18020` and `18035` were still running the previous loaded code when
  this entry was written. Deployment is gated on an isolated candidate run.

### API And Data Contract
- Added authenticated `DELETE /api/auth/me`. It requires the current password
  and the exact confirmation text `删除账号`.
- Added public `POST /api/auth/account-deletion-requests` and status lookup at
  `GET /api/auth/account-deletion-requests/{request_id}` for users who cannot
  enter the App. Responses do not reveal whether an account exists.
- Added an operator-only terminal workflow at
  `scripts/manage_account_deletion_requests.py`; there is no public admin API.
  Completion requires an exact request-ID confirmation and the explicit
  `--identity-verified` flag.
- Account deletion removes account/profile data, all sessions, schedule events,
  avatars, App-owned meetings, audio, segments, transcripts, summaries, and
  their generated files. Request PII is scrubbed after completion or rejection.

### Consistency And Retry Behavior
- Auth deletion first installs a 30-minute deletion lease and revokes all
  sessions. Schedule writes use the same SQLite write transaction to reject a
  missing or deleting owner, preventing late orphan events.
- The meeting database installs a user deletion guard plus SQLite insert/update
  triggers before cleanup. Existing meeting IDs receive separate tombstones so
  late background summary work cannot recreate deleted content.
- Meeting-ID and internal user-ID guards contain no account, contact, transcript,
  summary, or audio content and are retained for at most 30 days.
- Cross-database cleanup is retryable: meeting rows and managed files are
  removed before the auth row. A failure releases the user lease and returns the
  web/operator request to `pending`; a crashed lease expires after 30 minutes.
- Active `recording` or `processing` meetings return a conflict instead of being
  removed underneath a live capture or background processing job.
- Legacy summary files that share an eight-character UUID prefix are detected
  and require manual review instead of risking deletion of another user's file.
- Realtime WebSocket authorization now rejects missing, deleted, tombstoned, or
  non-owner App meetings; only existing public prototype meetings remain public.
- New summary artifact names use the full meeting ID. Readers remain compatible
  with legacy eight-character filenames.

### Public Compliance Assets And Proxy Template
- Added static `/privacy`, `/terms`, and `/account-deletion` pages under
  `deploy/public`, with no analytics, third-party scripts, or password fields.
- Added an inactive production Nginx template under `deploy/nginx`. It requires
  a real domain and public CA certificate, serves the compliance pages, routes
  HTTPS/WSS to `127.0.0.1:18035` and `127.0.0.1:18020`, limits only public
  deletion-request abuse, and leaves ASR/meeting/App traffic unlimited by that
  rule.
- The template was tested through a temporary user-owned Nginx process on
  loopback ports `19080/19443`; HTML/CSS/JS MIME types, HSTS, CSP, HTTP redirect,
  and both upstream health routes passed. The template was not enabled.

### Files Changed
- `app/laoji/auth_router.py`
- `app/laoji/router.py`
- `app/api/app_meetings.py`
- `app/api/ws_auth.py`
- `app/models/summary.py`
- `app/schemas/auth.py`
- `app/services/laoji_auth_service.py`
- `app/services/schedule_db_service.py`
- `app/services/account_deletion_service.py`
- `app/services/account_deletion_operator.py`
- `app/services/offline_pipeline.py`
- `app/services/summary_service.py`
- `app/workers/summary_tasks.py`
- `scripts/manage_account_deletion_requests.py`
- `tests/test_laoji_auth.py`
- `tests/test_account_deletion_service.py`
- `tests/test_account_deletion_operator.py`
- `tests/test_account_deletion_write_guards.py`
- `tests/test_ws_auth.py`
- `tests/test_summary_task_parsing.py`
- `deploy/public/*`
- `deploy/nginx/*`

### Verification Before Deployment
- Server-native `py_compile` passed for all changed Python modules and the
  operator CLI.
- Full backend test suite: `44 passed in 8.09s`.
- Focused deletion, retry, WebSocket, task-retention, and late-write suite:
  `22 passed in 6.64s`.
- Mobile TypeScript check passed; full mobile Jest suite passed
  `32 suites / 185 tests`.
- Deployment remains pending an isolated candidate run against copied databases,
  followed by real-database backups and live API checks.

### Rollback And Recovery
- The schema changes are additive. Do not drop deletion-request or tombstone
  tables during rollback; they protect against late background writes and may
  be retained safely.
- `deploy/nginx/laoji-app-production.conf.example` is inactive, so proxy rollback
  requires no system action.
- Before live restart, create timestamped copies of `backend/data/schedule.db`,
  `backend/local.db`, and the managed App meeting artifact directories. Record
  their paths in a verification update below.
- If the candidate run fails, leave the current `18020/18035` processes intact.
  If a post-switch check fails, stop only the new workspace processes, restore
  the timestamped database copies, and restart from the last verified source
  snapshot; do not change collaborator services or system Nginx.

### Deployment And Verification Update - 2026-07-11
- The first isolated candidate run found that `laoji_auth_service` honored
  `LAOJI_DB_PATH` while `schedule_db_service` ignored it. This caused one uniquely
  named candidate event (`id=11`, title `candidate event`, created at
  `2026-07-11T08:41:57.678974`) to be inserted into the live schedule database.
  The candidate process stopped automatically. A byte-for-byte database backup
  was created at
  `backend/data/backups/schedule.db.20260711-084157-candidate-cleanup`, then only
  that exact six-field row was deleted. A follow-up query returned zero matches.
- `schedule_db_service` now uses the same `LAOJI_DB_PATH` environment contract as
  auth. A regression test proves an isolated path is used. The repeated candidate
  run asserted the live database contained zero candidate rows before, during,
  and after the test.
- The repeated isolated run passed authenticated deletion, wrong-password
  preservation, event/avatar/meeting child and file cleanup, session revocation,
  tombstone finalization, operator completion/rejection, request PII scrubbing,
  and full temporary-data cleanup.
- A further race review added transactional write guards for session creation,
  password change, profile update, avatar upload, and avatar deletion. The avatar
  file and account row are now serialized under the same SQLite write lock;
  failed old-avatar removal enters the existing retry queue. A real two-thread
  test proves deletion waits for avatar commit and then removes the committed
  file without leaving an orphan.
- Final full backend test suite: `47 passed in 10.17s`.
- Pre-switch online SQLite backups and managed-artifact/source archives are in
  `backend/backups/20260711-rc-account-deletion/`. Both database copies passed
  `PRAGMA quick_check`; hashes are recorded in its owner-only `MANIFEST.txt`.
  The final post-write-guard source archive SHA-256 is
  `f050c12eb32c10404cf8682522ec9d4d651a67c38bf4f7519c0469636893ce06`.
- No established client connections and no `recording`/`processing` meetings
  were present before switching. Port `18035` now runs PID `2272060`; port
  `18020` runs PID `2251579`, both from the canonical workspace.
- `18020 /api/health` reports `models_ready=true` with FunASR, punctuation, VAD,
  Chinese CAM++, and English CAM++ all available. GPU memory returned to its
  pre-switch level after warm-up.
- A real temporary production-port account passed the cross-service
  `18035 -> 18020` flow: wrong password preserved data; correct deletion removed
  one event, one meeting, avatar, audio, segment, transcript, period/final
  summaries, two sessions, and login ability with `cleanup_pending=0`.
- A second real account passed the final profile-update/avatar-upload/delete
  smoke after the transactional avatar patch. All temporary users, meetings,
  requests, files, and test tombstones were removed by exact IDs afterward.
- The inactive Nginx template passed another temporary HTTPS run against the new
  live services. The deletion form and request/status API worked, response status
  omitted account/contact, all security headers were present, and a burst check
  produced HTTP 429 responses. The temporary request and Nginx process were
  removed. System Nginx remains unchanged and no public production domain exists.
- Final live database checks: `data/schedule.db: ok`, `local.db: ok`.

### Public Deletion Request Lifecycle Hardening - 2026-07-11
- Public request deduplication now uses the normalized account plus the exact
  trimmed contact value. The check and insert run under one SQLite
  `BEGIN IMMEDIATE` transaction, so concurrent identical submissions produce
  one request ID while a different contact receives an independent request ID.
- Pending public requests expire after 90 days. A request left in `processing`
  for more than 24 hours is returned to `pending` with an operator-visible lease
  expiry note; if that request is also older than 90 days it is then removed.
  Completed and rejected requests continue to have PII scrubbed before their
  status-only row is retained for at most 30 days.
- The public privacy and account-deletion pages now state both retention
  periods. The App privacy text carries the same wording.
- Server-native focused auth tests: `12 passed in 4.80s`; full backend suite:
  `49 passed in 10.47s`. The suite includes a real two-thread deduplication test,
  stale-processing recovery, pending-request expiry, and the existing account,
  meeting, schedule, WebSocket, and summary regressions.
- Only the canonical workspace service on port `18035` was restarted, from PID
  `2272060` to PID `2375521`. The shared workspace service on port `18020`
  remained on PID `2251579`.
- A live `18035` smoke used a unique nonexistent account: same-contact requests
  returned one ID, a different contact returned a second ID, and both status
  responses omitted account/contact. Both rows were deleted by exact ID;
  `data/schedule.db` remained `PRAGMA quick_check=ok`.
- The owner-only post-hardening source archive is
  `backend/backups/20260711-rc-account-deletion/verified-source-post-request-lifecycle.tar.gz`
  with SHA-256
  `db251f0977e7fc67cc22e208dc6148c7e54af41a8c072cfbc12bed3fe229ca62`.
- Rollback does not require a schema change. Reverting the lifecycle constants
  and request query restores the earlier behavior, but expired request rows
  cannot and should not be reconstructed. Do not restore a pre-hardening source
  snapshot without also preserving the current account and meeting deletion
  guards.

### Deletion Failure Semantics And Operation Ownership - 2026-07-11
- A stricter failure-path review found that the prior flow revoked every session
  before checking for an active meeting. A retryable `409` therefore preserved
  account data but forced the user to log in again. It also used user-wide guard
  cancellation, so one concurrent request could release another request's
  deletion lease.
- App and operator deletion now create one operation ID shared across the auth
  and meeting databases. Both stores reject a different active operation, and
  cancellation/finalization only affects a matching owner token. The schema
  additions are nullable `deletion_operation_id` on `laoji_users` and
  `operation_id` on `laoji_user_deletion_tombstones`.
- Password verification and a guarded meeting preflight now happen before the
  auth lease. Active recording/processing and legacy summary-prefix conflicts
  return without touching sessions. During the short destructive phase, tokens
  are suspended but remain stored; final account deletion removes them, while a
  retryable failure releases the lease and makes them usable again. Expired auth
  leases are cleared on both password and token authentication paths so they
  cannot leave profile writes permanently blocked.
- Focused auth/deletion suite: `25 passed in 10.18s`; full backend suite:
  `52 passed in 12.51s`. New coverage proves App and operator conflict session
  preservation, auth/meeting owner isolation, wrong-owner cancellation safety,
  and expired-lease write recovery.
- An isolated candidate used SQLite online copies of both production databases.
  It migrated both old schemas, preserved two sessions after an active-meeting
  conflict, then deleted one event, one ended meeting, and both sessions on
  retry. Candidate databases and untouched production databases all passed
  `PRAGMA quick_check`; the candidate directory was removed automatically.
- Before deployment there were zero active auth deletion leases, active App
  meetings, meeting deletion guards, or established `18035` connections. The
  owner-only pre-switch database backups are
  `schedule-pre-operation-lease.db` (SHA-256
  `df47ae414ea1d80308ffc688f2244ec511ac5a1ed07469675cbf2b7522cd1789`)
  and `meeting-pre-operation-lease.db` (SHA-256
  `f6e2cd96c4a0df62b121d979894f04c158704bb15e4d12c0017f767b82653f04`).
- Port `18035` restarted from PID `2375521` to PID `2465059`; port `18020`
  remained PID `2251579`. A real temporary live account reproduced `409` while
  preserving two tokens, then passed successful retry deletion with exact
  counts `{events: 1, meetings: 1, sessions: 2}`. Its user, event, meeting,
  files, and both tombstone types were removed by exact identifiers afterward;
  both live databases remained `ok`.
- A separate live expiry account was given an already-expired deletion lease.
  Its existing token immediately recovered through `/api/auth/me`, a following
  profile write succeeded, and all four stale lease/owner/count fields were
  cleared. The temporary account and session were then removed exactly.
- The owner-only source archive
  `verified-source-post-operation-lease.tar.gz` has SHA-256
  `2162971b8a514af98746c64a85145b47a814c68df95ee71be4b55674ee369bce`.
  Rollback may restore the two pre-switch database backups plus the previous
  verified source archive. The additive nullable columns are harmless to older
  code and do not need to be dropped during a source-only rollback.

### Transient Guest Realtime Meeting Sessions - 2026-07-11
- A USB phone smoke reproduced a release-blocking mismatch: guest meetings were
  created only in the App cache, while every realtime WebSocket endpoint denied
  a meeting ID that was absent from the meeting database. The service itself
  was healthy; the socket closed before the first audio frame.
- Added `POST /api/laoji/meetings/guest-sessions` and
  `DELETE /api/laoji/meetings/guest-sessions/{meeting_id}`. Creation returns a
  server-generated meeting ID, an opaque token, an expiry time, and
  `transient=true`. Deletion requires the matching `X-Guest-Session-Token`.
- Guest sessions live only in the 18020 process for two hours at most. Tokens
  are stored as SHA-256 digests and compared with `hmac.compare_digest`; expired
  entries are removed opportunistically. The registry has a 4096-session
  resource ceiling but no per-IP or per-user request quota.
- WebSocket authorization accepts the matching guest token from the
  `X-Guest-Session-Token` request header. Authenticated App meetings accept the
  account token from the standard `Authorization: Bearer` header. Query-token
  support remains temporarily for old clients, but the current App no longer
  sends credentials in URLs.
- Guest realtime audio, transcript, and meeting metadata are not written to
  SQLite. The App retains its own local meeting, transcript, and WAV file and
  uses the existing transient guest-summary endpoint when a summary is requested.
- Full backend regression: `55 passed in 10.14s`; focused guest/session/auth
  regression: `5 passed in 0.90s`; changed modules also passed `py_compile`.
- Live production-port smoke verified HTTP create `201`, wrong-token WebSocket
  close `1008`, matching-token `config`, explicit delete `204`, and post-delete
  close `1008`. Follow-up SQLite queries found zero guest-session meeting or
  transcript rows.
- Port 18020 restarted from PID `2251579` to `2685559` for the transient-session
  contract, then to `2765623` for header-based token transport. Before each
  switch there were zero established 18020 connections and zero
  `recording`/`processing` meetings. Health returned HTTP 200 after model warm-up.
- A stricter access-log review found five historical query-token values in two
  LaoJi-owned log files. The service was stopped, all five values were replaced
  with same-length masks, and a recursive follow-up found zero unmasked token
  query values. A real phone connection after the change produced a WebSocket
  access line with no token query parameter.
- The owner-only source archive is
  `backups/20260711-rc-account-deletion/verified-source-post-guest-realtime-session.tar.gz`
  with SHA-256
  `27b6b2bd8d59227c21977b6e31872858c9d44b90aef8cde5df61ba305529e253`.
- Rollback is source-only: restore `app/api/app_meetings.py`,
  `app/api/ws_auth.py`, and `tests/test_ws_auth.py` from the previous verified
  source archive, remove the guest-session service/test, and restart only the
  canonical 18020 process. No database or managed media rollback is required.
  No collaborator workspace, shared Ollama configuration, or system Nginx file
  was modified.

### Idempotent Schedule And Meeting Creation - 2026-07-11
- A stricter timeout review found that both App create endpoints could commit a
  row and lose the HTTP response. Retrying the same user action then created a
  duplicate schedule event or meeting because neither request carried an
  idempotency key and neither database had a corresponding uniqueness rule.
- `POST /api/laoji/events` and `POST /api/laoji/meetings` now accept the optional
  `client_request_id` field. It is unique per user, restricted to a compact
  transport-safe character set, and returned with the created resource.
- Repeating the same key with the same normalized create payload returns the
  original row. Reusing a key with a different payload returns HTTP 409 instead
  of silently returning unrelated data. Old clients that omit the field retain
  their previous behavior.
- The schedule SQLite schema adds nullable `client_request_id` plus the partial
  unique index `idx_schedule_user_client_request`. The meeting schema adds the
  same nullable field and `idx_meetings_user_client_request`; the compatibility
  migration upgrades existing SQLite installations idempotently.
- Pre-change source and consistent SQLite backups are owner-only under
  `backend/backups/20260711-idempotent-create-pre/`. Backup SHA-256 values are
  `57c8dce2a0001d64371cc602aedd9bd2193a783c2fb9bcb30bd01fefd9f18eaf`
  for `schedule.db` and
  `d335b0ecc7796ff2a036670e4fe3783b9ae78886548c845c332a323e98db5405`
  for `local.db`; both passed `PRAGMA quick_check` before deployment.
- Changed modules passed `py_compile`; focused schedule/meeting idempotency tests
  passed `8 passed in 1.20s`; the full backend suite passed
  `58 passed in 11.40s`.
- Before restart both live databases were `ok`, active
  `recording`/`processing` meetings were 0, and established 18020/18035
  connections were 0. Canonical 18035 restarted from PID `2465059` to
  `3799667`; canonical 18020 restarted from PID `2765623` to `3802354`.
- A unique live account proved both endpoints return the same ID for a repeated
  key and HTTP 409 for the same key with changed content. The normal account
  deletion API then removed the temporary event, meeting, sessions, and user.
  Follow-up queries found 0 matching temporary rows; both live databases remain
  `quick_check=ok`, both columns and unique indexes are present, and recent
  service logs contain no traceback, error, or critical entry.
- The owner-only post-deployment source archive is
  `backend/backups/20260711-idempotent-create-pre/verified-source-post-idempotent-create.tar.gz`
  with SHA-256
  `e59437d9bb72bc9a66623cbef3ad3261965c272eb7b5341b660d4ab53bb6e540`.
- Rollback is source-only in normal operation: restore the backed-up Python
  modules and restart only canonical 18035/18020. The additive nullable columns
  and indexes are safe for older code and should remain. Restoring database
  files would discard legitimate writes made after deployment and is reserved
  only for confirmed database corruption. No collaborator workspace, shared
  Ollama configuration, or system Nginx file was modified.

### Authentication Abuse Protection And Sensitive Response Headers - 2026-07-11
- A live read-only review of the running canonical processes found no request
  quota on registration, login, password-reset requests, public deletion
  requests, password changes, or authenticated deletion attempts. The local
  deployment also intentionally used wildcard CORS, and sensitive API responses
  did not set `Cache-Control: no-store`. Unknown-account reset requests were
  persisted indefinitely even though the public response was generic.
- Added a SQLite-backed fixed-window limiter keyed by SHA-256 digests of scope
  plus source/account identity. Raw source addresses and account names are not
  stored in the limiter table. Login has both source and source-account windows;
  successful login clears the source-account window. Registration, password
  reset, public deletion request, password change, and authenticated account
  deletion have endpoint-specific quotas. Rejection is HTTP 429 with an integer
  `Retry-After` header and a generic Chinese message.
- Unknown-account password resets now return a synthetic receipt without a
  database insert. Valid-account requests are transactionally deduplicated for
  24 hours. Migration removes old unknown rows, keeps only the newest pending
  request per valid user, and adds the partial unique index
  `idx_laoji_password_reset_pending_user`. Pending and handled reset rows are
  retained for at most 30 days.
- Unknown-account login performs the same PBKDF2 verification work against a
  fixed dummy hash, reducing the prior account-existence timing difference.
- Both canonical FastAPI entrypoints now add `Cache-Control: no-store, max-age=0`,
  `Pragma: no-cache`, and `X-Content-Type-Options: nosniff` to `/api/auth*` and
  `/api/laoji*` HTTP responses. Production configuration rejects the default or
  short secret, wildcard CORS, non-list CORS values, and non-HTTPS browser
  origins. The current internal `ENV=local` wildcard behavior remains compatible
  until the real production domain is supplied.
- Pre-change source copies and a consistent account database backup are
  owner-only under `backend/backups/20260711-auth-security-pre/`. The pre-change
  `schedule.db` SHA-256 is
  `9cf9fdb968741c544ac5b3212435d8280adcfa0665308c730323813a0370072c`;
  both source and backup database passed `PRAGMA quick_check=ok`.
- Changed modules passed `py_compile`; focused auth/security tests passed
  `20 passed`, the concurrent limiter test admitted exactly 5 of 12 simultaneous
  requests without lock errors, and the full backend suite passed
  `66 passed in 12.88s`. An isolated copy of the live account database migrated
  with both new indexes/tables present and remained `quick_check=ok`.
- Before restart, active recording/processing meetings and established 18020/
  18035 connections were all 0. Canonical 18035 restarted from PID `3799667` to
  `268705`; canonical 18020 restarted from PID `3802354` to `268706`. Both run
  from `/home/zhong/laoji-service-platform/smart-meeting-ai/backend`; all five
  meeting model health flags returned true.
- Live negative smoke produced 401 for login attempts 1-8 and 429 for attempt 9
  with `Retry-After=899`. The limited response, a generic unknown-account reset
  response, and an unauthorized 18020 App-meeting response all carried the
  no-store headers. The unknown reset inserted 0 rows. Exact test limiter rows
  were removed afterward; both live databases remained `quick_check=ok`, and
  recent service logs contained no traceback, error, or critical entry.
- The owner-only post-deployment source archive is
  `backend/backups/20260711-auth-security-pre/verified-source-post-auth-security.tar.gz`,
  size 571849 bytes, SHA-256
  `b76c305c25613f8a0f0ad0296f6c385a896470333f855fe26e97cec0f3fc6672`.
- A normal rollback restores the backed-up Python files, removes
  `app/security_headers.py` and `tests/test_laoji_security.py`, drops only the
  partial index `idx_laoji_password_reset_pending_user`, and restarts canonical
  18035/18020. The additive limiter table may remain unused. Restoring the whole
  database is reserved for confirmed corruption because it would discard valid
  writes after deployment. No collaborator workspace, shared Ollama setting, or
  system Nginx file was modified.

### Dedicated Schedule Realtime ASR - 2026-07-12
- A physical-phone acoustic test found that the schedule input still opened the
  meeting FunASR path. Before the client fix it supplied neither an existing
  meeting nor a transient-session token, so WebSocket authorization closed the
  connection before the first PCM frame. The whole-file fallback recognized the
  same recording, proving that the outage was in realtime session setup rather
  than the ASR model.
- Added `/ws/laoji/schedule/{session_id}/funasr`. It uses the existing transient
  guest-session token contract and the same warmed FunASR, VAD, and punctuation
  models, but does not load CAM++ into the per-connection pipeline, perform
  speaker identification, or persist temporary transcript rows. The existing
  `/ws/meeting/{meeting_id}/funasr` route retains its speaker and persistence
  behavior.
- `create_streaming_pipeline` now accepts the backward-compatible
  `enable_speaker_recognition` option. The meeting default remains `True`; the
  schedule route passes `False`. Unknown-speaker confidence is no longer
  converted from `0.0` to `1.0` by a truthiness fallback.
- The API contract documents the schedule route, 16 kHz mono signed-int16 PCM
  framing, `X-Guest-Session-Token` handshake header, empty end frame, and
  explicit session revocation. The config and completion payloads include
  `purpose: schedule` so clients can verify the selected protocol.
- Pre-change source is owner-only under
  `backend/backups/20260712-schedule-realtime-pre/`. The original
  `funasr_ws.py` SHA-256 is
  `c90c3cc03071140132c6e0150a686518ebd85feccb51e9c25c1d25020c2b9f01`;
  the original `streaming_pipeline.py` SHA-256 is
  `18d60b5041a733f81da64a9dc0a7ce2231d49202371c2643cbeb093c1c54d01a`.
- Changed modules passed `py_compile`; focused route, pipeline, guest-session,
  WebSocket-auth, and non-persistence tests passed `11 passed in 2.14s`; the
  full backend suite passed `70 passed in 13.25s`.
- Before restart, established 18020 connections and recording/processing
  meetings were both zero and `local.db` passed `PRAGMA quick_check=ok`.
  Canonical 18020 restarted from PID `268706` to PID `1760246`; canonical 18035
  remained PID `268705`. Both processes run from
  `/home/zhong/laoji-service-platform/smart-meeting-ai/backend`.
- Live smoke verified a matching token receives config with
  `purpose=schedule`, an empty end frame receives `ready_to_stop`, and a wrong
  token closes with code 1008. Direct file streaming recognized both
  `明天下午三点开会` and `今天缴费还款` on the schedule and unchanged meeting
  routes. The release-phone acoustic suite then passed all nine available
  normal, low-volume, male, slow, fast, paused, deadline, duplicate, and
  distinct-consecutive cases with normalized score 1.0.
- Post-deployment database checks found zero active meetings, zero
  `guest-session-*` meeting rows, zero matching transcript rows, and
  `quick_check=ok`. Logs since PID 1760246 started contain no traceback,
  critical, or error entry; both 18020 and 18035 health endpoints return OK.
- The owner-only post-deployment archive is
  `backups/20260712-schedule-realtime-pre/verified-source-post-schedule-realtime.tar.gz`
  with SHA-256
  `d59a8a0bdce067c6a7c19806d21ac70f2e9da392336af9be98cc87e161c08a72`.
- Rollback is source-only: restore `funasr_ws.py` and
  `streaming_pipeline.py` from the pre-change directory, remove
  `tests/test_schedule_realtime_ws.py`, restore the previous API contract, and
  restart only canonical 18020 after confirming it is idle. No database, media,
  collaborator workspace, shared Ollama setting, or system Nginx change needs
  rollback.

### Realtime ASR Lifecycle, Capacity, And Warm-up Policy - 2026-07-12
- A stricter concurrency probe first found that every idle realtime pipeline
  blocked one default-executor worker on `queue.Queue.get`. At the default pool
  size this could starve the ASR and punctuation work that needed the same
  executor. A separate 16-stream test then found 15 sessions received
  `ready_to_stop` without a transcript while their untracked model tasks kept
  running for roughly 10-12 seconds.
- `StreamingPipeline` now uses `asyncio.Queue`; worker callbacks deliver with
  `run_coroutine_threadsafe`, so an idle socket does not reserve a worker.
  Every ASR task is registered in a per-pipeline lifecycle set, and `stop()`
  waits for all previously launched and final-flush tasks before placing the
  queue sentinel. The meeting-only embedding thread is explicitly stopped and
  joined.
- Shared FunASR inference is protected by a loop-local async semaphore. The
  production default is 4 and can be overridden with
  `FUNASR_MAX_CONCURRENT_INFERENCE`. A controlled limit-8 trial made 16-stream
  median/max first-completion latency worse (11.235/14.071 seconds versus
  5.730/7.543 seconds at limit 4), so the trial was reverted rather than
  widening the acceptance threshold.
- Startup had also launched an unused WhisperLiveKit `large-v3` preload in the
  background. On the shared RTX 5090 it failed with CUDA OOM while the FunASR
  health endpoint still looked green and left the process RSS near 8 GiB.
  `MEETING_WHISPER_WARMUP_DEFAULT` is now false. Whisper remains available for
  explicit on-demand use, and setting `MEETING_WHISPER_WARMUP_ENABLED=1`
  restores the old preload behavior.
- Owner-only pre-change copies are under
  `backups/20260712-asr-thread-lifecycle-pre/`,
  `backups/20260712-asr-inference-lifecycle-pre/`, and
  `backups/20260712-whisper-warmup-policy-pre/`. The original pipeline SHA-256
  was `98061c4150c5fc351e090820c03a7d337e436f650c0356020a227e309de93ab7`;
  the pre-inference-lifecycle pipeline was
  `8677dd762c0438b746642b903a61d4ff61a0479e0dbad1162b593fc4b6468828`;
  the original `app/main.py` was
  `8f7fceac119668ba9ed18fa04369852b3d112207619aa3f990e5757e25dc5efd`.
- `py_compile` passed. Focused lifecycle/warm-up tests passed 11/11, and the
  full canonical backend suite passed 77/77 in 16.94 seconds. The new tests
  prove idle pipelines do not touch the executor, worker-thread transcript
  delivery works, stop waits for pre-existing ASR tasks, the global inference
  limit is enforced, meeting embedding threads are joined, and Whisper preload
  defaults off but remains explicitly enableable.
- Live capacity evidence: 32 authenticated idle sockets held for eight seconds
  with the process fixed at 156 threads; all received config/stop and all 32
  session deletions returned 204. The final supported 1/4/8 ladder ran two
  repetitions per level: 26/26 transcripts had normalized score 1.0, zero
  cross-session contamination, and cleanup 204. At eight streams, maximum
  first completion was 5.078 seconds and maximum stop acknowledgement was
  379 ms. Six additional meeting-route sessions all returned the expected text;
  after lazy pools reached 183 threads, all six post-session counts stayed 183.
  RSS grew 10.5 MiB across those six calls and remains an allocator/cache
  observation item rather than being claimed as zero growth.
- Canonical 18020 restart sequence for this change was
  `1760246 -> 1982495 -> 2011887 -> 2020983` (limit-8 trial), then
  `2028729 -> 2056927` after restoring limit 4 and disabling Whisper preload.
  Final PID 2056927 runs from the canonical backend. Its startup log contains
  the Whisper skip line, no preload start and no post-marker OOM; idle RSS was
  3663640 KiB and process GPU memory 2678 MiB. Cold schedule and meeting probes
  both returned `明天下午三点开会`, with first completion near 3.33 seconds
  and stop acknowledgement 23/90 ms.
- Final database `PRAGMA quick_check` is `ok`; active recording/processing
  meetings and established 18020 connections are zero. The change adds no
  schema or persistent business data. The owner-only verified post-change
  source archive is `backups/verified-source-post-asr-lifecycle.tar.gz`, size
  31384 bytes, SHA-256
  `2140eef99c02b9f55883c5518383ee8b0d8fe5c8280c30e1ac158c4e8bf5ef32`.
  A full rollback restores the pipeline
  and route test from `20260712-asr-thread-lifecycle-pre`, restores `app/main.py`
  from `20260712-whisper-warmup-policy-pre`, removes
  `tests/test_runtime_warmup_policy.py`, restores the prior API/runbook text,
  and restarts only canonical 18020 after verifying it is idle. No collaborator
  workspace, shared Ollama configuration, system Nginx file, or model file was
  modified or removed.

### Schedule Parsing Accuracy Guards - 2026-07-12
- Live inspection confirmed canonical ports 18035 and 18020 still run from
  `/home/zhong/laoji-service-platform/smart-meeting-ai/backend`; the App
  endpoints do not use the collaborator-owned 8035 process.
- `schedule_parser_service.py` now treats a final corrected date/time as
  authoritative, removes date/time leakage from model titles, clears an
  unparseable range's guessed `end_date`, and asks for the complete range.
  Exact deadline date-times no longer trigger a generic fuzzy-deadline prompt.
- Quick parsing now preserves `确认单` and similar nouns, removes complete
  `下月底`/command/meta-speech markers, repairs the ASR form `提前两时提醒` to
  `提前两小时提醒`, and parses explicit `下月/本月 N 号` independently of the
  current day-of-month. The same deterministic rules were mirrored in the App
  offline parser.
- The stricter diagnostic now flags temporal/meta title leakage and a mismatch
  between an explicit weekday and `start_date`. The final deterministic
  100-case, ten-group live sample had 0 hard issues; 11 category-hint and 5
  deliberately ambiguous-range rows remain review-only. Rules returned in
  roughly 30-100 ms. Model-warm total latency was min 30 ms, median 1331.5 ms,
  p95 1536 ms, p99 1671 ms, max 1800 ms.
- Parser-focused tests passed 28/28 and the full backend suite at that stage
  passed 87/87. Canonical 18035 was restarted only with zero established
  connections; final PID is `3055561` and its health endpoint is OK.
- Pre-change source is owner-only under
  `backups/20260712-schedule-quality-round1/`. The original parser SHA-256 was
  `93f270ff55497072aed4d99ac29ea2f3b2248d8c6dc0acb6d839bf1003a931df`;
  the deployed parser is
  `a57cf13b238f69301362e1d0a113f5091b7e22eeb4dfc46429f2d31747c9ec3e`.

### Compact App Meeting Summaries And Stricter Semantics - 2026-07-12
- The quality manifest grew from 7 to 19 core cases plus one 4410-Chinese-char
  long case. New coverage includes corrected owners/deadlines, cancelled work,
  first-person commitments, two independent actions, relative and recurring
  due dates, conditional proposals, disputes without consensus, idle chatter,
  external quoted intentions, duplicate statements, and deferred ownership.
- The first strict run exposed real failures: cancelled work became an action,
  `我明天下午发公告` was omitted, recurring due dates became `N/A` or a wrong
  calendar day, and a deferred owner was invented as an action. The prompt and
  deterministic API normalization now reject negated work, preserve recurring
  expressions, remove uncommitted placeholder actions, deduplicate corrections,
  and recover a strong final decision only when the model decision array is
  empty and the transcript contains an explicit final marker.
- Short App summaries now use `app_summary_generator.py` and
  `prompts/app_summary_system.txt`: only overview, key decisions, and action
  items are generated, with strict JSON output, 2048 context, and 768 maximum
  output tokens. The path is limited to 1000 input characters. Any exception or
  invalid output automatically falls back to the existing full CLI pipeline;
  longer transcripts continue using the existing Map-Reduce implementation.
- Public guest-summary verification passed 19/19. With the model already at the
  shared 2048 context, latency was min 1009 ms, median 1377 ms, max 2854 ms,
  total 27996 ms. A cold compact call measured 6.2-7.7 seconds. The prior full
  pipeline's 7 original cases took 35679 ms total with 4422 ms median; the same
  7 cases in the final compact run took 11984 ms total with 1486 ms median.
- The long case bypassed the compact path, logs showed 10 speaker-turn chunks,
  and it passed in 33209 ms. A known remaining performance boundary is the
  first complex schedule parse after an 8192-context long summary: the model
  must return to 2048 context and the measured call took 7.17 seconds. The
  normal schedule-to-short-summary 2048-context transition passed in 1.84
  seconds. This residual switch cost is not reported as solved.
- Final verification passed the full backend suite 99/99 and the maintained
  meetingsummary client/main/chunker suites 32/32. Canonical 18020 was restarted
  only after zero established connections; final PID is `3225009`, all five
  model health flags are true, and no collaborator workspace, shared Ollama
  daemon configuration, system Nginx file, schema, or persistent test meeting
  was modified.
- Final `schedule.db` and `local.db` `PRAGMA quick_check` results are `ok`, and
  `local.db` contains zero `quality-%` meetings. Logs from final PIDs 3055561
  and 3225009 contain no traceback, critical, exception, or error entry.
- Pre-change summary source is owner-only under
  `backups/20260712-summary-quality-round2/`. The final owner-only source archive
  is `backups/verified-source-post-quality-20260712.tar.gz`, size 34525 bytes,
  SHA-256
  `23e32f0b99572706bdb5ef3306297f4f847667bc14864e0d0bb2b8183ac5db57`.
  Before/after reports and manifest v2 are under
  `docs/evidence/quality-20260712/`.
- Rollback restores the parser/test from the schedule backup, restores
  `summary_tasks.py`, `summary_system.txt`, `ollama_client.py`, and their tests
  from the summary backup, removes `app_summary_generator.py`,
  `app_summary_system.txt`, and `test_compact_summary_generator.py`, then
  restarts only canonical 18035 and 18020 after confirming they are idle. No
  database rollback is required.

### Shared 8192 Runner And Finite Daily Ranges - 2026-07-12
- `schedule_parser_service.py` and `app_summary_generator.py` now default to
  `num_ctx=8192`, matching the existing full summary path. This keeps one
  `qwen3:8b` runner configuration across schedule parsing, compact summaries,
  and Map-Reduce summaries. Per-process environment overrides remain bounded
  and available for controlled diagnostics.
- The choice is evidence-driven. At 2048, the 122-line long case took 91984 ms,
  lost 5/10 map chunks to invalid JSON, and emitted an incompatible final
  schema. At 4096, all 10 chunks survived and the required decision/action were
  present, but total time regressed to 101340 ms. Neither experimental setting
  became the deployed default.
- On the deployed 8192 path, the strict compact suite passed 19/19 with min 841
  ms, median 1218 ms, and a cold first-case/max of 5540 ms. The long case passed
  in 24752 ms. Its immediately following complex schedule request returned the
  correct date, time, location, category, and 30-minute reminder in 1732 ms;
  the previous measured 7.17-second runner switch is therefore removed.
- A deterministic 100-case schedule rerun had zero hard issues. It contained
  62 model, 29 rule, and 9 rejected control rows. Overall p95/p99/max were
  1730/1930/1956 ms; model-only p95/max were 1802/1956 ms. The small tail-latency
  increase versus 2048 is accepted because it remains below two seconds in
  this run and removes a repeatable multi-second cross-feature reload.
- The live joint test exposed and then fixed a separate quick-rule defect.
  `下周一到下周三...每天` no longer resets the start to today or creates an
  unbounded daily series; it becomes a finite once/spanning event from
  2026-07-13 through 2026-07-15. `从下周一开始每天...` remains daily, starts
  on 2026-07-13, strips the residual `从开始` title text, and maps `复习` to
  `学习`. The App offline parser mirrors these semantics.
- Full backend verification passed 101/101 and maintained meetingsummary
  client/main/chunker suites passed 32/32. Canonical 18035 is PID `3415684`;
  canonical 18020 is PID `3384568`; both health endpoints are OK. No schema,
  persistent meeting/event data, collaborator service, model file, shared
  Ollama daemon configuration, or Nginx configuration changed.
- Deployed hashes are parser
  `4a8d917f10232dd58f95c899deb4970fbb7a8769cc2925028d2c68883e864f7a`
  and compact generator
  `b4c12f9798cbee5c3b7e95dc465ae387a46809602a13c61bd887c522b890577d`.
  Owner-only pre-change copies are under
  `backups/20260712-context-unification-round3/`; their hashes are parser
  `a57cf13b238f69301362e1d0a113f5091b7e22eeb4dfc46429f2d31747c9ec3e`
  and compact generator
  `30bf893f2641dc9d69640c58970269634098ea8d2d98a9b5e8823533e6bf39e4`.
- Rollback restores the two services and two tests from that backup and
  restarts canonical 18035/18020 when idle. No database rollback is required.
- The owner-only post-change source archive is
  `backups/verified-source-post-context-unification-20260712.tar.gz`, size
  58096 bytes, SHA-256
  `49957cbce0e4f192680d9e6d4a26fa64560acdb204d7ffe3aa3c311742b0fc63`.

### Semantic Split Execution, Bounded Map Output, And Long-Input Guards - 2026-07-12
- Production inspection found that the semantic path was not merely low
  quality: `chunker.py` imported the sibling module as a top-level package,
  raised `attempted relative import with no known parent package`, and silently
  used speaker turns. Running the complete meetingsummary test tree also found
  six collection errors from the same import style and four missing fixtures;
  the previously reported 32-test subset was insufficient evidence.
- `meetingsummary/chunker.py` now uses package-relative imports and anchors its
  prompt path to the module. `json_parser.py` accepts object or array roots and
  scans raw JSON starts, allowing fenced arrays. `semantic_splitter.py` sends
  an Ollama top-level array JSON Schema, requests roughly one segment per 60
  sentences within a 3-10 bound, caps output at 768 tokens, and repairs model
  numbering to contiguous complete coverage before validating. External model
  providers do not receive the Ollama-specific schema.
- `map_reduce.py` and `map_extract_system.txt` use a structured fact schema,
  cap each chunk at 768 output tokens and eight prioritized facts, and direct
  the model toward decisions, actions, deadlines, and numbers. A controlled
  A/B on one 60-line chunk reduced 18668 ms/2048 generated tokens/5271 response
  characters to 5535 ms/768 generated tokens/1980 characters before applying
  the final eight-fact prompt.
- `backend/app/workers/summary_tasks.py` adds long-input-only source grounding.
  Explicit strong decisions and assigned actions can be recovered from the
  original transcript, model/source actions are deduplicated, and explicit
  no-outcome meetings clear hallucinated decisions and actions. These guards
  do not run on compact input. The original short-path strong-decision fallback
  was retained after a deliberate regression run exposed the boundary.
- The strict evidence sequence is preserved rather than replacing failures:
  the first five long cases passed `1/5` at median 37477 ms and max 65970 ms;
  an intermediate short regression passed only `12/19`; the final short suite
  passes `19/19` at median 1522 ms (cold max 7600 ms, warm max 2329 ms), and the
  final five long cases pass `5/5` at median 10912 ms and max 24553 ms. The long
  cases cover key information at the start/end, a middle correction, explicit
  no-outcome discussion, and three independent topics with three decisions and
  actions. Final runtime logs show 3, 3, 3, 3, and 4 semantic segments with no
  failed map chunk.
- Complete verification now passes backend `106/106` and meetingsummary
  `228/228`, including collection. Canonical port 18020 was restarted from the
  canonical workspace and is PID `4180023`; canonical 18035 remains PID
  `3415684`. Final process, database, connection, and log checks are recorded
  in `docs/evidence/quality-20260712/semantic-summary-round4.json` and the
  accompanying reports.
- Changed source surfaces are `meetingsummary/chunker.py`, `json_parser.py`,
  `semantic_splitter.py`, `map_reduce.py`, `prompts/map_extract_system.txt`,
  their complete test tree/fixtures, `backend/app/workers/summary_tasks.py`, and
  `backend/tests/test_summary_task_parsing.py`. There is no API/schema/database
  contract change. No collaborator workspace, shared Ollama daemon/model file,
  system Nginx configuration, or persistent meeting row was modified.
- Owner-only pre-change copies are under
  `backups/20260712-semantic-split-import-round4/`. Rollback restores those
  files, removes only the four newly introduced fixtures if required, and
  restarts canonical 18020 after zero established connections. No database
  restore is needed. The owner-only post-change archive is
  `backups/verified-source-post-semantic-round4-20260712.tar.gz`, size 145201
  bytes, mode `600`, SHA-256
  `d8480640c3d3cdab5badf8786549012ec89311a43c99e34c8ee6413d1783d1d0`.

### Live Two-Account Cross-Service Isolation Audit - 2026-07-13
- A client-side black-box audit created two one-time accounts on canonical
  18035 and used their Bearer sessions against canonical 18035/18020. It
  exercised unauthenticated rejection, per-user event and meeting lists,
  cross-user event update/delete, cross-user transcript read and meeting
  update/delete, per-user idempotency keys, account-deletion cascades, and old
  token rejection by both services.
- The first run reported 30/32 because the audit sent different payloads with
  a reused key while expecting the original object. Read-only inspection of
  `schedule_db_service.py` and `app_meetings.py` confirmed the deployed
  contract: same key plus identical payload returns the original row, while a
  changed payload returns 409. The audit was corrected to test both branches;
  no backend source or runtime configuration was changed.
- The corrected run passed 34/34. Each account deletion returned one event,
  one meeting, and one session deleted with `cleanup_pending=0`; old tokens
  returned 401 from auth/events and meetings. A subsequent read-only scan of
  active `data/schedule.db` and `local.db` found zero rows containing the run
  identifier or the audit title prefix.
- The first public-network report was routed through the operator workstation's
  `127.0.0.1:7897` HTTP/ALL proxy. Twelve health requests took 0.55-3.80 seconds
  through that proxy, 33-87 ms with forced public direct routing, and 1.6-2.2
  ms on server loopback. Its 888/2859/4002 ms median/p95/max are therefore not
  backend performance evidence.
- The audit client now bypasses environment proxies by default and only opts in
  with an explicit flag. The corrected public-direct and server-loopback runs
  both passed 34/34. Their total durations were 3326/1289 ms, medians 58.2/14.6
  ms, and p95 values 613.7/341.1 ms; registration password hashing and
  cross-database deletion dominated the high end.
- The sanitized public-direct report has SHA-256
  `d36cef2e8ef3d50bf2b1b6a22f357bfa760cb15aa713a4cd530f93cad0341c29`;
  the loopback report has SHA-256
  `9947871d363425da54f19393b2ff8c92cf0d3019f0169ea019dfcbbf0c00fc21`.
  Both contain statuses, timings, deletion counts, and irreversible subject
  hashes only; neither contains passwords or tokens. Public-source scripts do
  not embed the live service address.
- This record is the only server file change. No API, source, service process,
  schema, persistent business row, collaborator workspace, shared Ollama, or
  system Nginx setting changed. Temporary rows were removed through the normal
  account deletion API, so no service or database rollback is required.

### Schedule Parser Noise and Date-Range Hardening - 2026-07-13
- Maintenance scope was limited to the canonical workspace files
  `backend/app/services/schedule_parser_service.py` and
  `backend/tests/test_schedule_parser_quality.py`. The deployed API shape,
  database schema, authentication boundary, shared Ollama installation, system
  Nginx configuration, and collaborator workspaces were not changed.
- Filler-fragmented spoken corrections such as `不呃是`, filler-interrupted
  `不对`, `说错`, and `改成` now route through the model-aware correction path
  instead of being accepted as a confident same-day rule result. The original
  failure `整理发票不呃是今天，是下周二下午四点半` now resolves to 2026-07-21
  at 16:30 with a clean title.
- Temporal filler normalization is context-only. It repairs damaged ranges such
  as `7月21号到然后下周日`, `从7月18日始到8月5号`, `8月2号到8月嗯5号`,
  `本月25号到可能8月5号`, and `从下周一到8，别忘了，月5号` without globally
  deleting uncertainty words from titles or locations.
- When deterministic normalization recovers a valid date range, stale
  model-generated range questions are removed. Reversed or unresolved ranges
  still keep a conflict question. A location introduced by uncertainty wording,
  for example `地点可能在东门`, retains the parsed location and deterministically
  requests confirmation rather than silently treating it as certain.
- The first 1000-case noisy review run found one hard field error. The identical
  post-fix run passed 1000/1000 hard checks in 702595 ms, with median 4030 ms,
  p95 4475 ms, p99 4660 ms, and max 5343 ms. The 39-case date-range review
  subset then passed 39/39 hard checks and reduced range review flags from 39
  to 33; the remaining flags are reversed, same-day, or still-damaged ranges
  that correctly require clarification.
- Final verification passed 25/25 targeted parser tests and the complete backend
  suite 110/110. Live black-box checks covered valid noisy ranges, uncertain
  location, reversed range, and filler correction. Canonical 18035 was restarted
  only after zero established connections and is PID `1493687`; canonical 18020
  remains PID `4180023`. Both health checks pass from their canonical working
  directories.
- Final SHA-256 is
  `8893a1e08ac7e47b15d9237ac063318ee40da61d76e675afad63bc371bef418f`
  for `schedule_parser_service.py` and
  `ae6981acf4bcb9380b574af5c5775462b2ea2e9cfaa518c3cdac130d656f1f20`
  for `test_schedule_parser_quality.py`.
- Owner-local rollback copies are the `.bak-20260713-asr-filler-correction`,
  `.bak-20260713-asr-date-range-fillers`,
  `.bak-20260713-range-question-cleanup`, and
  `.bak-20260713-uncertain-location` chains beside the changed files. A full
  rollback restores the first pair, or an intermediate rollback restores the
  correspondingly named pair, then restarts canonical 18035 after confirming
  zero established connections. No database restore is needed.
- These parse and guest-ASR quality runs created no persistent schedule or
  meeting rows. All realtime ASR guest sessions were explicitly deleted and
  returned 204; meeting-summary guest tasks were memory-only. No persistent
  data cleanup remains.

### Schedule Realtime ASR VAD Pre-Roll - 2026-07-13
- Maintenance scope was limited to canonical workspace files
  `backend/app/asr/streaming_pipeline.py`, `backend/app/api/funasr_ws.py`, and
  the new regression test `backend/tests/test_streaming_vad_preroll.py`. The
  change is acoustic-content agnostic: it does not contain a repair rule for
  any Chinese character, word, date, or example phrase.
- `StreamingVAD` now supports a bounded PCM pre-roll while idle and retains the
  configured leading audio when speech starts. The schedule realtime route
  enables 400 ms so weak initial phonemes are not discarded before VAD crosses
  its speech threshold; the meeting realtime route remains at 0 ms to preserve
  its prior segmentation behavior. Silence-triggered segment boundaries also
  retain only the configured tail for the next utterance.
- Final verification passed 12/12 targeted VAD/route tests and the complete
  backend suite 113/113. After restart, a direct live schedule WebSocket probe
  returned the exact fixture transcript `明天下午三点开会`; the first segment
  start moved from approximately 0.48 seconds to 0.08 seconds, matching the
  intended 400 ms generic leading-audio preservation. The temporary guest ASR
  session was deleted through the API and returned 204.
- Canonical 18020 was restarted only after confirming zero established client
  connections. It is PID `3024714`, runs from the canonical workspace, reports
  all ASR models ready, and logs `pre-roll=400ms` for the schedule route.
  Canonical 18035 remains PID `1493687` and was not restarted.
- Final SHA-256 is
  `ddded7368c51833c73fba9f5257a77ea0f6ce9e83e7be5008e3d9e9d9db10803`
  for `streaming_pipeline.py`,
  `cbed70883f857dfadfcb39b432eb854d4bb20ca1e70fcd8f6f4d87144fafe3a3`
  for `funasr_ws.py`, and
  `a754e5e62c3c929a61bc9f5d49a790a1e6628b663f244a40475b3ee0faa9e7d0`
  for `test_streaming_vad_preroll.py`.
- Owner-local rollback copies are
  `streaming_pipeline.py.bak-20260713-schedule-vad-preroll` and
  `funasr_ws.py.bak-20260713-schedule-vad-preroll` beside the changed files.
  Rollback restores both files, removes the new regression test if required,
  and restarts canonical 18020 after confirming zero established connections.
  No database restore is needed.
- There is no API contract, database schema, authentication, model, or
  persistent business-data change. No collaborator workspace, shared Ollama
  installation/model file, system Nginx configuration, or other service was
  modified.

### Meeting First-Transcript Latency - 2026-07-13
- Maintenance scope was limited to canonical workspace files
  `backend/app/asr/streaming_pipeline.py`, `backend/app/api/funasr_ws.py`,
  `backend/tests/test_streaming_vad_preroll.py`, and
  `backend/tests/test_schedule_realtime_ws.py`. The realtime meeting route now
  uses a 480 ms end-of-utterance silence threshold instead of the shared 800 ms
  default. The schedule route explicitly remains at 800 ms, so this change does
  not alter schedule segmentation or its 400 ms pre-roll.
- Three identical public-direct meeting probes before the change received the
  first completed transcript 699/699/718 ms after the fixture stream ended.
  Three probes after restart measured 518/271/159 ms; median latency fell from
  699 ms to 271 ms. The first post-restart result includes cold speaker/ASR
  work, while subsequent warm results remained below 300 ms.
- A four-utterance meeting probe with 700 ms gaps returned four separate,
  correct transcripts in order. A schedule-route regression probe returned the
  exact expected transcript. Every temporary guest realtime session was
  revoked through the API and returned 204.
- Final verification passed 14/14 targeted route/VAD tests and the complete
  backend suite 115/115. Canonical 18020 was restarted only after zero
  established connections and is PID `3239185`; it runs from the canonical
  workspace and reports healthy. Canonical 18035 was not restarted. Both
  active SQLite databases returned `PRAGMA quick_check=ok`.
- Final SHA-256 is
  `1b1dd3abe46f1ae68f52b0c1a45587d9ccab99aae400a557fd61bf5d92fa16e5`
  for `streaming_pipeline.py`,
  `c41c3a4e2dd5fecc8a9d12d4367395377a02ce653ca376f885de9c6137fcf72d`
  for `funasr_ws.py`,
  `2b444a323c543de84137a38119151d837b31c7b4f4e7630a526bffec98e34db6`
  for `test_streaming_vad_preroll.py`, and
  `7b843fbcf3048c608e89b4d8a7168d0f2e4ef32801e86049191863674117e783`
  for `test_schedule_realtime_ws.py`.
- Owner-local rollback copies use the suffix
  `.bak-20260713-meeting-first-result-latency` beside all four changed files.
  Rollback restores those copies and restarts canonical 18020 after confirming
  zero established connections. No database restore is needed.
- There is no API schema, authentication, persistence, model, or business-data
  change. No collaborator workspace, shared Ollama installation/model file,
  system Nginx configuration, or other service was modified.

### Meeting Summary Latency and Outcome Consistency - 2026-07-13
- Maintenance scope was limited to the canonical workspace files
  `backend/app/services/app_summary_generator.py`,
  `backend/app/workers/summary_tasks.py`,
  `backend/tests/test_compact_summary_generator.py`,
  `backend/tests/test_summary_task_parsing.py`, and
  `meetingsummary/prompts/app_summary_system.txt`. The compact single-pass
  threshold is now 6000 characters, with a 12000-character configuration cap,
  and the default compact output budget is 512 tokens. Transcripts beyond that
  boundary continue to use the existing long-summary pipeline.
- The summary prompt and deterministic post-processing now keep `overview`,
  `key_decisions`, and `action_items` mutually consistent; preserve explicit
  final outcomes in long noisy transcripts; reject superseded, negated, and
  conditional proposals; normalize corrected assignees and one-time/recurring
  deadlines; and remove duplicate decision/action representations. These are
  generic source-grounded rules and do not special-case a test phrase.
- Verification passed 35/35 targeted summary tests and the complete canonical
  backend suite 130/130 with CUDA enabled. The stricter public guest-summary
  quality runs passed 24/24 original cases and 20/20 long adversarial cases.
  The warm original run measured min/median/max 692/1303/3209 ms; the long
  3000-3651 character run measured 1323/1942/3000 ms. Four concurrent tasks
  passed 4/4 without result crossover and completed in 2998-7232 ms.
- The same 24-case pre-change live baseline took 104655 ms total with a 23549
  ms maximum. The deployed warm run took 33277 ms total with a 3209 ms maximum.
  A natural cold-model first request took 7396 ms, so cold start remains a
  separate latency cost and was not hidden by pinning the model in shared GPU
  memory. During the original-plus-adversarial live run, 290 GPU samples showed
  38.2 percent average and 88 percent peak utilization, 31936 MiB peak memory,
  and 443.61 W peak power. Shared Ollama reports `qwen3:8b`, 8192 context, and
  100 percent GPU placement.
- Canonical 18020 was restarted only after zero established connections. It is
  PID `4020051`, runs from the canonical workspace, reports all realtime models
  ready, and serves both health endpoints. Both active SQLite databases return
  `PRAGMA quick_check=ok`; guest-summary quality tasks are memory-only and did
  not create persistent meeting or schedule rows.
- Final SHA-256 is
  `dd4bea50c9f570496fed25a48c44f360c813722b1109e95c91399fc359818d5f`
  for `app_summary_generator.py`,
  `be0830f9b2228bea2ecd853e76cb9ac6239cd191d5ee6f71d0c46c3873843746`
  for `summary_tasks.py`,
  `80a892d3cc5e4ce24cda34c15044af6c950b1a6ba40e529b2878ef1c35e958c7`
  for `test_compact_summary_generator.py`,
  `9deaea1f887eb30c98ae5fbff9d13d14b5d3b30e1b284067d1f54a70d616088f`
  for `test_summary_task_parsing.py`, and
  `e9b7fb79c6b9f288b78ffa803c3e824538f282cc5c97f91c025e47ac6397b2ef`
  for `app_summary_system.txt`.
- Owner-local rollback copies use the suffix
  `.bak-20260713-summary-latency-quality` beside all five changed files.
  Rollback restores those copies and restarts canonical 18020 only after
  confirming zero established connections. No database restore is needed.
- There is no API/schema, authentication, model-file, or persistent-data
  contract change. No collaborator workspace, shared Ollama installation,
  system Nginx configuration, canonical 18035 process, or other service was
  modified.

### User-Isolated App Speaker Voiceprints - 2026-07-13
- Maintenance scope was limited to the canonical workspace's meeting backend.
  It adds `backend/app/api/app_speakers.py`, updates the API router, WebSocket
  authorization context, all five meeting realtime provider paths, the shared
  speaker database service, authenticated account deletion, and focused
  regression tests. Collaborator workspaces, shared Ollama/model files, system
  Nginx, and unrelated services were not modified.
- The App contract is authenticated `GET/POST /api/laoji/speakers`,
  `POST /api/laoji/speakers/{speaker_id}/samples`, and
  `PATCH/DELETE /api/laoji/speakers/{speaker_id}`. Registration and supplemental
  samples accept multipart WAV audio, enforce a 10 MiB boundary, 2-15 second
  duration, non-silent/non-clipped input, and strict CAM++ extraction. A model
  failure now returns 503 for the App route; it never writes a fabricated
  random voiceprint.
- `speaker_profiles` gained nullable `owner_user_id` and the
  `(owner_user_id, is_active)` index. Existing prototype rows remain NULL and
  continue through `/api/speakers`; App rows are generated with an unguessable
  user-prefixed ID and every list, rename, supplement, delete, and realtime
  load checks the authenticated owner. Legacy list/search/stats/update/delete
  paths explicitly exclude App-owned rows.
- Meeting WebSocket authorization now retains `prototype`, `guest`, or `user`
  scope. The base, FunASR, Whisper, Qwen, and Hybrid paths load legacy global
  voiceprints only for prototype meetings, zero personal voiceprints for guest
  sessions, and only the current owner's voiceprints for authenticated App
  meetings. Account deletion physically removes the user's profile, embedding,
  and identification-log rows before deleting the auth account.
- An isolated migration of the production voiceprint database passed
  `PRAGMA quick_check=ok`, retained all 6 legacy profiles, exposed all 6 to the
  prototype scope, and exposed zero to an unrelated App owner. The canonical
  migration then produced the same result. After live smoke cleanup the
  canonical database reports 6 legacy rows, zero App-private rows, and zero
  orphan embeddings.
- Verification passed 10 focused speaker/auth tests and the complete canonical
  backend suite 136/136. A live two-account smoke created one synthetic protocol
  sample per account: each account listed only its own profile, a cross-account
  rename returned 404, unauthenticated App listing returned 401, and the legacy
  endpoint still listed exactly 6 profiles. Both temporary accounts were
  deleted, and a guest FunASR socket completed with log evidence
  `scope=guest, registered voiceprints=0`.
- Canonical 18020 is PID `242710`, canonical 18035 is PID `264019`, both run
  from `/home/zhong/laoji-service-platform/smart-meeting-ai/backend`. The 18020
  detailed health endpoint reports all five realtime models present and ready;
  18035 reports healthy. The workspace symlink still resolves to
  `/home/zhong/laoji-service-platform`.
- Core SHA-256 values are
  `b565d4eedd99da1d8121290ff17dbded0f8cce9454326242806fee95e706d870`
  for `app_speakers.py`,
  `adbe8b6a84ba987e530db70718088b0bec6b163d085181f04a563a32a15eb57c`
  for `speaker_db_service.py`,
  `a20400777f8c3f3e877368f1ccfa6308a0c46a563860e8e808e57f8c0eb3a49c`
  for `ws_auth.py`,
  `4313157e1e0224994ea798af3998adb2e8077d76d28c19a7a3b694b2f7bdf3e4`
  for `funasr_ws.py`, and
  `d7d48155f0ce5223ce90d2c753fbb0cef0dc2e0d7570aaa131d8bd2bbcc867c4`
  for `account_deletion_service.py`.
- Owner-local code backups use suffix
  `.bak-20260713-user-speaker-isolation`; the pre-migration SQLite copy is
  `app/data/speaker_voiceprints.db.bak-20260713-user-speaker-isolation`.
  A full old-code rollback is safe only while the count of non-NULL
  `owner_user_id` rows is zero, in which case restore both code and that database
  copy before restarting 18020 and 18035. Once real App voiceprints exist, do
  not restore the old global loader because it lacks the privacy boundary;
  retain the isolated database service/WebSocket authorization or migrate the
  private rows to a separate protected store first.

### Schedule Location and Action Separation - 2026-07-13
- Maintenance scope was limited to the canonical workspace files
  `backend/app/services/schedule_parser_service.py` and
  `backend/tests/test_schedule_parser_quality.py`. The quick parser now
  separates a recognized location immediately followed by an action, so the
  location remains in `location` while the action becomes the event `title`.
  This covers room identifiers such as A301, complete known place names such
  as a gym or home, and prefixed place names such as a city library.
- The change is generic: it requires an explicit location marker, a bounded
  recognized place token or room identifier, an optional localizer such as
  `inside` or `nearby`, and an adjacent action verb when more text follows.
  The old fallback that consumed everything from the word `at` to sentence end
  was removed. Negative tests confirm that company-chat and family-member
  phrases are not treated as physical locations. The travel classifier also
  recognizes an explicit departure action. Existing date, time,
  model-fallback, and API contracts are unchanged.
- Verification passed 36/36 focused parser tests and the complete isolated
  backend suite 147/147, then passed the complete canonical suite 147/147.
  After deployment, eight live `/api/laoji/parse` requests returned the expected
  title/location/category tuples through `parse_source=rules`. They cover room
  identifiers, complete and prefixed place names, nearby-localizer handling,
  an explicit location field, and both non-location conversation-context
  negatives.
- Canonical 18035 was restarted as PID `723272`, runs from
  `/home/zhong/laoji-service-platform/smart-meeting-ai/backend`, and reports
  `status=ok`, `service=laoji`. Final SHA-256 is
  `8f0fcd7c14ef36649a6f053a81ab87a7f12f2368c2a43a7bc5041f886f891430`
  for `schedule_parser_service.py` and
  `ff7a2aff72a8ccfd97f90d83df35d1c1d3bfe2a71ad3516ce687a0b1d704582a`
  for `test_schedule_parser_quality.py`.
- Owner-local rollback copies use suffix
  `.bak-20260713-location-title-split` beside both changed files and this
  review document. Rollback restores the parser and test copies, reruns the
  backend suite, and restarts canonical 18035. No database restore is needed.
- There is no API/schema, authentication, model-file, database, or persistent
  data change. No collaborator workspace, shared Ollama installation, meeting
  service, system Nginx configuration, or unrelated process was modified.

### Summary Task Reuse and Ownership Recovery - 2026-07-13
- Maintenance scope is limited to the canonical workspace summary worker,
  App-meeting routes, focused lifecycle tests, and the workspace operations
  launcher. Collaborator directories and ports, shared system Ollama, system
  Nginx, model files, and persistent meeting data were not modified.
- Summary requests now use a canonical payload fingerprint. Concurrent or
  repeated equivalent requests reuse one in-flight task and successful tasks
  remain reusable for five minutes; `force=true` creates a new task and failed
  tasks are never reused. A lock protects the in-process task and deduplication
  registries.
- Every task records its meeting, user scope, task kind, and deduplication key.
  Authenticated status lookup requires the exact current user and meeting
  binding. The former unscoped Celery-result fallback was removed, so another
  account cannot probe a known task identifier through an owned meeting.
- The complete canonical backend suite passed 151/151 before deployment. A
  public black-box audit after the 2026-07-13 reboot passed 14/14 checks in
  7072 ms: duplicate guest submissions returned the same task with
  `reused=false` then `reused=true`, cross-scope authenticated lookup returned
  404, the task reached SUCCESS, and the temporary account was deleted.
- The reboot also demonstrated that these user-owned services do not restart
  automatically (`loginctl` reports `Linger=no`). `scripts/start-ours.sh` is
  now the idempotent recovery entry point: it refuses foreign listeners, starts
  only workspace ports 21434/18020/18035, waits through ASR model warm-up,
  records PIDs, and rolls back processes from a failed partial invocation. No
  system-level autostart was installed because server changes are restricted to
  this workspace.
- `scripts/health-check.sh` now fails closed instead of swallowing curl errors.
  It verifies listener ownership, the workspace `qwen3:8b` manifest, all five
  realtime models, and the LaoJi service identity. The healthy runtime passed
  all six checks; an injected unreachable URL produced one explicit failure
  and exit code 1 without disturbing the running services.
- Final SHA-256 values are
  `b504da7c3938163e5c5c09e5420cc5d2be5e18320e195b8133201f4205c25057`
  for `app/workers/summary_tasks.py`,
  `347b5777aecc97dd61ccd92c5b2ceaef6a92e1706fc6efa1d0402c75e99bde1d`
  for `app/api/app_meetings.py`, and
  `4de8f63f885d6da60a54438ca0c19dd29626d239768a765b9826501ea7a9e089`
  for `tests/test_summary_task_lifecycle.py`, and
  `e31607553ceba56a55e2eab3eceb3ce2052054abbbf11c4a1bb13ba5e49e8fe9`
  for `scripts/start-ours.sh`, and
  `7a9869e5212a27dd926de1dd7f5bfd79d243ffb260b2575bd757f7dd854ea561`
  for `scripts/health-check.sh`.
- Pre-change source copies are under
  `/home/zhong/laoji-service-platform/backups/20260713-summary-task-recovery-security`.
  Restore the two source `.before` files and `health-check.sh.before`, remove
  the lifecycle test if rolling back the feature, rerun the backend suite, and
  restart only port 18020 after
  confirming zero active meeting connections. Removing `start-ours.sh` only
  removes the unified recovery command and has no effect on running processes.

### Qwen3-ASR-Only Backend - 2026-07-15
- Schedule realtime input, meeting realtime input, and short-audio transcription
  now use Qwen3-ASR-1.7B. Public App WebSockets end in `/qwen`, successful
  messages report `source=qwen3-asr`, and the removed realtime/hybrid/provider
  routes are not mounted. Whisper remains an independent experiment, not an App
  fallback.
- Removed the retired ASR package, unused ModelScope packages, ASR/punctuation
  model directories, old routes and pipelines, dependency/config entries,
  frontend controls, tools, current documentation, caches, side-by-side backups,
  and ASR-specific rollback archives. The standalone CAM++ speaker network keeps
  its MIT source attribution; it has no runtime dependency on the retired ASR.
- Concurrent schedule and meeting sockets initially reproduced native memory
  corruption because one stateful Silero TorchScript instance was shared across
  worker threads. Each socket now receives a separately loaded/reset VAD model,
  and CAM++ executes only at completed segment boundaries under one inference
  lock. Four realtime sockets plus two file requests pass 6/6 without process
  loss or transcript contamination.
- Canonical backend tests pass 211/211. The prototype frontend TypeScript/Vite
  build passes. Mobile TypeScript and all 76 suites / 582 tests pass. Final live
  concurrent probes return `明天下午三点开会。`; Qwen3-ASR, `18020`, and `18035`
  health checks are green at PIDs `784824`, `827524`, and `2565598`.
- Qwen3-ASR uses 5,124 MiB GPU plus a 588 MiB idle VAD/CAM++ backend footprint;
  the six-request sample peaked near 9/4 percent GPU compute and 282/143 percent
  CPU respectively. A forced-fresh MS001 summary passed in 1,748 ms on the
  dedicated `qwen3:8b` runner, which uses 6,636 MiB GPU and sampled at 63 percent
  GPU compute, 48 percent memory-controller use, 223 percent CPU, and 2.6 GiB
  RSS. Other users' GPU processes are excluded.
- Both summary and schedule model variables explicitly use `qwen3:8b`; there is
  no hybrid model variable. No schema or persistent-data migration was needed:
  the meeting database has zero legacy hybrid rows.
- No old-provider rollback is retained by decision. Recovery is limited to the
  Qwen-only revision and documented Qwen3-ASR environment. No collaborator
  workspace, shared Ollama install, unrelated process, or user data was changed.

### Qwen3.5-9B Schedule And Summary Cutover - 2026-07-15
- The canonical schedule parser and meeting-summary worker now select
  `qwen3.5:9b`. Running processes expose both
  `SCHEDULE_OLLAMA_MODEL=qwen3.5:9b` and
  `MEETING_SUMMARY_MODEL=qwen3.5:9b`; their source defaults, config, tests,
  launchers, health checks, and active documentation match. Qwen3-ASR-1.7B is
  unchanged and remains the separate speech-to-text model.
- The workspace model is Qwen35-family GGUF, 9.7B, Q4_K_M, digest
  `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`.
  It occupies 6,594,474,711 bytes on disk and each 8192-context Ollama runner
  reports 8,884,036,224 bytes of model VRAM. After live validation, both old
  `qwen3:8b` runners were unloaded and that workspace tag was deleted. The
  installed but inactive `qwen3:32b` artifact was left intact.
- Date-range inference now checks connector position between adjacent date
  tokens. This prevents `下午两点到四点` from making correction text such as
  `不是周四，是下周五...` look like an unresolved date range. Its regression
  test expects 2026-07-24, 14:00-16:00, and no clarification.
- The complete backend suite passes 212/212 and the meeting-summary package
  passes 230/230. Live `POST /api/laoji/parse` returned the expected corrected
  date/time/category in 1.462 seconds through `parse_source=local_llm`. A
  forced guest summary completed in 2.535 seconds with the expected decisions,
  assignees, and two absolute deadlines. The canonical health check is green
  after restarting only owned backends `18020` and `18035` as PIDs `1530036`
  and `1530277`.
- With old 8B runners removed, GPU 0 has 9,937 MiB free and GPU 1 has 18,425 MiB
  free at idle; these totals include unrelated users. Each LaoJi qwen3.5 runner
  accounts for about 8,530 MiB in `nvidia-smi`. No persistent schema or user
  data changed, and no collaborator directory, unrelated process, or shared
  executable was modified.
- There is intentionally no automatic 8B fallback. Recovery re-pulls
  `qwen3.5:9b` into the workspace model directory, runs
  `scripts/start-ours.sh`, and verifies `scripts/health-check.sh`. Code rollback
  requires restoring the recorded source/config revision, rerunning both test
  suites, checking active connections, and restarting only workspace-owned
  backends.

### LaoJi Guest Data Migration, Meeting Location, And Brief Summary Guard - 2026-07-21
- Scope is limited to the canonical App meeting model/schema helper, App meeting
  routes, final-summary worker, and this collaboration record. Qwen3-ASR,
  speaker embeddings and thresholds, schedule parsing, model files,
  collaborator workspaces, and unrelated listeners were not modified.
- App meetings now expose nullable `location` and `recorded_at`. The additive
  SQLite compatibility helper creates both columns idempotently; list ordering
  and summary date context use `recorded_at` when present while retaining
  `created_at` as the server creation audit time.
- Authenticated clients can call
  `POST /api/laoji/meetings/{meeting_id}/imports/guest` to import locally saved
  transcripts and a final summary without re-running ASR. UUIDv5 identifiers
  derived from user, guest meeting and source row make retries idempotent, and
  normal meeting ownership checks prevent cross-account imports.
- Very short recordings whose every utterance is only a greeting, microphone
  check or test phrase bypass the model and return
  `本次录音仅包含简短问候，暂无可总结的议题、决定或行动项。` with no decisions
  or action items. A line containing a real topic does not enter this guard.
- The temporary migration/idempotency test plus related existing suites passed
  32/32. The complete canonical backend suite passed 238/238 before restart.
  Runtime health, schema columns and authenticated black-box API checks are
  recorded after the controlled port-18020 restart.
- Pre-change source, review documents and `local.db` are retained with
  owner-only permissions under
  `/home/zhong/laoji-service-platform/backups/20260721-guest-migration-location-summary`.
  Rollback restores the four `.before` runtime files, confirms no established
  18020 connections, and restarts only the owned meeting backend. Restoring
  `local.db.before` is only required for a full data rollback and would discard
  meeting changes made after this deployment.
- Final SHA-256 values are
  `5a188faf47205a7ca62ae0826475b3e0fed6c9ac92aa5ea7dab8c4f2da7147fc`
  for `app/models/meeting.py`,
  `3c241e17797adc4f18c166dfbc361263aea72f26b43f4fb0b78c5f640360ac16`
  for `app/services/app_meeting_schema.py`,
  `01b34011ff993fd8bd0c473ee8fb1dfb0163ed1019f4952dd6f243a9376fbc93`
  for `app/api/app_meetings.py`, and
  `6c39206eb6f91be24ea05033e5b3ddcecb1089f7acd4f6525f2f6a68f62b1fb3`
  for `app/workers/summary_tasks.py`.
- Port 18020 restarted only after its established-connection count reached
  zero; PID changed from `3245303` to `3805323`. `/health` is green, both
  additive columns exist, and OpenAPI exposes the guest import route.
- An authenticated live probe returned create `201`, first import `200`, retry
  import `200`, and unauthenticated import `401`; the retry retained exactly one
  transcript and reported `already_imported=true`. A second live probe imported
  the three greeting lines `喂喂。/你们好。/大家好。`, completed its summary task
  with `SUCCESS`, and returned the deterministic overview with zero decisions
  and zero action items. Both temporary meetings were deleted.
- Historical summaries are repaired on authenticated read as well as during new
  generation: when the stored transcript contains only short greetings, stale
  overview, full text, Markdown, decisions and action items can no longer leak
  back to the App. The focused post-fix suite passed 4/4 and the complete
  canonical backend suite passed 238/238. A live black-box probe imported an
  intentionally false historical summary, then `GET /summaries/final` returned
  the deterministic Chinese overview, `markdown=null`, zero decisions and zero
  action items; its temporary meeting was deleted.
- The post-fix restart again waited for zero established port-18020 connections.
  The healthy meeting backend after that patch was PID `3919503`; schema columns and the
  guest import OpenAPI route remain present.
- A real-device counterexample contained exactly `早上好，早上好。` and
  `大家早上好。`. The bounded greeting matcher now also accepts explicit
  `大家/各位 + 时段 + 好` forms while still rejecting the control
  `大家早上好，今天讨论迁移方案。`; ordinary topic-bearing text still reaches
  the model. The exact phone sample is covered by both the focused regression
  and authenticated historical-summary black box.
- The greeting-variant focused suite passed 2/2 and the complete canonical
  backend suite passed 238/238. After another zero-connection and zero-active-
  meeting check, only port 18020 restarted from PID `3919503` to `4086380`.
  Health is green, the exact phone sample returns the deterministic result with
  no decisions or action items, and the probe meeting was deleted. Rollback for
  this narrow follow-up is
  `backups/20260721-guest-migration-location-summary/summary_tasks.py.before-real-greeting-variants`.

### App Voiceprint Capture-Domain Repair - 2026-07-21
- This entry corrects the earlier broad conclusion that successful fixture
  probes established the real App voiceprint path. Account 77 had one active
  profile loaded by all three authenticated sessions, yet all seven replayed
  production VAD segments scored only 0.1898-0.3470 against it. Whole-file
  scores were 0.1391-0.3751. Gain normalization, repetition, zero padding and
  speech-only concatenation did not recover the existing profile, so neither
  account scope nor the 0.06 candidate gap caused the miss.
- Source inspection found that Android speaker enrollment used
  `VOICE_RECOGNITION` while meeting inference used `VOICE_COMMUNICATION`.
  A bounded counterfactual built temporary profiles from meeting-domain audio:
  cross-meeting segment scores recovered to 0.4913-0.7240. The bundled CAM++
  controls scored 0.6933 for the same speaker and -0.0842/0.0072 for different
  speakers. This supports capture-domain mismatch without lowering the 0.5
  realtime identity threshold. Final proof still requires a fresh phone-side
  enrollment and natural meeting after the v100 App is installed.
- The App now records enrollment through the same `VOICE_COMMUNICATION` source
  as meetings and sends capture profile
  `android-voice-communication-v1`. The server adds an idempotent
  `speaker_profiles.capture_profile` column. A first current-profile supplement
  replaces a legacy-domain vector instead of averaging incompatible domains;
  later same-profile supplements require cosine >= 0.45 before aggregation.
  All user-visible rejection text is Chinese.
- App enrollment extraction now reuses the exact warm CAM++ model manager used
  by realtime inference. Realtime logs retain candidate ID, cosine, gap,
  acceptance and segment duration even for rejected matches, without storing
  transcript text or raw audio in the diagnostic line.
- Focused server tests pass 16/16 and the complete canonical suite passes
  241/241. Authenticated HTTP black-box results were same voice 200, different
  voice 400, legacy replacement 200. Both temporary profiles and embeddings
  were physically removed after the API soft-delete check.
- Deployment waited for zero established 18020 connections and zero recording
  or processing meetings, then restarted only the owned meeting backend from
  PID 4086380 to healthy PID 188280. Account 77 remains byte-for-byte unchanged
  from the pre-change backup: two samples, capture profile `legacy`, embedding
  SHA-256 `4354d505beec103ba2203998609952c794fad78742d3374012e67b69f0356b56`.
  It will migrate only when the user explicitly records a new sample in v100.
- Owner-only recovery material is under
  `backups/20260721-voiceprint-capture-domain`. Code rollback restores the three
  runtime `.before` files, confirms no active 18020 connection and restarts only
  that backend. Restoring the database snapshot is a separate data rollback and
  would discard voiceprint changes made after this deployment.
- Final SHA-256 values are
  `0caeb49f76d25f5c37e164e14d6210026ff5bdcf2f25ade39e191c3b7f8edbf0`
  for `app/api/app_speakers.py`,
  `7bcd310f34c9d2fe448451e25826eded83c54b432573561e6ecfea0fa278bf0b`
  for `app/api/qwen_ws.py`, and
  `511bd83e2241e65adfc7f15219d5e74b83beef5dced0fcb9b9136b3d035e0c2c`
  for `app/services/speaker_db_service.py`.
