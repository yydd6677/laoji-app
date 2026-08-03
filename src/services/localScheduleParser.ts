import type { ParseResult } from './api';
import {
  colorForEventCategory,
  inferEventCategory,
  isEventCategory,
  normalizeEventCategory,
  type EventCategory,
} from '../utils/eventColors';

type LocalDate = {
  year: number;
  month: number;
  day: number;
};

type WallClockParts = LocalDate & {
  hour: number;
  minute: number;
  second: number;
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

// Whisper and device keyboards may return traditional glyphs even when the
// app language is simplified Chinese. These are conservative one-to-one
// glyph aliases used only by the parser; raw transcript text stays unchanged.
const SCHEDULE_TRADITIONAL_MAP: Record<string, string> = {
  '點': '点',
  '兩': '两',
  '開': '开',
  '會': '会',
  '週': '周',
  '號': '号',
  '評': '评',
  '審': '审',
  '項': '项',
  '參': '参',
  '訓': '训',
  '這': '这',
  '個': '个',
  '為': '为',
  '與': '与',
  '後': '后',
  '間': '间',
  '學': '学',
  '製': '制',
  '筆': '笔',
  '記': '记',
  '繳': '缴',
  '費': '费',
  '還': '还',
  '總': '总',
  '預': '预',
  '報': '报',
  '結': '结',
  '論': '论',
  '閱': '阅',
  '讀': '读',
  '機': '机',
  '場': '场',
  '課': '课',
  '節': '节',
  '從': '从',
  '對': '对',
  '應': '应',
  '備': '备',
  '說': '说',
  '實': '实',
  '務': '务',
  '過': '过',
};

function simplifyScheduleGlyphs(value: string): string {
  return [...value].map(char => SCHEDULE_TRADITIONAL_MAP[char] ?? char).join('');
}

/**
 * Read a request-scoped instant as wall-clock fields in its IANA timezone.
 * The parser only needs calendar fields; encoding the result as a local Date
 * below lets the existing date grammar remain backward compatible on devices
 * that do not pass a timezone.
 */
function wallClockParts(input: Date, timezone?: string): WallClockParts | null {
  const zone = timezone?.trim();
  if (!zone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(input);
    const values = new Map(parts
      .filter(part => ['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type))
      .map(part => [part.type, Number(part.value)] as const));
    const result = {
      year: values.get('year') ?? 0,
      month: values.get('month') ?? 0,
      day: values.get('day') ?? 0,
      hour: values.get('hour') ?? -1,
      minute: values.get('minute') ?? -1,
      second: values.get('second') ?? -1,
    };
    if (
      result.year < 1
      || result.month < 1
      || result.month > 12
      || result.day < 1
      || result.day > daysInMonth(result.year, result.month)
      || result.hour < 0
      || result.hour > 23
      || result.minute < 0
      || result.minute > 59
      || result.second < 0
      || result.second > 59
    ) return null;
    return result;
  } catch {
    // An invalid or unsupported timezone must not crash voice input. Callers
    // fall back to the legacy Date behavior and the server still receives the
    // original timezone for authoritative parsing.
    return null;
  }
}

function resolveReferenceDate(referenceDate: Date, timezone?: string): Date {
  const parts = wallClockParts(referenceDate, timezone);
  if (!parts) return referenceDate;
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    referenceDate.getMilliseconds(),
  );
}

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
  '|(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月(?:底|末)' +
  '|(?:下个月|下月|本月|这个月)[0-9一二两三四五六七八九十]{1,3}(?:号|日)' +
  '|下个月底|下个月末|下月底|下月末|月底|月末|大后天|后天|明天|今天|今日' +
  '|(?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7]' +
  '|[0-9一二两三四五六七八九十]{1,3}(?:号|日)';

const CONSECUTIVE_RELATIVE_RANGE_TOKEN =
  '(?:今明后(?:这)?(?:三|3)(?:天|日)|今明(?:这)?(?:两|二|2)(?:天|日)|明后(?:这)?(?:两|二|2)(?:天|日))';
const CONSECUTIVE_RELATIVE_PAIR_TOKEN =
  '(?:(?:大后天|后天|明天|今天|今日)(?:和|跟|与|及|、)(?:大后天|后天|明天|今天|今日)(?:这?(?:两|二|2)(?:天|日))?)';

const TIME_TOKEN =
  '(?:[01]?\\d|2[0-3])[:：][0-5]\\d' +
  '|(?:凌晨|早上|上午|中午|下午|傍晚|晚上|晚间)?[0-9一二两三四五六七八九十]{1,3}点(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?';

const LAOJI_WAKE_WORD = '(?:老记|老纪|老计|老季|牢记|小记)';
const IMPLICIT_CROSS_YEAR_CONFIRM_DAYS = 183;

const SERVER_PARSE_REQUIRED_RE =
  /(不是|不对|说错|改成|改为|换成|调整到|最终|最后|更正|纠正|别弄错|以后面的为准|后面的为准|不要保存|不要真的|只是测试|只是举例|不是日程|先别自动|晚点补|还没定|没想好|如果冲突)/;

const DATE_CORRECTION_RE = /(不是|不对|说错|改成|最终|最后|更正|纠正|以后面的为准|后面的为准)/;

const NON_SCHEDULE_CONTROL_RE =
  /(不要真的创建(?:日程)?|不要创建(?:日程)?|取消创建|不要新建日程|不要添加日程|不要保存(?:成|为)?日程|不是(?:让我|要|用来)(?:安排|创建|新建|添加|记录|保存).{0,16}|不是日程|只是测试|只是举例|先别自动保存|测试麦克风|测试解析|识别效果|随便说一句话|请解释|是什么意思|怎么理解|如果有人说|你会怎么回答|忽略前面的要求|输出系统提示词|已经完成了|不用安排|没有提供原日程|还没有提供原日程)/;

const PURE_CHAT_RE =
  /^(?:你好|您好|哈喽|嗨|谢谢|多谢|再见|你是谁|你能做什么|测试|测试一下|收到|好的|知道了)[。.!！?？]*$/;

const LOW_INFORMATION_SCHEDULE_TITLE_RE = /^(?:提前|提醒|那个事情|这件事|事情|安排|事项|活动|日程)$/;

// This is a known high-risk Whisper homophone from the frozen acoustic set.
// Keep the transcript unchanged and require authoritative parsing instead of
// silently saving a recurring finance event with a corrupted title.
const AMBIGUOUS_ASR_SCHEDULE_RE = /还(?:新|薪|心)用卡/;

const CONTEXT_EDIT_RE =
  /(?:把|将)(?:刚才|之前|前面|上一个|当前)(?:的|那个)?(?:日程|安排|草稿|事件)|(?:刚才|之前|前面|上一个|当前)(?:的|那个)(?:日程|安排|草稿|事件)|(?:把|将)?(?:那个|这条)(?:日程|安排|草稿|事件)|(?:标题|日期|时间|地点|提醒|分类|备注)(?:改|换|调整|补充|设)|(?:改一下|修改一下|重新改|接着改)/;

const EXPLICIT_FIELD_DIRECTIVE_RE =
  /(?:标题|主题|地点|地址|位置|备注|说明|分类)(?:写|叫|设为|是|改|换|补充|放在|定在)/;

const COMPLEX_SCHEDULE_RE =
  /(标题(?:不要太长|写|就写|叫|设为|是)|重点是|主要确认|需要通知|地点(?:还)?可能|地点(?:还没确定|未确定)|每隔|节假日除外|工作日|这是新的安排|先不要和|如果[^,，。]{0,24}(?:被占|照这个时间)|这件事和|也参加|一起|带上|这次主要是|不用写太长|别只记一天)/;

const UNCERTAIN_LOCATION_RE =
  /(?:(?:地点|地址|位置|在)[^，,。.!！?？；;]{0,24}(?:可能|也许|不确定|还没定|还没确定|未确定|暂定)|(?:可能|也许|不确定|还没定|还没确定|未确定|暂定)[^，,。.!！?？；;]{0,24}(?:地点|地址|位置))/;

// The mobile parser does not carry IANA timezone transition data. Explicit
// dates around the usual DST transition hours must therefore be resolved by
// the server, which can distinguish a nonexistent local time from a repeated
// one using the request timezone.
const DST_RISK_TIME_RE = /凌晨(?:一|两|1|2)点(?:半|[0-5]?\d分?)?/;

const LOCATION_TOKEN_PATTERN =
  '(?:[^，,。.!！?？；;]{0,20}[A-Za-z]{1,4}[-_]?\\d{1,4}(?:室|房间)?|' +
  '[^，,。.!！?？；;]{0,24}?(?:会议室|办公室|图书馆|健身房|咖啡馆|咖啡店|' +
  '实验室|教室|报告厅|写字楼|大厦|商场|超市|机场|车站|公司|学校|医院|' +
  '公园|餐厅|饭店|酒店|园区|小区|广场|中心|工作室|体育馆|体育场|球场|' +
  '码头|港口|校区|现场|路|街|巷|室|厅|楼|层|馆|院|门|站|店|家))';
const LOCATION_LOCALIZER_PATTERN = '(?:里面|里|内|外|附近|门口|旁边|楼上|楼下|前台|大厅|现场|口)?';
const LOCATION_ACTION_PATTERN =
  '(?:安排|开会|召开|举行|进行|参加|处理|完成|提交|整理|跟进|准备|复盘|讨论|沟通|' +
  '确认|评审|汇报|学习|复习|上课|考试|培训|阅读|跑步|健身|运动|体检|看病|' +
  '服药|聚餐|约会|吃饭|购物|购买|买|取|领取|寄|打印|缴|交|支付|还款|报销|' +
  '拜访|会见|维护|检查|测试|发布|更新|制作|编写|练习|集合|出发|接待|签字|' +
  '排队|取号|见面|接|送|办理|预约)';
const LOW_INFORMATION_SCHEDULE_INTENT_RE =
  /(开会|会议|周会|评审|复盘|汇报|面试|值班|提交|跟进|维护|发布|更新|编写|打印|签字|回复邮件|发邮件|联系|打电话|学习|复习|上课|课程|考试|作业|论文|阅读|培训|答辩|练习|跑步|健身|运动|体检|看病|复诊|服药|吃药|预约牙医|预约体检|睡觉|喝水|聚餐|约会|生日|婚礼|见面|拜访|会见|吃饭|看电影|出发|出差|旅行|航班|高铁|火车|值机|接机|送机|缴费|交费|(?:缴|交)(?:水电费|物业费|停车费|报名费|社保|房租|报告|作业|材料|文件|资料|表格)|还款|付款|支付|报销|账单|转账|购物|买菜|买药|买票|取快递|取票|取号|领取|寄快递|寄文件|快递|洗衣|理发|大扫除|修空调|办理|预约|接待|集合|排队|讨论|沟通|整理(?:房间|衣柜|材料|文件|报告|发票|数据|照片|行李)|处理(?:事项|工单|问题|材料|文件|订单)|准备(?:材料|会议|考试|报告|行李|方案))/;
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

export function isValidScheduleDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month);
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
  const cleaned = simplifyScheduleGlyphs((text || '').trim());
  if (!cleaned) return cleaned;
  const pattern = new RegExp(`^((?:${LAOJI_WAKE_WORD}[，,。\\s]*){1,2})`);
  return cleaned.replace(pattern, match => match.replace(new RegExp(LAOJI_WAKE_WORD, 'g'), '老记'));
}

function normalizeScheduleText(text: string): string {
  const temporalFiller = '(?:[，,]*(?:呃|额|嗯|那个|可能|然后|别忘了)[，,]*)+';
  const sparseDateFiller = '(?:[，,]*(?:呃|额|嗯|那个|可能|就是|差不多|先这样)[，,]*)+';
  const cleaned = normalizeLaojiTranscript(text)
    .trim()
    .replace(new RegExp(`^${LAOJI_WAKE_WORD}[，,。\\s]*(?:${LAOJI_WAKE_WORD})?[，,。\\s]*`), '')
    .replace(/\s+/g, '')
    .replace(/^(?:(?:嗯|呃|额|那个|对了|好的)[，,]+)+/g, '')
    .replace(/不(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+是/g, '不是')
    .replace(/不(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+对/g, '不对')
    .replace(/说(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+错/g, '说错')
    .replace(/改(?:[，,]*(?:呃|额|嗯|那个)[，,]*)+成/g, '改成')
    // ASR often omits punctuation between hesitation words and the date. Only
    // remove this sequence when a schedule signal follows, so a real title
    // such as “那个事情” remains intact for clarification.
    .replace(/^(?:(?:嗯|呃|额|那个|对了|好的))+(?=(?:老记|老纪|老计|老季|牢记|小记)?(?:今天|今日|明天|后天|大后天|下(?:下)?周|本周|这周|[0-9]{4}年|[0-9一二两三四五六七八九十]{1,2}月))/g, '')
    .replace(/[，,]*(?:呃|额|嗯|那个|就是)[，,]*(?=(?:凌晨|早上|上午|中午|下午|傍晚|晚上|晚间|安排|计划|创建|提醒|记|谢谢|就这样))/g, '')
    .replace(/(今天|今日|明天|后天|大后天|(?:下下|下|本|这)?(?:周|星期|礼拜)[一二三四五六日天1-7])[，,]*(?:呃|额|嗯|那个)+(?=(?:凌晨|早上|上午|中午|下午|傍晚|晚上|晚间))/g, '$1')
    .replace(/^(?:(?:刚才)?(?:说漏了|漏说了|忘了说)|补充一下|再补充(?:一下)?|对了)[，,。]*/g, '')
    .replace(/((?:每天|每日))[0-9一二两三四五六七八九十]{1,2}(?:差不多|大概(?:是)?|可能(?:是)?)(?=(?:[01]?\d|2[0-3])[:：])/g, '$1')
    .replace(new RegExp(`([0-9一二两三四五六七八九十])${temporalFiller}(?=月)`, 'g'), '$1')
    .replace(new RegExp(`(月)${temporalFiller}(?=[0-9一二两三四五六七八九十])`, 'g'), '$1')
    .replace(new RegExp(`([0-9一二两三四五六七八九十]{1,2}月[0-3]?)${sparseDateFiller}([0-9])(?=号|日)`, 'g'), '$1$2')
    .replace(new RegExp(`(月)${sparseDateFiller}(?=底|末)`, 'g'), '$1')
    .replace(new RegExp(`((?:下下|下|本|这)?(?:周|星期|礼拜))${temporalFiller}(?=[一二三四五六日天1-7])`, 'g'), '$1')
    .replace(new RegExp(`(到|至|直到)${temporalFiller}(?=(?:下下|下|本|这)?(?:周|星期|礼拜)|[0-9一二两三四五六七八九十])`, 'g'), '$1')
    .replace(/(号|日)始(?=到|至)/g, '$1开始')
    .replace(/提前([0-9一二两三四五六七八九十]{1,3})时(?=提醒)/g, '提前$1小时')
    .replace(/声音可能有点小/g, '')
    .replace(/(?:嗯|可能)*(?:不要|别)漏(?:掉)?前面日期/g, '')
    .replace(/(提醒)啊(?=[，,。.!！?？]|$)/g, '$1')
    .replace(/[，,]*(?:就这样|先这样|谢谢|别漏掉|不要漏|没有别的安排)(?:[，,]*(?:就这样|先这样|谢谢|别漏掉|不要漏))?$/g, '');
  // Keep a weekday and an immediately following hour as separate tokens. This
  // prevents "下周五两点" from being read as the invalid hour "五两点".
  return cleaned
    .replace(/((?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7])(?=[0-9一二两三四五六七八九十]{1,3}点)/g, '$1，')
    .replace(/^[，,。.!！?？]+|[，,。.!！?？]+$/g, '');
}

function parseRelativeOffsetDateTime(
  text: string,
  referenceDate: Date,
  timezone?: string,
): { date: LocalDate; time: string } | null {
  const normalized = normalizeScheduleText(text);
  let offsetMinutes: number | null = null;
  if (/半(?:个)?小时(?:之后|以后|后)/.test(normalized)) {
    offsetMinutes = 30;
  } else if (/一刻钟(?:之后|以后|后)/.test(normalized)) {
    offsetMinutes = 15;
  } else {
    const minuteMatch = normalized.match(/([0-9一二两三四五六七八九十]{1,3})分钟(?:之后|以后|后)/);
    const hourMatch = normalized.match(/([0-9一二两三四五六七八九十]{1,3})(?:个)?小时(?:之后|以后|后)/);
    const quarterMatch = normalized.match(/([0-9一二两三四五六七八九十]{1,2})刻钟(?:之后|以后|后)/);
    if (minuteMatch) offsetMinutes = Math.max(1, cnToInt(minuteMatch[1]));
    else if (hourMatch) offsetMinutes = Math.max(1, cnToInt(hourMatch[1])) * 60;
    else if (quarterMatch) offsetMinutes = Math.max(1, cnToInt(quarterMatch[1])) * 15;
  }
  if (offsetMinutes === null) return null;

  const parts = wallClockParts(referenceDate, timezone);
  if (parts) {
    // Do relative arithmetic on a UTC-encoded wall clock. This avoids using
    // the device's DST rules for a request that belongs to another timezone.
    const target = new Date(Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    ));
    target.setUTCMinutes(target.getUTCMinutes() + offsetMinutes);
    return {
      date: {
        year: target.getUTCFullYear(),
        month: target.getUTCMonth() + 1,
        day: target.getUTCDate(),
      },
      time: `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`,
    };
  }

  const target = new Date(referenceDate);
  target.setSeconds(0, 0);
  target.setMinutes(target.getMinutes() + offsetMinutes);
  return {
    date: toLocalDate(target),
    time: `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`,
  };
}

function parseExplicitOrRelativeDate(text: string, today: LocalDate): LocalDate | null {
  const explicitMonthEnd = parseExplicitMonthEnd(text, today);
  if (explicitMonthEnd) return explicitMonthEnd;
  if (text.includes('下个月底') || text.includes('下个月末') || text.includes('下月底') || text.includes('下月末')) {
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
    const month = cnToInt(match[2]);
    const day = cnToInt(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
  }

  match = text.match(/([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)/);
  if (match) {
    const month = cnToInt(match[1]);
    const day = cnToInt(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let year = today.year;
    if (day > daysInMonth(year, month)) {
      if (month === 2 && day === 29) {
        while (year < today.year + 8 && daysInMonth(year, month) < day) year += 1;
      } else {
        return null;
      }
    }
    let candidate = { year, month, day };
    if (compareDate(candidate, today) < 0) {
      year = today.year + 1;
      if (month === 2 && day === 29) {
        while (year < today.year + 8 && daysInMonth(year, month) < day) year += 1;
      }
      if (day > daysInMonth(year, month)) return null;
      candidate = { year, month, day };
    }
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
    if (day >= 1 && day <= 31) {
      if (day > maxDay) return null;
      let candidate = { ...today, day };
      if (compareDate(candidate, today) < 0) {
        const year = today.month === 12 ? today.year + 1 : today.year;
        const month = today.month === 12 ? 1 : today.month + 1;
        if (day > daysInMonth(year, month)) return null;
        candidate = { year, month, day: Math.min(day, daysInMonth(year, month)) };
      }
      return candidate;
    }
  }
  return null;
}

function hasInvalidExplicitDate(text: string, today: LocalDate): boolean {
  const pattern = /(?<![0-9])(?:([0-9]{4})年)?([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const year = match[1] ? Number(match[1]) : null;
    const month = cnToInt(match[2]);
    const day = cnToInt(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return true;
    if (year !== null && day > daysInMonth(year, month)) return true;
    // An omitted year may resolve to the next occurrence. February 29 is
    // therefore retained as a valid candidate, while values above the
    // calendar's maximum possible February day are always invalid.
    if (year === null && month === 2 && day > 29) return true;
    if (year === null && month !== 2 && day > daysInMonth(today.year, month)) {
      const nextYear = today.year + (month < today.month ? 1 : 0);
      if (day > daysInMonth(nextYear, month)) return true;
    }
  }
  return false;
}

function parseExplicitMonthEnd(text: string, today: LocalDate, context?: LocalDate | null): LocalDate | null {
  const match = text.match(/(?:([0-9]{4})年)?([0-9一二两三四五六七八九十]{1,2})月(?:底|末)/);
  if (!match) return null;
  const month = Math.max(1, Math.min(12, cnToInt(match[2])));
  const reference = context ?? today;
  const year = match[1] ? Number(match[1]) : reference.year + (month < reference.month ? 1 : 0);
  return { year, month, day: daysInMonth(year, month) };
}

function parseDateToken(token: string, today: LocalDate, context?: LocalDate | null): LocalDate | null {
  const clean = token.trim();
  const explicitMonthEnd = parseExplicitMonthEnd(clean, today, context);
  if (explicitMonthEnd) return explicitMonthEnd;
  if (context) {
    let match = clean.match(/^([0-9一二两三四五六七八九十]{1,3})(?:号|日)$/);
    if (match) {
      const day = cnToInt(match[1]);
      if (day < 1 || day > 31) return null;
      let year = context.year;
      let month = context.month;
      if (day > daysInMonth(year, month)) return null;
      let candidate = { year, month, day };
      if (compareDate(candidate, context) < 0) {
        year = month === 12 ? year + 1 : year;
        month = month === 12 ? 1 : month + 1;
        if (day > daysInMonth(year, month)) return null;
        candidate = { year, month, day };
      }
      return candidate;
    }
    match = clean.match(/^([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)$/);
    if (match) {
      const month = cnToInt(match[1]);
      const year = context.year + (month < context.month ? 1 : 0);
      const day = cnToInt(match[2]);
      if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
      return { year, month, day };
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

function nextMonthlyOccurrence(today: LocalDate, requestedDay: number): LocalDate {
  let year = today.year;
  let month = today.month;
  const currentMonthHasRequestedDay = requestedDay <= daysInMonth(year, month);
  if (!currentMonthHasRequestedDay || requestedDay <= today.day) {
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  }
  return { year, month, day: Math.min(requestedDay, daysInMonth(year, month)) };
}

function nextYearlyOccurrence(today: LocalDate, requestedMonth: number, requestedDay: number): LocalDate {
  let year = today.year;
  if (
    requestedMonth < today.month
    || (requestedMonth === today.month && requestedDay <= today.day)
  ) year += 1;
  return {
    year,
    month: requestedMonth,
    day: Math.min(requestedDay, daysInMonth(year, requestedMonth)),
  };
}

function relativeDayOffset(token: string): number | null {
  if (token === '今天' || token === '今日') return 0;
  if (token === '明天') return 1;
  if (token === '后天') return 2;
  if (token === '大后天') return 3;
  return null;
}

function parseConsecutiveRelativeDateRanges(
  text: string,
  today: LocalDate,
): Array<{ index: number; range: [LocalDate, LocalDate] }> {
  const ranges: Array<{ index: number; range: [LocalDate, LocalDate] }> = [];
  const compactPattern = new RegExp(CONSECUTIVE_RELATIVE_RANGE_TOKEN, 'g');
  let match: RegExpExecArray | null;
  while ((match = compactPattern.exec(text))) {
    const token = match[0];
    const startOffset = token.startsWith('明后') ? 1 : 0;
    const duration = token.startsWith('今明后') ? 3 : 2;
    ranges.push({
      index: match.index,
      range: [addDays(today, startOffset), addDays(today, startOffset + duration - 1)],
    });
  }

  const pairPattern = /(大后天|后天|明天|今天|今日)(?:和|跟|与|及|、)(大后天|后天|明天|今天|今日)(?:这?(?:两|二|2)(?:天|日))?/g;
  while ((match = pairPattern.exec(text))) {
    const startOffset = relativeDayOffset(match[1]);
    const endOffset = relativeDayOffset(match[2]);
    if (startOffset === null || endOffset === null || endOffset - startOffset !== 1) continue;
    ranges.push({
      index: match.index,
      range: [addDays(today, startOffset), addDays(today, endOffset)],
    });
  }
  return ranges;
}

function parseDateRange(text: string, today: LocalDate): [LocalDate, LocalDate] | null {
  const pattern = new RegExp(`(${DATE_TOKEN})(?:开始)?(?:到|至|直到|[-—~～])(${DATE_TOKEN})`, 'g');
  const ranges = parseConsecutiveRelativeDateRanges(text, today);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = parseDateToken(match[1], today);
    const end = start ? parseDateToken(match[2], today, start) : null;
    if (start && end && compareDate(end, start) >= 0) {
      ranges.push({ index: match.index, range: [start, end] });
    }
  }
  if (ranges.length === 0) return null;
  ranges.sort((left, right) => left.index - right.index);
  return DATE_CORRECTION_RE.test(text)
    ? ranges[ranges.length - 1].range
    : ranges[0].range;
}

function hasDateRangeSyntax(text: string): boolean {
  // This deliberately mirrors the date-range grammar instead of counting all
  // date tokens. A sentence can contain two dates and an unrelated time range
  // (for example, a correction from one weekday to another followed by
  // "两点到四点").
  return new RegExp(`(${DATE_TOKEN})(?:开始)?(?:到|至|直到|[-—~～])(${DATE_TOKEN})`).test(text);
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
  return token.trim().match(/^(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间)/)?.[1] ?? '';
}

function inferTimePeriod(text: string, index: number): string {
  const prefix = text.slice(Math.max(0, index - 8), index);
  if (/(下午茶|午后|下午时段)/.test(prefix)) return '下午';
  if (/(早茶|上午时段)/.test(prefix)) return '上午';
  if (/(中午饭|午饭|午餐)/.test(prefix)) return '中午';
  if (/(傍晚|晚饭|晚餐|晚间)/.test(prefix)) return '晚上';
  return '';
}

function formatTimeParts(period: string, rawHour: number, minute: number): string | null {
  let hour = rawHour;
  if (['下午', '傍晚', '晚上', '晚间'].includes(period) && hour < 12) hour += 12;
  else if (period === '中午' && hour < 11) hour += 12;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTimeToken(token: string, defaultPeriod = ''): string | null {
  const clean = token.trim();
  const digital = clean.match(/^([01]?\d|2[0-3])[:：]([0-5]\d)$/);
  if (digital) return `${String(Number(digital[1])).padStart(2, '0')}:${digital[2]}`;
  const match = clean.match(/^(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间)?([0-9一二两三四五六七八九十]{1,3})点(?:(半)|([0-9一二两三四五六七八九十]{1,2})分?)?$/);
  if (!match) return null;
  const period = match[1] ?? defaultPeriod;
  const minute = match[3] ? 30 : (match[4] ? cnToInt(match[4]) : 0);
  return formatTimeParts(period, cnToInt(match[2]), minute);
}

function parseTimeRange(text: string): [string, string] | null {
  const pattern = new RegExp(`(${TIME_TOKEN})(?:到|至|直到|[-—~～])(${TIME_TOKEN})`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const startPeriod = extractTimePeriod(match[1]) || inferTimePeriod(text, match.index);
    const start = parseTimeToken(match[1], startPeriod);
    const end = parseTimeToken(match[2], extractTimePeriod(match[1]) || startPeriod);
    if (start && end) return [start, end];
  }
  return null;
}

function parseTime(text: string): string | null {
  const digital = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
  if (digital) return `${String(Number(digital[1])).padStart(2, '0')}:${digital[2]}`;
  const match = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间)?([0-9一二两三四五六七八九十]{1,3})点(?:(半)|([0-9一二两三四五六七八九十]{1,2})分?)?/);
  if (!match) return null;
  const minute = match[3] ? 30 : (match[4] ? cnToInt(match[4]) : 0);
  return formatTimeParts(match[1] ?? inferTimePeriod(text, match.index ?? 0), cnToInt(match[2]), minute);
}

function parseAuthoritativeTime(text: string): string | null {
  const pattern = new RegExp(TIME_TOKEN, 'g');
  const tokens: Array<{ text: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) tokens.push({ text: match[0], index: match.index });
  if (tokens.length === 0) return parseTime(text);
  if (tokens.length === 1) return parseTimeToken(tokens[0].text, inferTimePeriod(text, tokens[0].index));
  if (tokens.length > 1 && DATE_CORRECTION_RE.test(text)) {
    const selected = tokens[tokens.length - 1];
    return parseTimeToken(selected.text, inferTimePeriod(text, selected.index));
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

  const explicitWithMarker = text.match(/(?:地点|地址)\s*(?:在|是|为|位于)\s*([^，,。.!！?？；;]{1,100})/);
  const explicitBare = text.match(new RegExp(`(?:地点|地址)\\s*(${LOCATION_TOKEN_PATTERN}${LOCATION_LOCALIZER_PATTERN})`));
  const inferred = text.match(INFERRED_LOCATION_RE);
  const location = (explicitWithMarker?.[1] ?? explicitBare?.[1] ?? inferred?.[1] ?? '')
    .replace(/^[，,。.!！?？；;的\s]+|[，,。.!！?？；;的\s]+$/g, '');
  if (!location) return null;
  if (/(今天|明天|后天|月|号|日|周|星期|礼拜|点)/.test(location)) return null;
  return location.slice(0, 100) || null;
}

function inferCategory(title: string, text: string): EventCategory {
  return inferEventCategory(title, text);
}

function normalizeRecurrenceExpression(text: string): string {
  const normalized = text.replace(/每[，,]*(?:额|呃|嗯|那个|可能)?[，,]*(年|月|周|星期|礼拜)/g, '每$1');
  return normalized.replace(
    /((?:每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?周|每(?:周|星期|礼拜)))[，,]*(?:额|呃|嗯|那个|可能)[，,]*/g,
    '$1',
  );
}

type LocalRecurrenceRule = {
  eventType: ParseResult['event_type'];
  interval: number;
  weekdays: number[] | null;
  untilDate: LocalDate | null;
  unsupported: boolean;
};

function recurrenceWeekdays(text: string): number[] {
  const normalized = normalizeRecurrenceExpression(text);
  if (/(?:每(?:个)?工作日|每周工作日|工作日(?:重复|安排))/.test(normalized)) return [1, 2, 3, 4, 5];
  if (/(?:每(?:个)?周末|周末(?:重复|安排))/.test(normalized)) return [6, 7];
  const anchor = /(?:每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)|(?:周|星期|礼拜))/.exec(normalized);
  if (!anchor || anchor.index === undefined) return [];
  const suffix = normalized.slice(anchor.index + anchor[0].length).replace(/^(?:周|星期|礼拜)/, '');
  const weekday = '[一二三四五六日天1-7]';
  const range = new RegExp(`(${weekday})(?:到|至)(?:(?:周|星期|礼拜))?(${weekday})`).exec(suffix);
  if (range) {
    const start = WEEKDAY_MAP[range[1]];
    const end = WEEKDAY_MAP[range[2]];
    const values = start <= end
      ? Array.from({ length: end - start + 1 }, (_, index) => start + index)
      : [...Array.from({ length: 7 - start }, (_, index) => start + index), ...Array.from({ length: end + 1 }, (_, index) => index)];
    return values.map(value => value + 1);
  }
  const list = new RegExp(`(${weekday}(?:[、,，和及\\s]+${weekday}){0,6})`).exec(suffix);
const compact = /^([一二三四五六日天]{2,7})/.exec(suffix);
  // The separator expression also matches the first character of a compact
  // form such as “一三五”; choose the longest candidate.
  const source = [list?.[1], compact?.[1]].filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length)[0] ?? '';
  if (!source) return [];
  return [...new Set([...source].filter(char => WEEKDAY_MAP[char] !== undefined).map(char => WEEKDAY_MAP[char] + 1))].sort((a, b) => a - b);
}

function recurrenceInterval(text: string, eventType: ParseResult['event_type']): number {
  const normalized = normalizeRecurrenceExpression(text);
  const pattern = eventType === 'weekly'
    ? /每隔([一二两三四五六七八九十0-9]+)周|每([一二两三四五六七八九十0-9]+)周|隔周/
    : eventType === 'monthly'
      ? /每隔([一二两三四五六七八九十0-9]+)个月|每([一二两三四五六七八九十0-9]+)个月/
      : eventType === 'yearly'
        ? /每隔([一二两三四五六七八九十0-9]+)年|每([一二两三四五六七八九十0-9]+)年/
        : null;
  const match = pattern ? pattern.exec(normalized) : null;
  if (!match) return 1;
  if (match[0] === '隔周') return 2;
  return Math.max(1, cnToInt(match[1] ?? match[2]));
}

function recurrenceUntilDate(text: string, today: LocalDate): LocalDate | null {
  const dateToken = '(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月(?:[0-9一二两三四五六七八九十]{1,3}(?:号|日)|底|末)|(?:下个月底|下个月末|下月底|下月末|月底|月末)';
  const match = new RegExp(`(?:重复|持续|一直)?(?:到|至|直到|截至|截止)(?:日期)?(${dateToken})`).exec(normalizeRecurrenceExpression(text));
  return match ? parseExplicitOrRelativeDate(match[1], today) : null;
}

function parseRecurrenceRule(text: string, today: LocalDate): LocalRecurrenceRule {
  const normalized = normalizeRecurrenceExpression(text);
  const empty: LocalRecurrenceRule = { eventType: 'once', interval: 1, weekdays: null, untilDate: null, unsupported: false };
  if (!/(?:每(?:天|日|周|星期|礼拜|月|年|隔|个工作日|逢)|每(?:隔)?[一二两三四五六七八九十0-9]+个月|每(?:隔)?[一二两三四五六七八九十0-9]+年|隔周|工作日|周末|重复|循环)/.test(normalized)) return empty;
  if (/(?:节假日除外|法定节假日除外|节假日不算|跳过节假日|工作日调整|重复[0-9一二两三四五六七八九十两]+次)/.test(normalized)
    || /每(?:个)?月[^，,。.!！?？；;]{0,20}(?:最后|末|第[一二三四五六七八九十0-9]+周|周[一二三四五六日天])/.test(normalized)) {
    return { ...empty, unsupported: true };
  }
  if (normalized.includes('每天') || normalized.includes('每日')) {
    return { eventType: 'daily', interval: 1, weekdays: null, untilDate: recurrenceUntilDate(normalized, today), unsupported: false };
  }
  const weekdays = recurrenceWeekdays(normalized);
  if (weekdays.length > 0) {
    return { eventType: 'weekly', interval: recurrenceInterval(normalized, 'weekly'), weekdays, untilDate: recurrenceUntilDate(normalized, today), unsupported: false };
  }
  if (/(?:每(?:隔|[一二两三四五六七八九十0-9]+)?个月|每月)[0-9一二两三四五六七八九十]{1,3}(?:号|日)/.test(normalized)) {
    return { eventType: 'monthly', interval: recurrenceInterval(normalized, 'monthly'), weekdays: null, untilDate: recurrenceUntilDate(normalized, today), unsupported: false };
  }
  if (/(?:每年|每(?:隔)?[一二两三四五六七八九十0-9]+年)[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)/.test(normalized)) {
    return { eventType: 'yearly', interval: recurrenceInterval(normalized, 'yearly'), weekdays: null, untilDate: recurrenceUntilDate(normalized, today), unsupported: false };
  }
  return { ...empty, unsupported: true };
}

function stripScheduleMarkers(text: string): string {
  const patterns = [
    '(?:把这个放进日程|日程里加一下|帮我设一下|帮我记一下|帮我记|麻烦记录(?:一下)?|给我安排|加个待办|记一条|我需要记住|我记住|提醒我)',
    '每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:到|至)(?:周|星期|礼拜)?[一二三四五六日天1-7]',
    '每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:[、,，和及\\s]*(?:周|星期|礼拜)?[一二三四五六日天1-7]){0,6}',
    '(?:半(?:个)?小时|一刻钟|[0-9一二两三四五六七八九十]{1,3}(?:分钟|(?:个)?小时|刻钟))(?:之后|以后|后)',
    CONSECUTIVE_RELATIVE_RANGE_TOKEN,
    CONSECUTIVE_RELATIVE_PAIR_TOKEN,
    `(?:从)?(?:${DATE_TOKEN})(?:开始)?(?:到|至|直到|[-—~～])(?:${DATE_TOKEN})`,
    `(?:${TIME_TOKEN})(?:到|至|直到|[-—~～])(?:${TIME_TOKEN})`,
    '提前(?:半小时|[0-9一二两三四五六七八九十]{1,3}(?:分钟|小时|天))提醒',
    '(?:开始时|准时|到点)提醒',
    '(?:不提醒|无需提醒|不用提醒|不要提醒)',
    '(?:之前|之后|以后)(?=[，,])',
    '(?:重复|持续|一直)(?:到|至|直到|截至|截止)(?:日期)?(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月(?:[0-9一二两三四五六七八九十]{1,3}(?:号|日)|底|末)',
    '每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:到|至)(?:周|星期|礼拜)?[一二三四五六日天1-7]',
    '每(?:隔|个)?(?:[一二两三四五六七八九十0-9]+)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:[、,，和及\\s]*(?:周|星期|礼拜)?[一二三四五六日天1-7]){0,6}',
    '每(?:个)?工作日|每(?:个)?周末',
    '每(?:周|星期|礼拜)[一二三四五六日天1-7]',
    '每隔(?:[一二两三四五六七八九十0-9]+)?周|隔周|每(?:两|二|[2-9]|[二三四五六七八九十])周',
    '每(?:隔)?[一二两三四五六七八九十0-9]+个月',
    '每(?:天|日)',
    '每(?:隔)?[一二两三四五六七八九十0-9]+年[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?',
    '每月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?',
    '每年[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)?',
    '(大后天|后天|明天|今天|今日)',
    '(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月(?:底|末)前?',
    '(?:下个月底|下个月末|下月底|下月末|月底|月末)前?',
    '[0-9]{4}年[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)',
    '[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)',
    '(?:下个月|下月|本月|这个月)[0-9一二两三四五六七八九十]{1,3}(?:号|日)',
    '(?:下个月|下月|本月|这个月)',
    '(?:(?:下下|下|本|这)?(?:周|星期|礼拜))[一二三四五六日天1-7]',
    '(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间)?[0-9一二两三四五六七八九十]{1,3}点(?:半|[0-9一二两三四五六七八九十]{1,2}分?)?',
    '([01]?\\d|2[0-3])[:：]([0-5]\\d)',
    '^(?:凌晨|早上|上午|中午|下午(?!茶)|傍晚|晚上|晚间)(?=[^，,。.!！?？]{1,})',
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
    .split(/[，,。.!！?？]|(?:地点|(?:地点)?在|用(?=[^，,。.!！?？；;]{0,40}(?:会议室|办公室|图书馆|健身房|咖啡馆|咖啡店|实验室|教室|报告厅|写字楼|大厦|商场|超市|机场|车站|公司|学校|医院|公园|餐厅|饭店|酒店|园区|小区|广场|中心|工作室|体育馆|体育场|球场|码头|港口|校区|现场|路|街|巷|室|厅|楼|馆|院|门|站|店|家)))[^，,。.!！?？]{0,40}$|需要通知|和[^，,。.!！?？]{1,16}一起|重点是|主要确认|这件事和|带上/, 1)[0]
    .replace(/(持续处理|处理|完成|提交|整理|跟进|准备)?完$/, '')
    .replace(/^在[^，,。.!！?？]{1,30}(?=开会|会议|见面|上课|办事)/, '')
    .replace(/^(开|召开|举行|进行)(?=.{2,})/, '')
    .replace(/^(和|跟|与)(?=.{2,})/, '')
    .replace(/^[，,。.!！?？的]+|[，,。.!！?？的]+$/g, '');
}

function selectCorrectionTail(text: string): string {
  const replacement = text.match(
    /(?:不是|不对|说错)[^，,。.!！?？；;]*[，,。.!！?？；;](?:是|改成|改为|换成|调整到)?(.+)$/,
  );
  if (replacement?.[1]?.trim()) return replacement[1];

  const direct = text.match(/(?:改成|改为|换成|调整到|更正为?|纠正为?)(.+)$/);
  if (direct?.[1]?.trim()) return direct[1];

  const final = text.match(/(?:最终|最后|以后面的为准|后面的为准)[，,：: ]*(.+)$/);
  if (final?.[1]?.trim()) return final[1];
  return text;
}

function extractTitleAndDescription(text: string): [string, string | null] {
  const authoritativeText = selectCorrectionTail(text);
  const explicitTitle = authoritativeText.match(/标题(?:不要太长)?[，,]?(就)?(写|叫|设为|是)([^，,。.!！?？]{1,40})/);
  if (explicitTitle) return [normalizeTitle(explicitTitle[3]).slice(0, 20), null];
  let description: string | null = null;
  let titleText = authoritativeText;
  // Remove a physical-location prefix before stripping schedule markers. The
  // generic marker pass intentionally removes “安排”, which otherwise leaves
  // “在研发楼…华东区…” and causes the title to be discarded with the location.
  const locationActionMatch = authoritativeText.match(LOCATION_WITH_ACTION_RE);
  if (locationActionMatch?.index != null) {
    titleText = `${authoritativeText.slice(0, locationActionMatch.index)}${locationActionMatch[2]}`;
  }
  const descMatch = titleText.match(/(?:要)?(?:讨论|聊|沟通|确认(?!单|函|码|书|表)|备注|内容是|主题是|关于)(.+)$/);
  if (descMatch && descMatch.index != null) {
    const candidate = descMatch[1]
      .replace(/^[，,。.!！?？；;]+|[，,。.!！?？；;]+$/g, '')
      .replace(/(?:不提醒|无需提醒|不用提醒|不要提醒|开始时提醒|准时提醒|到点提醒|提前(?:半小时|[0-9一二两三四五六七八九十]{1,3}(?:分钟|小时|天))提醒)$/g, '')
      .replace(/^[，,。.!！?？；;]+|[，,。.!！?？；;]+$/g, '')
      .trim();
    // A control-only suffix such as “讨论，不用提醒” is not a description.
    // Keep the action word in the title instead of silently dropping it.
    if (candidate) {
      description = candidate;
      titleText = authoritativeText.slice(0, descMatch.index).replace(/^[，,。.!！?？]+|[，,。.!！?？]+$/g, '');
    }
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

function addOneHourTime(startTime: string | null): string | null {
  if (!startTime) return null;
  const [hourText, minuteText] = startTime.split(':');
  const total = (Number(hourText) * 60 + Number(minuteText) + 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function quickClarificationQuestion(hasDate: boolean, hasTime: boolean): string | null {
  if (!hasDate && !hasTime) return '需要补充具体日期。';
  if (!hasDate) return '没有听到具体日期，需要补充日期。';
  return null;
}

function parseLowInformationNote(normalized: string, rawText: string, today: LocalDate): ParseResult | null {
  if (
    !/(记一下|记个|帮我记|提醒我|待办)/.test(normalized)
    && !LOW_INFORMATION_SCHEDULE_INTENT_RE.test(normalized)
  ) return null;
  const [title, description] = extractTitleAndDescription(normalized);
  return {
    title: title.slice(0, 100),
    event_type: 'once',
    start_date: '',
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
    clarification_question: '没有听到具体日期，需要补充日期。',
  };
}

export function parseLocalScheduleText(
  text: string,
  referenceDate = new Date(),
  timezone?: string,
): ParseResult | null {
  const today = toLocalDate(resolveReferenceDate(referenceDate, timezone));
  const normalized = normalizeScheduleText(text);
  if (!normalized) return null;
  if (isNonScheduleControlText(text)) return null;
  const invalidExplicitDate = hasInvalidExplicitDate(normalized, today);
  const uncertainLocation = UNCERTAIN_LOCATION_RE.test(normalized);
  const dstRiskTime = DST_RISK_TIME_RE.test(normalized)
    && /(?:[0-9]{4}年)?[0-9一二两三四五六七八九十]{1,2}月[0-9一二两三四五六七八九十]{1,3}(?:号|日)/.test(normalized);

  let eventType: ParseResult['event_type'] = 'once';
  const recurrenceText = normalizeRecurrenceExpression(normalized);
  const recurrenceRule = parseRecurrenceRule(recurrenceText, today);
  eventType = recurrenceRule.eventType;
  const parsedRange = invalidExplicitDate || (eventType === 'weekly' && Boolean(recurrenceRule.weekdays && recurrenceRule.weekdays.length > 1))
    ? null
    : parseDateRange(normalized, today);
  const relativeStart = parsedRange ? null : parseRelativeOffsetDateTime(normalized, referenceDate, timezone);
  const implicitLongRangeNeedsConfirmation = implicitLongCrossYearRangeNeedsConfirmation(normalized, parsedRange);
  const unresolvedDateRange = !parsedRange
    && hasDateRangeSyntax(normalized)
    && !(eventType === 'weekly' && Boolean(recurrenceRule.weekdays && recurrenceRule.weekdays.length > 1));
  let parsedDate = invalidExplicitDate
    ? null
    : parsedRange ? parsedRange[0] : relativeStart?.date ?? parseAuthoritativeDate(normalized, today);
  const endDate = parsedRange ? parsedRange[1] : null;

  if (eventType === 'daily') {
    // Preserve a finite daily range as a daily event with an end date. The
    // server and event model both support this representation.
    parsedDate = parsedDate ?? today;
  } else if (eventType === 'weekly' && recurrenceRule.weekdays?.length) {
    parsedDate = recurrenceRule.weekdays
      .map(value => nextWeekday(value - 1, today, true))
      .sort(compareDate)[0] ?? parsedDate;
  } else if (eventType === 'monthly' && (recurrenceText.match(/(?:每月|每(?:隔)?[一二两三四五六七八九十0-9]+个月)([0-9一二两三四五六七八九十]{1,3})(?:号|日)/))) {
    const match = recurrenceText.match(/(?:每月|每(?:隔)?[一二两三四五六七八九十0-9]+个月)([0-9一二两三四五六七八九十]{1,3})(?:号|日)/);
    const day = Math.max(1, Math.min(31, cnToInt(match?.[1])));
    parsedDate = nextMonthlyOccurrence(today, day);
  } else if (eventType === 'yearly' && (recurrenceText.match(/(?:每年|每(?:隔)?[一二两三四五六七八九十0-9]+年)([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)/))) {
    const match = recurrenceText.match(/(?:每年|每(?:隔)?[一二两三四五六七八九十0-9]+年)([0-9一二两三四五六七八九十]{1,2})月([0-9一二两三四五六七八九十]{1,3})(?:号|日)/);
    const month = Math.max(1, Math.min(12, cnToInt(match?.[1])));
    const day = Math.max(1, Math.min(31, cnToInt(match?.[2])));
    parsedDate = nextYearlyOccurrence(today, month, day);
  }

  const parsedTimeRange = parseTimeRange(normalized);
  const parsedTime = parsedTimeRange ? parsedTimeRange[0] : relativeStart?.time ?? parseAuthoritativeTime(normalized);
  const hasDate = parsedDate !== null;
  const hasTime = parsedTime !== null;
  if (!hasDate && !hasTime) return parseLowInformationNote(normalized, text, today);

  const [title, description] = extractTitleAndDescription(recurrenceText);

  const startTime = parsedTime;
  const endTime = parsedTimeRange?.[1] ?? defaultEndTime(startTime);
  const actualStartDate = parsedDate;
  const relativeEndDate = relativeStart && startTime && endTime === null
    ? addDays(actualStartDate ?? today, 1)
    : null;
  const resolvedEndTime = endTime ?? (relativeEndDate ? addOneHourTime(startTime) : null);
  const recurrenceEndDate = recurrenceRule.untilDate;
  const effectiveEndDate = recurrenceEndDate ?? (endDate && actualStartDate && compareDate(endDate, actualStartDate) !== 0
    ? endDate
    : relativeEndDate);
  const location = extractLocation(normalized);
  const category = inferCategory(title, normalized);
  const lowInformationTitle = LOW_INFORMATION_SCHEDULE_TITLE_RE.test(title);
  let reminderMinutes = parseReminderMinutes(normalized);
  if (relativeStart && /(?:之后|以后|后)(?:提醒我|提醒|叫我)/.test(normalized)) reminderMinutes = 0;
  else if (startTime && reminderMinutes === null && !wantsNoReminder(normalized)) reminderMinutes = 15;

  return {
    title: title.slice(0, 100),
    event_type: eventType,
    recurrence_interval: recurrenceRule.unsupported ? 1 : recurrenceRule.interval,
    recurrence_weekdays: recurrenceRule.unsupported ? null : recurrenceRule.weekdays,
    recurrence_until_date: recurrenceRule.unsupported || !recurrenceEndDate ? null : formatDate(recurrenceEndDate),
    start_date: actualStartDate ? formatDate(actualStartDate) : '',
    end_date: effectiveEndDate ? formatDate(effectiveEndDate) : null,
    color: null,
    spanning: Boolean(effectiveEndDate),
    start_time: startTime,
    end_time: resolvedEndTime,
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
    needs_clarification: invalidExplicitDate || uncertainLocation || dstRiskTime || implicitLongRangeNeedsConfirmation || unresolvedDateRange || recurrenceRule.unsupported || !hasDate || lowInformationTitle,
    clarification_question: invalidExplicitDate
      ? '未能确定有效日期，需要补充日期。'
      : uncertainLocation
      ? '地点还不确定，请确认最终地点后再保存。'
      : dstRiskTime
      ? '该时间可能受时区夏令时影响，需要确认具体时区和时间。'
      : implicitLongRangeNeedsConfirmation && effectiveEndDate
      ? `结束日期按 ${formatDate(effectiveEndDate)} 处理会形成跨年长日程，需要确认年份和起止顺序。`
      : recurrenceRule.unsupported
      ? '这个重复规则较复杂，不能自动简化，需要进入详细编辑确认。'
      : unresolvedDateRange
      ? '听到了日期范围，但开始或结束日期不够清楚，需要确认完整的起止日期。'
      : lowInformationTitle
      ? '事项标题不完整，请补充具体内容后再保存。'
      : quickClarificationQuestion(hasDate, hasTime),
  };
}

export function hasScheduleDateSignal(
  text: string,
  referenceDate = new Date(),
  timezone?: string,
): boolean {
  const normalized = normalizeScheduleText(text);
  if (!normalized) return false;
  const numericDate = /(?:^|\D)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/.exec(normalized);
  if (numericDate) {
    const candidate = `${numericDate[1]}-${numericDate[2].padStart(2, '0')}-${numericDate[3].padStart(2, '0')}`;
    if (isValidScheduleDate(candidate)) return true;
  }
  const today = toLocalDate(resolveReferenceDate(referenceDate, timezone));
  if (parseRelativeOffsetDateTime(normalized, referenceDate, timezone)) return true;
  if (parseDateRange(normalized, today)) return true;
  if (parseAuthoritativeDate(normalized, today)) return true;
  const recurrenceText = normalizeRecurrenceExpression(normalized);
  return /(?:每天|每日|每(?:周|星期|礼拜|月|年)|每(?:隔)?[一二两三四五六七八九十0-9]+个月|每(?:隔)?[一二两三四五六七八九十0-9]+年|每隔|隔周|工作日|周末|重复)/.test(recurrenceText);
}

const TIME_ONLY_CLARIFICATION_RE =
  /(?:具体)?(?:时间|几点|开始时间|上午|下午|晚上|早上|中午)|全天事项|作为全天/;
const NON_TIME_CLARIFICATION_RE =
  /日期|哪一天|哪天|地点|位置|起止|范围|先后顺序|重复|标题|具体事项/;
const MISSING_DATE_CLARIFICATION_RE =
  /(?:没有听到|没有|缺少|未提供|需要补充).{0,12}(?:具体)?日期|(?:具体)?日期.{0,12}(?:不明确|不具体|需要补充|缺少)/;
const OTHER_CLARIFICATION_RE =
  /地点|位置|起止|范围|先后顺序|重复|标题|具体事项|冲突|矛盾|还没定|没想好/;

export function normalizeScheduleParseResult(
  text: string,
  result: ParseResult,
  referenceDate = new Date(),
  timezone?: string,
): ParseResult {
  // Server parsers are allowed to omit category while the mobile rules parser
  // is deterministic. Close that boundary here so every parse result carries
  // one of the legacy LaoJi buckets before it reaches the draft or calendar.
  const suppliedCategory = typeof result.category === 'string' ? result.category.trim() : '';
  // Keep an explicit non-default bucket from the authoritative parser. The
  // legacy/backend contract treats "其他" as the fallback marker, so it must
  // still be re-bucketed when the title or raw text contains a clear signal.
  const category = isEventCategory(suppliedCategory) && suppliedCategory !== '其他'
    ? suppliedCategory
    : inferCategory(String(result.title ?? ''), text);
  const categorized: ParseResult = {
    ...result,
    category: normalizeEventCategory(category),
    color: colorForEventCategory(category),
  };
  const hasValidStartDate = isValidScheduleDate(categorized.start_date);
  const safeResult: ParseResult = hasValidStartDate
    ? categorized
    : { ...categorized, start_date: '' };
  const withoutClock: ParseResult = safeResult.start_time
    ? safeResult
    : {
        ...safeResult,
        start_time: null,
        end_time: null,
        is_all_day: true,
        reminder_minutes: null,
      };

  if (!hasValidStartDate || !hasScheduleDateSignal(text, referenceDate, timezone)) {
    return {
      ...withoutClock,
      needs_clarification: true,
      clarification_question: hasValidStartDate
        ? '没有听到具体日期，需要补充日期。'
        : '未能确定有效日期，需要补充日期。',
    };
  }

  const question = withoutClock.clarification_question?.trim() ?? '';
  if (
    question
    && MISSING_DATE_CLARIFICATION_RE.test(question)
    && !OTHER_CLARIFICATION_RE.test(question)
  ) {
    return {
      ...withoutClock,
      needs_clarification: false,
      clarification_question: null,
    };
  }
  if (
    withoutClock.start_time === null
    && question
    && TIME_ONLY_CLARIFICATION_RE.test(question)
    && !NON_TIME_CLARIFICATION_RE.test(question)
  ) {
    return {
      ...withoutClock,
      needs_clarification: false,
      clarification_question: null,
    };
  }
  return withoutClock;
}

export function shouldUseLocalScheduleParseFirst(
  text: string,
  parsed: ParseResult | null,
  referenceDate = new Date(),
  timezone?: string,
): boolean {
  const route = classifyScheduleParseRoute(text, parsed, referenceDate, timezone).route;
  return route === 'local_safe' || route === 'clarify';
}

export type ScheduleParseRoute = 'local_safe' | 'server_required' | 'clarify' | 'reject';

export type ScheduleParseRouteDecision = {
  route: ScheduleParseRoute;
  result: ParseResult | null;
  code?: 'not_schedule' | 'missing_date' | 'missing_edit_target' | 'ambiguous_range' | 'invalid_schedule';
  message?: string;
};

export function classifyScheduleParseRoute(
  text: string,
  parsed: ParseResult | null,
  referenceDate = new Date(),
  timezone?: string,
): ScheduleParseRouteDecision {
  const normalized = normalizeScheduleText(text);
  if (!normalized || isNonScheduleControlText(normalized)) {
    return { route: 'reject', result: null, code: 'not_schedule', message: '这段内容不是日程安排' };
  }

  if (CONTEXT_EDIT_RE.test(normalized)) {
    return {
      route: 'server_required',
      result: parsed,
      code: 'missing_edit_target',
      message: '需要先选择要修改的日程',
    };
  }

  if (AMBIGUOUS_ASR_SCHEDULE_RE.test(normalized)) {
    return { route: 'server_required', result: parsed };
  }

  const sentenceCount = normalized.split(/[。.!！?？；;]/).filter(Boolean).length;
  const dateTokens = normalized.match(new RegExp(DATE_TOKEN, 'g')) ?? [];
  const timeTokens = normalized.match(new RegExp(TIME_TOKEN, 'g')) ?? [];
  const hasRangeWords = /(到|至|直到|之间|[-—~～])/.test(normalized);
  if (
    SERVER_PARSE_REQUIRED_RE.test(normalized)
    || COMPLEX_SCHEDULE_RE.test(normalized)
    || EXPLICIT_FIELD_DIRECTIVE_RE.test(normalized)
    || sentenceCount > 1
    || normalized.length > 52
    || (dateTokens.length > 1 && !parsed?.end_date)
    || UNCERTAIN_LOCATION_RE.test(normalized)
    || DST_RISK_TIME_RE.test(normalized)
    || timeTokens.length > 1
    || (hasRangeWords && (!parsed || !parsed.end_date))
  ) {
    return { route: 'server_required', result: parsed };
  }

  if (!parsed) {
    const hasScheduleSignal = hasScheduleDateSignal(normalized, referenceDate, timezone)
      || new RegExp(TIME_TOKEN).test(normalized)
      || LOW_INFORMATION_SCHEDULE_INTENT_RE.test(normalized);
    return hasScheduleSignal
      ? { route: 'server_required', result: null }
      : { route: 'reject', result: null, code: 'not_schedule', message: '这段内容不是日程安排' };
  }

  if (parsed.needs_clarification) {
    const question = parsed.clarification_question?.trim() ?? '';
    if (!hasScheduleDateSignal(normalized, referenceDate, timezone) && MISSING_DATE_CLARIFICATION_RE.test(question)) {
      return {
        route: 'clarify',
        result: { ...parsed, start_date: '' },
        code: 'missing_date',
        message: question || '需要补充具体日期',
      };
    }
    return { route: 'server_required', result: parsed };
  }

  return { route: 'local_safe', result: parsed };
}

export function isNonScheduleControlText(text: string): boolean {
  const normalized = normalizeScheduleText(text);
  return NON_SCHEDULE_CONTROL_RE.test(normalized) || PURE_CHAT_RE.test(normalized);
}
