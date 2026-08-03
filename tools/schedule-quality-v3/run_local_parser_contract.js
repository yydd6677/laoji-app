#!/usr/bin/env node

/*
 * Run the active mobile TypeScript parser without Expo, Jest, or a network
 * service. The script is intentionally a small contract probe for the C0/C1
 * boundaries in service-quality-upgrade-directive.md.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const repoRoot = path.resolve(__dirname, '..', '..');
const parserPath = path.join(repoRoot, 'src', 'services', 'localScheduleParser.ts');
// Transpile TypeScript on demand while preserving each module's real filename.
// Compiling only the entry file into /tmp breaks its relative .ts imports
// (eventColors -> theme/colors) and made this contract runner fail before any
// parser assertion executed.
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: filename,
  }).outputText;
  module._compile(compiled, filename);
};
const originalLoad = Module._load;
Module._load = function loadWithoutExpo(request, parent, isMain) {
  if (request === 'expo-modules-core') return { requireOptionalNativeModule: () => null };
  return originalLoad.call(this, request, parent, isMain);
};
const source = fs.readFileSync(parserPath, 'utf8');
const parser = require(parserPath);
const referenceDate = new Date(2026, 6, 9, 23, 30, 0);

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

check('uncertain_location_never_enters_local_safe', () => {
  const text = '明天下午三点在可能是东门的位置和产品确认方案';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parsed.needs_clarification, true);
  assert.match(parsed.clarification_question, /地点/);
  assert.equal(parser.classifyScheduleParseRoute(text, parsed, referenceDate).route, 'server_required');
});

check('relative_offset_crosses_midnight_with_complete_interval', () => {
  const parsed = parser.parseLocalScheduleText('十五分钟后提醒我提交材料', referenceDate);
  assert.equal(parsed.start_date, '2026-07-09');
  assert.equal(parsed.end_date, '2026-07-10');
  assert.equal(parsed.start_time, '23:45');
  assert.equal(parsed.end_time, '00:45');
  assert.equal(parsed.needs_clarification, false);
});

check('finite_relative_range_is_local_safe', () => {
  const text = '今天和明天上班';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parsed.start_date, '2026-07-09');
  assert.equal(parsed.end_date, '2026-07-10');
  assert.equal(parser.classifyScheduleParseRoute(text, parsed, referenceDate).route, 'local_safe');
});

check('invalid_explicit_date_blocks_save', () => {
  const text = '2026年2月30日下午三点安排客户沟通';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parsed.start_date, '');
  assert.equal(parsed.needs_clarification, true);
  assert.match(parsed.clarification_question, /有效日期/);
  assert.notEqual(parser.classifyScheduleParseRoute(text, parsed, referenceDate).route, 'local_safe');
});

check('explicit_dst_risk_time_requires_server_resolution', () => {
  const text = '2026年3月8日凌晨两点半安排安全演练';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parsed.needs_clarification, true);
  assert.match(parsed.clarification_question, /夏令时/);
  assert.equal(parser.classifyScheduleParseRoute(text, parsed, referenceDate).route, 'server_required');
});

check('non_schedule_control_is_rejected', () => {
  const text = '不要真的创建日程，只是测试麦克风';
  assert.equal(parser.parseLocalScheduleText(text, referenceDate), null);
  assert.equal(parser.classifyScheduleParseRoute(text, null, referenceDate).route, 'reject');
});

check('metamorphic_filler_does_not_change_safe_schedule', () => {
  const first = parser.parseLocalScheduleText('明天下午三点开会', referenceDate);
  const second = parser.parseLocalScheduleText('嗯，明天下午三点，开会', referenceDate);
  assert.deepEqual(
    { title: second.title, start_date: second.start_date, start_time: second.start_time, end_time: second.end_time },
    { title: first.title, start_date: first.start_date, start_time: first.start_time, end_time: first.end_time },
  );
});

check('weekday_hour_boundary_preserves_corrected_time_range', () => {
  const text = '不是周四，是下周五两点到四点开项目复盘会';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parsed.start_date, '2026-07-17');
  assert.equal(parsed.start_time, '02:00');
  assert.equal(parsed.end_time, '04:00');
  assert.equal(parsed.title, '项目复盘会');
  assert.equal(parsed.needs_clarification, false);
});

check('afternoon_tea_context_sets_implicit_afternoon', () => {
  const parsed = parser.parseLocalScheduleText('今天下午茶三点喝咖啡', referenceDate);
  assert.equal(parsed.start_date, '2026-07-09');
  assert.equal(parsed.start_time, '15:00');
  assert.equal(parsed.end_time, '16:00');
});

check('next_month_end_is_not_current_month_end', () => {
  const parsed = parser.parseLocalScheduleText('下个月底前完成迁移', referenceDate);
  assert.equal(parsed.start_date, '2026-08-31');
  assert.equal(parsed.needs_clarification, false);
});

check('month_only_action_enters_date_clarification', () => {
  const text = '下个月交报告';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.ok(parsed);
  assert.equal(parsed.title, '交报告');
  assert.equal(parsed.category, '工作');
  assert.equal(parsed.start_date, '');
  assert.equal(parsed.needs_clarification, true);
  const route = parser.classifyScheduleParseRoute(text, parsed, referenceDate);
  assert.equal(route.route, 'clarify');
  assert.equal(route.code, 'missing_date');
});

check('traditional_asr_glyphs_enter_local_safe_route', () => {
  const text = '下週一上午十點週會';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parsed.raw_text, text);
  assert.equal(parsed.start_date, '2026-07-13');
  assert.equal(parsed.start_time, '10:00');
  assert.equal(parsed.needs_clarification, false);
  assert.equal(parser.classifyScheduleParseRoute(text, parsed, referenceDate).route, 'local_safe');
});

check('traditional_time_and_category_aliases_are_parsed', () => {
  const parsed = parser.parseLocalScheduleText('7月20號下午兩點項目評審', referenceDate);
  assert.equal(parsed.start_date, '2026-07-20');
  assert.equal(parsed.start_time, '14:00');
  assert.equal(parsed.category, '工作');
});

check('traditional_learning_category_aliases_are_parsed', () => {
  const parsed = parser.parseLocalScheduleText('本週五到下週一參加培訓', referenceDate);
  assert.equal(parsed.start_date, '2026-07-10');
  assert.equal(parsed.end_date, '2026-07-13');
  assert.equal(parsed.category, '学习');
});

check('low_information_asr_title_never_enters_local_safe', () => {
  const text = '明天上午九点提前不用提醒';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parsed.needs_clarification, true);
  assert.match(parsed.clarification_question, /标题不完整/);
  assert.equal(parser.classifyScheduleParseRoute(text, parsed, referenceDate).route, 'server_required');
});

check('credit_card_title_is_not_truncated_by_usage_marker', () => {
  const parsed = parser.parseLocalScheduleText('后天下午五点之前，还信用卡。', referenceDate);
  assert.equal(parsed.title, '还信用卡');
  assert.equal(parsed.category, '财务');
  assert.equal(parser.classifyScheduleParseRoute(parsed.raw_text, parsed, referenceDate).route, 'local_safe');
});

check('context_edit_still_requires_an_existing_target', () => {
  const text = '把之前的日程改到明天下午三点';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parser.classifyScheduleParseRoute(text, parsed, referenceDate).route, 'server_required');
});

check('known_credit_card_homophone_requires_server_resolution', () => {
  const text = '每月十五号还新用卡';
  const parsed = parser.parseLocalScheduleText(text, referenceDate);
  assert.equal(parsed.raw_text, text);
  assert.equal(parser.classifyScheduleParseRoute(text, parsed, referenceDate).route, 'server_required');
});

check('request_timezone_controls_relative_day_boundary', () => {
  const instant = new Date('2026-12-31T23:50:00+00:00');
  const text = '明天上午九点安排海外组安全演练对齐';
  const utc = parser.parseLocalScheduleText(text, instant, 'UTC');
  const shanghai = parser.parseLocalScheduleText(text, instant, 'Asia/Shanghai');
  assert.equal(utc.start_date, '2027-01-01');
  assert.equal(shanghai.start_date, '2027-01-02');
  assert.equal(utc.start_time, '09:00');
  assert.equal(shanghai.start_time, '09:00');
});

check('request_timezone_controls_relative_offset_boundary', () => {
  const instant = new Date('2026-12-31T23:50:00+00:00');
  const parsed = parser.parseLocalScheduleText('十五分钟后提醒我提交材料', instant, 'UTC');
  assert.equal(parsed.start_date, '2027-01-01');
  assert.equal(parsed.start_time, '00:05');
  assert.equal(parsed.end_time, '01:05');
});

check('unsupported_request_timezone_keeps_legacy_parser_safe', () => {
  const text = '明天上午九点安排安全演练';
  const parsed = parser.parseLocalScheduleText(text, referenceDate, 'Not/AZone');
  assert.equal(parsed.start_date, '2026-07-10');
  assert.equal(parser.classifyScheduleParseRoute(text, parsed, referenceDate, 'Not/AZone').route, 'local_safe');
});

check('evening_clock_is_not_parsed_as_morning', () => {
  const parsed = parser.parseLocalScheduleText(
    '后天傍晚六点进行客户组供应商合同复核',
    new Date('2026-08-31T16:20:00+08:00'),
    'Asia/Shanghai',
  );
  assert.equal(parsed.start_time, '18:00');
  assert.equal(parsed.end_time, '19:00');
});

check('finite_daily_range_keeps_daily_event_type', () => {
  const parsed = parser.parseLocalScheduleText(
    '下周一到周三每天上午九点安排北区体检报告评审',
    new Date('2026-03-02T00:05:00+08:00'),
    'Asia/Shanghai',
  );
  assert.equal(parsed.event_type, 'daily');
  assert.equal(parsed.start_date, '2026-03-09');
  assert.equal(parsed.end_date, '2026-03-11');
});

check('monthly_and_yearly_occurrences_roll_to_next_date', () => {
  const monthly = parser.parseLocalScheduleText(
    '每月13号安排华南区安全演练确认',
    new Date('2026-11-30T14:45:00+08:00'),
    'Asia/Shanghai',
  );
  const yearly = parser.parseLocalScheduleText(
    '每年5月13号安排北区安全演练确认',
    new Date('2026-12-31T23:50:00+08:00'),
    'Asia/Shanghai',
  );
  assert.equal(monthly.start_date, '2026-12-13');
  assert.equal(yearly.start_date, '2027-05-13');
});

check('compact_weekday_set_keeps_all_selected_days', () => {
  const parsed = parser.parseLocalScheduleText(
    '每周一三五上午九点安排海外组周会',
    referenceDate,
    'Asia/Shanghai',
  );
  assert.equal(parsed.event_type, 'weekly');
  assert.deepEqual(parsed.recurrence_weekdays, [1, 3, 5]);
  assert.equal(parsed.start_date, '2026-07-10');
});

check('multi_month_and_year_intervals_are_not_once', () => {
  const monthly = parser.parseLocalScheduleText(
    '每两个月10号上午十一点安排季度复盘',
    referenceDate,
    'Asia/Shanghai',
  );
  const yearly = parser.parseLocalScheduleText(
    '每两年1月1号安排年度复盘',
    referenceDate,
    'Asia/Shanghai',
  );
  assert.equal(monthly.event_type, 'monthly');
  assert.equal(monthly.recurrence_interval, 2);
  assert.equal(monthly.start_date, '2026-07-10');
  assert.equal(parser.classifyScheduleParseRoute(monthly.raw_text, monthly, referenceDate, 'Asia/Shanghai').route, 'local_safe');
  assert.equal(yearly.event_type, 'yearly');
  assert.equal(yearly.recurrence_interval, 2);
  assert.equal(yearly.start_date, '2027-01-01');
  assert.equal(parser.classifyScheduleParseRoute(yearly.raw_text, yearly, referenceDate, 'Asia/Shanghai').route, 'local_safe');
});

check('location_action_keeps_physical_location_and_title', () => {
  const parsed = parser.parseLocalScheduleText(
    '明天下午三点在研发楼A301会议室安排华东区版本发布讨论',
    referenceDate,
    'Asia/Shanghai',
  );
  assert.equal(parsed.title, '华东区版本发布讨论');
  assert.equal(parsed.location, '研发楼A301会议室');
  assert.equal(parser.classifyScheduleParseRoute(parsed.raw_text, parsed, referenceDate, 'Asia/Shanghai').route, 'local_safe');
});

check('control_suffix_does_not_drop_action_word_from_title', () => {
  const parsed = parser.parseLocalScheduleText(
    '明天下午两点安排华南区版本发布讨论，提前45分钟提醒',
    referenceDate,
    'Asia/Shanghai',
  );
  assert.equal(parsed.title, '华南区版本发布讨论');
  assert.equal(parsed.description, null);
  assert.equal(parsed.reminder_minutes, 45);
});

check('asr_fillers_do_not_leak_into_title', () => {
  const parsed = parser.parseLocalScheduleText(
    '嗯，明天呃下午五点安排海外组差旅行程汇报就这样',
    referenceDate,
    'Asia/Shanghai',
  );
  assert.equal(parsed.title, '海外组差旅行程汇报');
  assert.equal(parsed.start_time, '17:00');
});

check('asr_action_filler_does_not_leak_into_title', () => {
  const parsed = parser.parseLocalScheduleText(
    '嗯，明天呃下午五点，那个安排海外组季度复盘，谢谢',
    referenceDate,
    'Asia/Shanghai',
  );
  assert.equal(parsed.title, '海外组季度复盘');
  assert.equal(parsed.start_time, '17:00');
});

check('recording_politeness_marker_does_not_become_title', () => {
  const parsed = parser.parseLocalScheduleText(
    '麻烦记录一下，后天上午九点进行华南区供应商合同复核',
    referenceDate,
    'Asia/Shanghai',
  );
  assert.equal(parsed.title, '华南区供应商合同复核');
});

const report = {
  schema_version: 1,
  service: 'SVC-01 local schedule parser contract',
  parser_sha256: require('node:crypto').createHash('sha256').update(source).digest('hex'),
  total: checks.length,
  passed: checks.filter(item => item.passed).length,
  failed: checks.filter(item => !item.passed).length,
  checks,
  evidence_boundary: {
    passed_proves: ['deterministic mobile parser C0/C1 boundary contracts'],
    not_proven: ['remote model quality', 'holdout quality', 'real user shadow traffic', 'server latency'],
  },
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed === 0 ? 0 : 1;
