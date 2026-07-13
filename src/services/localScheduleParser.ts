import type { ParseResult } from './api';
import type { EventCategory } from '../utils/eventColors';

type LocalDate = {
  year: number;
  month: number;
  day: number;
};

const CN_NUM: Record<string, number> = {
  '零': 0,
  '〇': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
};

const WEEKDAY_MAP: Record<string, number> = {
  '一': 0,
  '二': 1,
  '三': 2,
  '四': 3,
  '五': 4,
  '六': 5,
  '日': 6,
  '天': 6,
  '1': 0,
  '2': 1,
  '3': 2,
  '4': 3,
  '5': 4,
  '6': 5,
  '7': 6,
};

const DATE_TOKEN =
  '(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)' +
  '|(?:下个月|下月|本月|这个月)[0-9一二两三四五六七八九十]{1,3}(?:号|日)' +
  '|下月底|下月末|月底|月末|大后天|后天|明天|今天|今日' +
  '|(?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7]' +
  '|[0-9一二两三四五六七八九十]{1,3}(?:号|日)';

const TIME_TOKEN =
  '(?:[01]?\\d|2[0-3])[:：][0-5]\\d' +
  '|(?:凌晨|早上|上午|中午|下午|晚上|晚间)?[0-9一二两三四五六七八九十]{1,3}点(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?';

const LAOJI_WAKE_WORD = '(?:老记|老纪|老计|老季|牢记|小记)';
const IMPLICIT_CROSS_YEAR_CONFIRM_DAYS = 183;

const CATEGORY_RULES: Array<[EventCategory, RegExp]> = [
  ['重要', /(重要|截止|紧急|到期|必须|尽快|加急|最终版|回滚|风险|护照过期|证书到期|ddl|DDL|deadline|Deadline)/],
  ['学习', /(学习|复习|上课|课程|考试|作业|论文|阅读|培训|背单词|公开课|文献|答辩|实验报告|模拟考试|资格考试|读书会|听力|算法课|统计学)/],
  ['工作', /(工作|会议|开会|周会|周报|项目|评审|复盘|需求|汇报|报告|预算|系统维护|检查服务器|客户|合同|供应商|产品方案|设计稿|接口联调|测试用例|上线|投标|库存|数据报表|值班|招聘|面试)/],
  ['健康', /(健康|健身|运动|跑步|训练|复诊|体检|看病|服药|吃药|买药|牙医|眼科|康复|疫苗|心理咨询|睡眠|血压|游泳|瑜伽)/],
  ['出行', /(出行|出发|旅行|旅游|交通|航班|飞机|高铁|火车|车票|机票|打车|坐车|出差|机场|车站|酒店|值机|行李|路线|租车|签证|景点|退票|换乘|行程|接机)/],
  ['财务', /(财务|钱|付款|付钱|支付|缴费|交费|还款|账单|发票|报销|工资|收入|贷款|房贷|信用卡|房租|社保|转账|收款|退款|保险|停车费|物业费|水电费|报名费)/],
  ['社交', /(社交|聚餐|约会|朋友|生日|同学|家庭晚饭|咖啡|电影|婚礼|爸妈|约球|读书沙龙|社区活动|送别|亲戚)/],
  ['生活', /(生活|家务|购物|买|取|家|个人|快递|睡觉|喝水|大扫除|理发|修空调|手机膜|加油|洗衣|买菜|猫粮|寄文件|证件照|整理衣柜|物业)/],
];

const SERVER_PARSE_REQUIRED_RE =
  /(不是|不对|说错|改成|最终|最后|更正|纠正|别弄错|以后面的为准|后面的为准|不要保存|不要真的|只是测试|只是举例|不是日程|先别自动|晚点补|还没定|没想好|如果冲突)/;

const DATE_CORRECTION_RE = /(不是|不对|说错|改成|最终|最后|更正|纠正|以后面的为准|后面的为准)/;

const NON_SCHEDULE_CONTROL_RE =
  /(不要真的创建日程|不要创建日程|不要保存|不是日程|只是测试|只是举例|先别自动保存|测试麦克风|识别效果|随便说一句话)/;

const COMPLEX_SCHEDULE_RE =
  /(标题(?:不要太长|写|就写|叫|设为|是)|重点是|主要确认|需要通知|地点(?:还)?可能|这是新的安排|先不要和|如果[^,，。]{0,24}(?:被占|照这个时间)|这件事和|也参加|一起|带上|这次主要是|不用写太长|别只记一天)/;

const LOCATION_TOKEN_PATTERN =
  '(?:[^，,。.!！?？；;]{0,20}[A-Za-z]{1,4}[-_]?\\d{1,4}(?:室|房间)?|' +
  '[^，,。.!！?？；;]{0,24}?(?:会议室|办公室|图书馆|健身房|咖啡馆|咖啡店|' +
  '实验室|教室|报告厅|写字楼|大厦|商场|超市|机场|车站|公司|学校|医院|' +
  '公园|餐厅|饭店|酒店|园区|小区|广场|中心|工作室|体育馆|体育场|球场|' +
  '码头|港口|校区|现场|路|街|巷|室|厅|楼|馆|院|门|站|店|家))';
const LOCATION_LOCALIZER_PATTERN = '(?:里面|里|内|外|附近|门口|旁边|楼上|楼下|前台|大厅|现场|口)?';
const LOCATION_ACTION_PATTERN =
  '(?:开会|召开|举行|进行|参加|处理|完成|提交|整理|跟进|准备|复盘|讨论|沟通|' +
  '确认|评审|汇报|学习|复习|上课|考试|培训|阅读|跑步|健身|运动|体检|看病|' +
  '服药|聚餐|约会|吃饭|购物|购买|买|取|领取|寄|打印|缴|交|支付|还款|报销|' +
  '拜访|会见|维护|检查|测试|发布|更新|制作|编写|练习|集合|出发|接待|签字|' +
  '排队|取号|见面|接|送|办理|预约)';
const LOCATION_WITH_ACTION_RE = new RegExp(
  `(?:在|地点(?:是|为)?|地址(?:是|为)?)\\s*` +
  `(${LOCATION_TOKEN_PATTERN}${LOCATION_LOCALIZER_PATTERN})\\s*` +
  `(${LOCATION_ACTION_PATTERN}[^，,。.!！?？；;]{0,40})`
);
const INFERRED_LOCATION_RE = new RegExp(
  `在\\s*(${LOCATION_TOKEN_PATTERN}${LOCATION_LOCALIZER_PATTERN})` +
  `(?=\\s*(?:${LOCATION_ACTION_PATTERN}|[，,。.!！?？；;]|$))`
);

function toLocalDate(input = new Date()): LocalDate {
  return {
    year: input.getFullYear(),
    month: input.getMonth() + 1,
    day: input.getDate(),
  };
}

function fromLocalDate(value: LocalDate): Date {
  return new Date(value.year, value.month - 1, value.day);
}

function addDays(value: LocalDate, days: number): LocalDate {
  const date = fromLocalDate(value);
  date.setDate(date.getDate() + days);
  return toLocalDate(date);
}

function compareDate(a: LocalDate, b: LocalDate): number {
  return fromLocalDate(a).getTime() - fromLocalDate(b).getTime();
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function formatDate(value: LocalDate): string {
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function mondayWeekday(value: LocalDate): number {
  const day = fromLocalDate(value).getDay();
  return (day + 6) % 7;
}

function cnToInt(value?: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (CN_NUM[value.slice(1)] ?? 0);
  if (value.includes('十')) {
    const [left, right] = value.split('十', 2);
    return (CN_NUM[left] ?? 0) * 10 + (right ? CN_NUM[right] ?? 0 : 0);
  }
  return [...value].reduce((total, char) => total * 10 + (CN_NUM[char] ?? 0), 0);
}

function nextWeekday(weekday: number, today: LocalDate, includeToday = false): LocalDate {
  let delta = weekday - mondayWeekday(today);
  if (delta < 0 || (delta === 0 && !includeToday)) delta += 7;
  return addDays(today, delta);
}

function weekdayInWeek(weekday: number, weeksFromThis: number, today: LocalDate): LocalDate {
  const monday = addDays(today, -mondayWeekday(today));
  return addDays(monday, weeksFromThis * 7 + weekday);
}

function normalizeLaojiTranscript(text: string): string {
  const cleaned = (text || '').trim();
  if (!cleaned) return cleaned;
  const pattern = new RegExp(`^((?:${LAOJI_WAKE_WORD}[，,。\\s]*){1,2})`);
  return cleaned.replace(pattern, match => match.replace(new RegExp(LAOJI_WAKE_WORD, 'g'), '老记'));
}

function normalizeScheduleText(text: string): string {
  const temporalFiller = '(?:[，,]*(?:呃|额|嗯|那个|可能|然后|别忘了)[，,]*)+';
  const cleaned = normalizeLaojiTranscript(text)
    .trim()
    .replace(new RegExp(`^${LAOJI_WAKE_WORD}[，,。\\s]*(?:${LAOJI_WAKE_WORD})?[，,。\\s]*`), '')
    .replace(/\s+/g, '')
    .replace(/不(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+是/g, '不是')
    .replace(/不(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+对/g, '不对')
    .replace(/说(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+错/g, '说错')
    .replace(/改(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+成/g, '改成')
    .replace(/^(?:(?:刚才)?(?:说漏了|漏说了|忘了说)|补充一下|再补充(?:一下)?|对了)[，,。]*/g, '')
    .replace(/((?:每天|每日))[0-9一二两三四五六七八九十]{1,2}(?:差不多|大概(?:是)?|可能(?:是)?)(?=(?:[01]?\d|2[0-3])[:：])/g, '$1')
    .replace(new RegExp(`([0-9一二两三四五六七八九十])${temporalFiller}(?=月)`, 'g'), '$1')
    .replace(new RegExp(`(月)${temporalFiller}(?=[0-9一二两三四五六七八九十])`, 'g'), '$1')
    .replace(new RegExp(`((?:下下|下|本|这)?(?:周|星期|礼拜))${temporalFiller}(?=[一二三四五六日天1-7])`, 'g'), '$1')
    .replace(new RegExp(`(到|至|直到)${temporalFiller}(?=(?:下下|下|本|这)?(?:周|星期|礼拜)|[0-9一二两三四五六七八九十])`, 'g'), '$1')
    .replace(/(号|日)始(?=到|至)/g, '$1开始')
    .replace(/提前([0-9一二两三四五六七八九十]{1,3})时(?=提醒)/g, '提前$1小时')
    .replace(/声音可能有点小/g, '')
    .replace(/(?:嗯|可能)*(?:不要|别)漏(?:掉)?前面日期/g, '');
  return cleaned.replace(/^[，,。.!！?？]+|[，,。.!！?？]+$/g, '');
}

function parseExplicitOrRelativeDate(text: string, today: LocalDate): LocalDate | null {
  if (text.includes('下月底') || text.includes('下月末')) {
    const year = today.month === 12 ? today.year + 1 : today.year;
    const month = today.month === 12 ? 1 : today.month + 1;
    return { year, month, day: daysInMonth(year, month) };
  }
  if (text.includes('月底') || text.includes('月末')) {
    return { ...today, day: daysInMonth(today.year, today.month) };
  }
  if (text.includes('大后天')) return addDays(today, 3);
  if (text.includes('后天')) return addDays(today, 2);
  if (text.includes('明天')) return addDays(today, 1);
  if (text.includes('今天') || text.includes('今日')) return today;

  let match = text.match(/(下个月|下月|本月|这个月)([0-9一二两三四五六七八九十]{1,3})(?:号|日)/);
  if (match) {
    let year = today.year;
    let month = today.month;
    if (match[1] === '下个月' || match[1] === '下月') {
      year += month === 12 ? 1 : 0;
      month = month === 12 ? 1 : month + 1;
    }
    const day = Math.max(1, Math.min(daysInMonth(year, month), cnToInt(match[2])));
    return { year, month, day };
  }

  match = text.match(/([0-9]{4})年([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)/);
  if (match) {
    const year = Number(match[1]);
    const month = Math.max(1, Math.min(12, cnToInt(match[2])));
    const day = Math.max(1, Math.min(daysInMonth(year, month), cnToInt(match[3])));
    return { year, month, day };
  }

  match = text.match(/([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)/);
  if (match) {
    const month = Math.max(1, Math.min(12, cnToInt(match[1])));
    const day = Math.max(1, Math.min(daysInMonth(today.year, month), cnToInt(match[2])));
    let candidate = { year: today.year, month, day };
    if (compareDate(candidate, today) < 0) candidate = { ...candidate, year: today.year + 1 };
    return candidate;
  }

  match = text.match(/(?:(下下|下|本|这)?(?:周|星期|礼拜))([一二三四五六日天1-7])/);
  if (match) {
    const prefix = match[1] ?? '';
    const weekday = WEEKDAY_MAP[match[2]];
    if (prefix === '下下') return weekdayInWeek(weekday, 2, today);
    if (prefix === '下') return weekdayInWeek(weekday, 1, today);
    if (prefix === '本' || prefix === '这') return weekdayInWeek(weekday, 0, today);
    return nextWeekday(weekday, today);
  }

  match = text.match(/([0-9一二两三四五六七八九十]{1,3})(?:号|日)/);
  if (match) {
    const day = cnToInt(match[1]);
    const maxDay = daysInMonth(today.year, today.month);
    if (day >= 1 && day <= maxDay) {
      let candidate = { ...today, day };
      if (compareDate(candidate, today) < 0) {
        const year = today.month === 12 ? today.year + 1 : today.year;
        const month = today.month === 12 ? 1 : today.month + 1;
        candidate = { year, month, day: Math.min(day, daysInMonth(year, month)) };
      }
      return candidate;
    }
  }
  return null;
}

function parseDateToken(token: string, today: LocalDate, context?: LocalDate | null): LocalDate | null {
  const clean = token.trim();
  if (context) {
    let match = clean.match(/^([0-9一二两三四五六七八九十]{1,3})(?:号|日)$/);
    if (match) {
      const day = cnToInt(match[1]);
      let year = context.year;
      let month = context.month;
      let candidate = { year, month, day: Math.min(day, daysInMonth(year, month)) };
      if (compareDate(candidate, context) < 0) {
        year = month === 12 ? year + 1 : year;
        month = month === 12 ? 1 : month + 1;
        candidate = { year, month, day: Math.min(day, daysInMonth(year, month)) };
      }
      return candidate;
    }
    match = clean.match(/^([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)$/);
    if (match) {
      const month = Math.max(1, Math.min(12, cnToInt(match[1])));
      const year = context.year + (month < context.month ? 1 : 0);
      return { year, month, day: Math.min(cnToInt(match[2]), daysInMonth(year, month)) };
    }
    match = clean.match(/^(?:周|星期|礼拜)([一二三四五六日天1-7])$/);
    if (match) {
      const weekday = WEEKDAY_MAP[match[1]];
      let delta = weekday - mondayWeekday(context);
      if (delta < 0) delta += 7;
      return addDays(context, delta);
    }
  }
  return parseExplicitOrRelativeDate(clean, today);
}

function parseDateRange(text: string, today: LocalDate): [LocalDate, LocalDate] | null {
  const pattern = new RegExp(`(${DATE_TOKEN})(?:开始)?(?:到|至|直到|[-—~～])(${DATE_TOKEN})`, 'g');
  const ranges: Array<[LocalDate, LocalDate]> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = parseDateToken(match[1], today);
    const end = start ? parseDateToken(match[2], today, start) : null;
    if (start && end && compareDate(end, start) >= 0) ranges.push([start, end]);
  }
  if (ranges.length === 0) return null;
  return DATE_CORRECTION_RE.test(text) ? ranges[ranges.length - 1] : ranges[0];
}

function implicitLongCrossYearRangeNeedsConfirmation(
  text: string,
  range: [LocalDate, LocalDate] | null,
): boolean {
  if (!range || range[1].year <= range[0].year) return false;
  const durationDays = Math.round(compareDate(range[1], range[0]) / 86_400_000);
  if (durationDays <= IMPLICIT_CROSS_YEAR_CONFIRM_DAYS) return false;

  const pattern = new RegExp(`(${DATE_TOKEN})(?:开始)?(?:到|至|直到|[-—~～])(${DATE_TOKEN})`, 'g');
  const pairs: Array<[string, string]> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) pairs.push([match[1], match[2]]);
  const selected = DATE_CORRECTION_RE.test(text) ? pairs[pairs.length - 1] : pairs[0];
  return Boolean(selected && !selected.every(token => /^[0-9]{4}年/.test(token)));
}

function parseAuthoritativeDate(text: string, today: LocalDate): LocalDate | null {
  if (DATE_CORRECTION_RE.test(text)) {
    const pattern = new RegExp(DATE_TOKEN, 'g');
    const tokens: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) tokens.push(match[0]);
    if (tokens.length > 0) {
      const parsed = parseDateToken(tokens[tokens.length - 1], today);
      if (parsed) return parsed;
    }
  }
  return parseExplicitOrRelativeDate(text, today);
}

function extractTimePeriod(token: string): string {
  return token.trim().match(/^(凌晨|早上|上午|中午|下午|晚上|晚间)/)?.[1] ?? '';
}

function formatTimeParts(period: string, rawHour: number, minute: number): string | null {
  let hour = rawHour;
  if (['下午', '晚上', '晚间'].includes(period) && hour < 12) hour += 12;
  else if (period === '中午' && hour < 11) hour += 12;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTimeToken(token: string, defaultPeriod = ''): string | null {
  const clean = token.trim();
  const digital = clean.match(/^([01]?\d|2[0-3])[:：]([0-5]\d)$/);
  if (digital) return `${String(Number(digital[1])).padStart(2, '0')}:${digital[2]}`;
  const match = clean.match(/^(凌晨|早上|上午|中午|下午|晚上|晚间)?([0-9一二两三四五六七八九十]{1,3})点(?:(半)|([0-9一二两三四五六七八九十]{1,2})分?)?$/);
  if (!match) return null;
  const period = match[1] ?? defaultPeriod;
  const minute = match[3] ? 30 : (match[4] ? cnToInt(match[4]) : 0);
  return formatTimeParts(period, cnToInt(match[2]), minute);
}

function parseTimeRange(text: string): [string, string] | null {
  const pattern = new RegExp(`(${TIME_TOKEN})(?:到|至|直到|[-—~～])(${TIME_TOKEN})`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = parseTimeToken(match[1]);
    const end = parseTimeToken(match[2], extractTimePeriod(match[1]));
    if (start && end) return [start, end];
  }
  return null;
}

function parseTime(text: string): string | null {
  const digital = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
  if (digital) return `${String(Number(digital[1])).padStart(2, '0')}:${digital[2]}`;
  const match = text.match(/(凌晨|早上|上午|中午|下午|晚上|晚间)?([0-9一二两三四五六七八九十]{1,3})点(?:(半)|([0-9一二两三四五六七八九十]{1,2})分?)?/);
  if (!match) return null;
  const minute = match[3] ? 30 : (match[4] ? cnToInt(match[4]) : 0);
  return formatTimeParts(match[1] ?? '', cnToInt(match[2]), minute);
}

function parseAuthoritativeTime(text: string): string | null {
  const pattern = new RegExp(TIME_TOKEN, 'g');
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) tokens.push(match[0]);
  if (tokens.length === 0) return parseTime(text);
  if (tokens.length === 1) return parseTimeToken(tokens[0]);
  if (tokens.length > 1 && DATE_CORRECTION_RE.test(text)) {
    return parseTimeToken(tokens[tokens.length - 1]);
  }
  return null;
}

function wantsNoReminder(text: string): boolean {
  return /(不提醒|无需提醒|不用提醒|不要提醒)/.test(normalizeScheduleText(text));
}

function parseReminderMinutes(text: string): number | null {
  if (wantsNoReminder(text)) return null;
  if (/(开始时|准时|到点)提醒/.test(text)) return 0;
  let match = text.match(/提前([0-9一二两三四五六七八九十]{1,3})分钟提醒/);
  if (match) return Math.max(0, cnToInt(match[1]));
  if (/提前半小时提醒/.test(text)) return 30;
  match = text.match(/提前([0-9一二两三四五六七八九十]{1,3})小时提醒/);
  if (match) return Math.max(0, cnToInt(match[1]) * 60);
  match = text.match(/提前([0-9一二两三四五六七八九十]{1,3})天提醒/);
  if (match) return Math.max(0, cnToInt(match[1]) * 24 * 60);
  return null;
}

function extractLocationAction(text: string): [string, string] | null {
  const match = text.match(LOCATION_WITH_ACTION_RE);
  if (!match) return null;
  const location = match[1].replace(/^[，,。.!！?？；;的\s]+|[，,。.!！?？；;的\s]+$/g, '');
  const action = match[2].replace(/^[，,。.!！?？；;的\s]+|[，,。.!！?？；;的\s]+$/g, '');
  return location && action ? [location, action] : null;
}

function extractLocation(text: string): string | null {
  const locationAction = extractLocationAction(text);
  if (locationAction) return locationAction[0].slice(0, 100);

  const explicit = text.match(/(?:地点|地址)(?:在|是|为|位于)?\s*([^，,。.!！?？；;]{1,100})/);
  const inferred = text.match(INFERRED_LOCATION_RE);
  const location = (explicit?.[1] ?? inferred?.[1] ?? '')
    .replace(/^[，,。.!！?？；;的\s]+|[，,。.!！?？；;的\s]+$/g, '');
  if (!location) return null;
  if (/(今天|明天|后天|月|号|日|周|星期|礼拜|点)/.test(location)) return null;
  return location.slice(0, 100) || null;
}

function inferCategory(title: string, text: string): EventCategory {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(title)) return category;
  }
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return '其他';
}

function normalizeRecurrenceExpression(text: string): string {
  return text.replace(/每[，,]*(?:额|呃|嗯|那个|可能)?[，,]*(年|月|周|星期|礼拜)/g, '每$1');
}

function stripScheduleMarkers(text: string): string {
  const patterns = [
    '(?:把这个放进日程|日程里加一下|帮我设一下|帮我记一下|帮我记|麻烦记录|给我安排|加个待办|记一条|我需要记住|我记住|提醒我)',
    `(?:从)?(?:${DATE_TOKEN})(?:开始)?(?:到|至|直到|[-—~～])(?:${DATE_TOKEN})`,
    `(?:${TIME_TOKEN})(?:到|至|直到|[-—~～])(?:${TIME_TOKEN})`,
    '提前(?:半小时|[0-9一二两三四五六七八九十]{1,3}(?:分钟|小时|天))提醒',
    '(?:开始时|准时|到点)提醒',
    '(?:不提醒|无需提醒|不用提醒|不要提醒)',
    '每(?:周|星期|礼拜)[一二三四五六日天1-7]',
    '每(?:天|日)',
    '每月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?',
    '每年[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?',
    '(大后天|后天|明天|今天|今日)',
    '(?:下月底|下月末|月底|月末)前?',
    '[0-9]{4}年[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)',
    '[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)',
    '(?:下个月|下月|本月|这个月)[0-9一二两三四五六七八九十]{1,3}(?:号|日)',
    '(?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7]',
    '(凌晨|早上|上午|中午|下午|晚上|晚间)?[0-9一二两三四五六七八九十]{1,3}点(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?',
    '([01]?\\d|2[0-3])[:：]([0-5]\\d)',
    '(提醒我|记一下|安排|日程|待办|要|需要|完成)',
  ];
  return patterns
    .reduce((cleaned, pattern) => cleaned.replace(new RegExp(pattern, 'g'), ''), text)
    .replace(/^[，,。.!！?？的]+|[，,。.!！?？的]+$/g, '');
}

function normalizeTitle(title: string): string {
  let normalized = title
    .replace(/^[，,。.!！?？\s]+/g, '')
    .replace(/^(把这个放进日程|日程里加一下|帮我设一下|帮我记一下|帮我记|麻烦记录|给我安排|加个待办|记一条|我需要记住|我记住|提醒我)[，,。.]*/, '')
    .replace(/^(给我|帮我|麻烦)[，,。.]*/, '')
    .replace(/^从(?:现在)?开始/, '')
    .replace(/先按重(复)?日程记.*$/, '')
    .replace(/^都要?/, '')
    .replace(/^(我要处理|我处理)/, '')
    .replace(/^(前)?(必须|得|需要)/, '');

  const locationAction = extractLocationAction(normalized);
  if (locationAction && /^(?:在|地点|地址)/.test(normalized)) {
    normalized = locationAction[1];
  }

  return normalized
    .split(/[，,。.!！?？]|(?:地点|(?:地点)?在|用)[^，,。.!！?？]{0,40}$|需要通知|和[^，,。.!！?？]{1,16}一起|重点是|主要确认|这件事和|带上/, 1)[0]
    .replace(/(持续处理|处理|完成|提交|整理|跟进|准备)?完$/, '')
    .replace(/^在[^，,。.!！?？]{1,30}(?=开会|会议|见面|上课|办事)/, '')
    .replace(/^(开|召开|举行|进行)(?=.{2,})/, '')
    .replace(/^(和|跟|与)(?=.{2,})/, '')
    .replace(/^[，,。.!！?？的]+|[，,。.!！?？的]+$/g, '');
}

function extractTitleAndDescription(text: string): [string, string | null] {
  const explicitTitle = text.match(/标题(?:不要太长)?[，,]?(就)?(写|叫|设为|是)([^，,。.!！?？]{1,40})/);
  if (explicitTitle) return [normalizeTitle(explicitTitle[3]).slice(0, 20), null];
  let description: string | null = null;
  let titleText = text;
  const descMatch = text.match(/(?:要)?(?:讨论|聊|沟通|确认(?!单|函|码|书|表)|备注|内容是|主题是|关于)(.+)$/);
  if (descMatch && descMatch.index != null) {
    description = descMatch[1].replace(/^[，,。.!！?？]+|[，,。.!！?？]+$/g, '');
    titleText = text.slice(0, descMatch.index).replace(/^[，,。.!！?？]+|[，,。.!！?？]+$/g, '');
  }
  let title = normalizeTitle(stripScheduleMarkers(titleText));
  if (!title && description) title = description;
  return [title.slice(0, 20), description];
}

function defaultEndTime(startTime: string | null): string | null {
  if (!startTime) return null;
  const [hourText, minute] = startTime.split(':');
  const hour = Number(hourText) + 1;
  if (hour >= 24) return null;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

function quickClarificationQuestion(hasDate: boolean, hasTime: boolean): string | null {
  if (!hasDate && !hasTime) return '需要补充日期和时间。';
  if (!hasDate) return '没有听到具体日期，是否安排在今天？';
  if (!hasTime) return '没有听到具体时间，是否作为全天事项保存？';
  return null;
}

function parseLowInformationNote(normalized: string, rawText: string, today: LocalDate): ParseResult | null {
  if (!/(记一下|记个|帮我记|提醒我|待办)/.test(normalized)) return null;
  let [title, description] = extractTitleAndDescription(normalized);
  if (!title) title = '待办';
  return {
    title: title.slice(0, 100),
    event_type: 'once',
    start_date: formatDate(today),
    end_date: null,
    color: null,
    spanning: false,
    start_time: null,
    end_time: null,
    is_all_day: true,
    description: description ? description.slice(0, 500) : null,
    location: null,
    category: inferCategory(title, normalized),
    detail: description ? description.slice(0, 1000) : null,
    status: null,
    reminder_minutes: null,
    raw_text: rawText,
    parse_source: 'rules',
    confidence: 0,
    needs_clarification: true,
    clarification_question: '这条记录还不够明确，需要补充具体事项或时间。',
  };
}

export function parseLocalScheduleText(text: string, referenceDate = new Date()): ParseResult | null {
  const today = toLocalDate(referenceDate);
  const normalized = normalizeScheduleText(text);
  if (!normalized) return null;
  if (isNonScheduleControlText(text)) return null;

  let eventType: ParseResult['event_type'] = 'once';
  const recurrenceText = normalizeRecurrenceExpression(normalized);
  const parsedRange = parseDateRange(normalized, today);
  const implicitLongRangeNeedsConfirmation = implicitLongCrossYearRangeNeedsConfirmation(normalized, parsedRange);
  const dateTokens = normalized.match(new RegExp(DATE_TOKEN, 'g')) ?? [];
  const unresolvedDateRange = !parsedRange
    && dateTokens.length >= 2
    && /(到|至|直到|之间|[-—~～])/.test(normalized);
  let parsedDate = parsedRange ? parsedRange[0] : parseAuthoritativeDate(normalized, today);
  const endDate = parsedRange ? parsedRange[1] : null;

  let match = recurrenceText.match(/每(?:周|星期|礼拜)([一二三四五六日天1-7])/) ?? recurrenceText.match(/从现在开始(?:每)?(?:周|星期|礼拜)([一二三四五六日天1-7]).{0,30}(都要|重复|按重(复)?日程)/);
  if (recurrenceText.includes('每天') || recurrenceText.includes('每日')) {
    // A finite range is represented as one spanning event because the API has
    // no recurrence-until field. Open-ended daily events retain a spoken start.
    eventType = parsedRange ? 'once' : 'daily';
    parsedDate = parsedDate ?? today;
  } else if (match) {
    eventType = 'weekly';
    parsedDate = nextWeekday(WEEKDAY_MAP[match[1]], today, true);
  } else if ((match = recurrenceText.match(/每月([0-9一二两三四五六七八九十]{1,3})(?:号|日)/))) {
    eventType = 'monthly';
    const day = Math.max(1, Math.min(31, cnToInt(match[1])));
    parsedDate = { ...today, day: Math.min(day, daysInMonth(today.year, today.month)) };
  } else if ((match = recurrenceText.match(/每年([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)/))) {
    eventType = 'yearly';
    const month = Math.max(1, Math.min(12, cnToInt(match[1])));
    const day = Math.max(1, Math.min(31, cnToInt(match[2])));
    parsedDate = { year: today.year, month, day: Math.min(day, daysInMonth(today.year, month)) };
  }

  const parsedTimeRange = parseTimeRange(normalized);
  const parsedTime = parsedTimeRange ? parsedTimeRange[0] : parseAuthoritativeTime(normalized);
  const hasDate = parsedDate !== null;
  const hasTime = parsedTime !== null;
  if (!hasDate && !hasTime) return parseLowInformationNote(normalized, text, today);

  let [title, description] = extractTitleAndDescription(recurrenceText);
  if (!title) title = '待办';

  const startTime = parsedTime;
  const endTime = parsedTimeRange?.[1] ?? defaultEndTime(startTime);
  const actualStartDate = parsedDate ?? today;
  const effectiveEndDate = endDate && compareDate(endDate, actualStartDate) !== 0 ? endDate : null;
  const location = extractLocation(normalized);
  const category = inferCategory(title, normalized);
  let reminderMinutes = parseReminderMinutes(normalized);
  if (startTime && reminderMinutes === null && !wantsNoReminder(normalized)) reminderMinutes = 15;

  return {
    title: title.slice(0, 100),
    event_type: eventType,
    start_date: formatDate(actualStartDate),
    end_date: effectiveEndDate ? formatDate(effectiveEndDate) : null,
    color: null,
    spanning: Boolean(effectiveEndDate),
    start_time: startTime,
    end_time: endTime,
    is_all_day: startTime === null,
    description: description ? description.slice(0, 500) : null,
    location,
    category,
    detail: description ? description.slice(0, 1000) : null,
    status: null,
    reminder_minutes: reminderMinutes,
    raw_text: text,
    parse_source: 'rules',
    confidence: 0,
    needs_clarification: implicitLongRangeNeedsConfirmation || unresolvedDateRange || !hasDate || (!hasTime && !effectiveEndDate),
    clarification_question: implicitLongRangeNeedsConfirmation && effectiveEndDate
      ? `结束日期按 ${formatDate(effectiveEndDate)} 处理会形成跨年长日程，需要确认年份和起止顺序。`
      : unresolvedDateRange
      ? '听到了日期范围，但开始或结束日期不够清楚，需要确认完整的起止日期。'
      : (effectiveEndDate && !hasTime ? null : quickClarificationQuestion(hasDate, hasTime)),
  };
}

export function shouldUseLocalScheduleParseFirst(text: string, parsed: ParseResult | null): boolean {
  if (!parsed) return false;
  if (parsed.needs_clarification) return false;

  const normalized = normalizeScheduleText(text);
  if (SERVER_PARSE_REQUIRED_RE.test(normalized)) return false;
  if (COMPLEX_SCHEDULE_RE.test(normalized)) return false;

  const sentenceCount = normalized.split(/[。.!！?？]/).filter(Boolean).length;
  if (sentenceCount > 1) return false;
  if (normalized.length > 52) return false;
  const dateTokens = normalized.match(new RegExp(DATE_TOKEN, 'g')) ?? [];
  if (dateTokens.length >= 2 && /(到|至|直到|之间|[-—~～])/.test(normalized) && !parsed.end_date) return false;

  return Boolean(parsed.start_time || parsed.end_date || parsed.event_type !== 'once');
}

export function isNonScheduleControlText(text: string): boolean {
  return NON_SCHEDULE_CONTROL_RE.test(normalizeScheduleText(text));
}
