import { withAlpha } from '../theme/colors';

export const EVENT_CATEGORIES = ['工作', '学习', '健康', '生活', '社交', '出行', '财务', '重要', '其他'] as const;
export type EventCategory = typeof EVENT_CATEGORIES[number];

// [PRODUCT] These are LaoJi's established semantic event-bucket colors.
// They intentionally do not read the page theme: a schedule keeps its type
// color when the user switches between 标准 and 绚彩.
const CATEGORY_COLORS: Readonly<Record<EventCategory, string>> = Object.freeze({
  工作: '#5B8CFF',
  学习: '#52C41A',
  健康: '#26C6DA',
  生活: '#7B5CB8',
  社交: '#FF8FAB',
  出行: '#FF9500',
  财务: '#9B59B6',
  重要: '#FF4D4F',
  其他: '#B8B4D4',
});

// Text uses the same category hue with enough contrast on the pale fill.
// Keeping this separate from the page text token prevents a vivid/neutral
// theme switch from changing the meaning of an existing event.
const CATEGORY_TEXT_COLORS: Readonly<Record<EventCategory, string>> = Object.freeze({
  工作: '#315DB8',
  学习: '#27751F',
  健康: '#147D89',
  生活: '#573A87',
  社交: '#B44770',
  出行: '#A65D00',
  财务: '#713B87',
  重要: '#B8272D',
  其他: '#77728A',
});

// Keep the original LaoJi precedence: explicit urgency first, then the
// activity domain. Title is checked before the rest of the sentence by the
// exported classifier so a location or participant cannot steal the bucket.
const CATEGORY_RULES: ReadonlyArray<readonly [EventCategory, RegExp]> = [
  ['重要', /(重要|截止|紧急|到期|必须|尽快|加急|最终版|回滚|风险|护照过期|证书到期|ddl|DDL|deadline|Deadline)/],
  ['学习', /(学习|复习|上课|课程|考试|作业|论文|阅读|培训|背单词|公开课|文献|答辩|实验报告|模拟考试|资格考试|读书会|听力|算法课|统计学)/],
  ['工作', /(工作|上班|会议|开会|周会|周报|项目|评审|复盘|复核|需求|汇报|报告|预算|系统维护|检查服务器|客户|合同|供应商|产品方案|设计稿|接口联调|测试用例|上线|投标|库存|数据报表|值班|招聘|面试)/],
  ['健康', /(健康|健身|运动|跑步|训练|复诊|体检|看病|服药|吃药|买药|喝水|牙医|眼科|康复|疫苗|心理咨询|睡眠|血压|游泳|瑜伽)/],
  ['出行', /(出行|出发|旅行|旅游|交通|航班|飞机|高铁|火车|车票|机票|打车|坐车|出差|机场|车站|酒店|值机|行李|路线|租车|签证|景点|退票|换乘|行程|接机)/],
  ['财务', /(财务|钱|付款|付钱|支付|缴费|交费|还款|账单|发票|报销|工资|收入|贷款|房贷|信用卡|房租|社保|转账|收款|退款|保险|停车费|物业费|水电费|报名费)/],
  ['社交', /(社交|聚餐|约会|会面|见面|约见|朋友|生日|同学|家庭晚饭|咖啡|电影|婚礼|爸妈|约球|读书沙龙|社区活动|送别|亲戚|吃饭)/],
  ['生活', /(生活|家务|购物|买|取|家|个人|快递|睡觉|大扫除|理发|修空调|手机膜|加油|洗衣|买菜|猫粮|寄文件|证件照|整理衣柜|物业)/],
];

const EXPLICIT_CATEGORY_RE = /(?:分类|类别|类型)\s*(?:设为|设成|定为|改为|写成|叫作|叫做|是|为)\s*(工作|学习|健康|生活|社交|出行|财务|重要|其他)/;
const RELATIVE_REMINDER_RE = /(?:[0-9一二两三四五六七八九十]{1,3})(?:分钟|小时|刻钟)(?:之后|以后|后)\s*(?:提醒我|提醒|叫我)/;
const LOCATION_CLAUSE_RE = /(?:地点|地址|位置)\s*(?:在|是|为|位于)?[^，,。.!！?？；;]+|在[^，,。.!！?？；;]{0,24}(?:会议室|办公室|图书馆|健身房|咖啡馆|咖啡店|实验室|教室|报告厅|机场|车站|医院|公园|餐厅|酒店|体育馆|体育场|球场|大厅|路演厅|讨论室|一号室|二号室|三号室|四号室|五号室)(?:里面|里|内|附近|门口|旁边|楼上|楼下)?/g;

type EventColorInput = {
  category?: string | null;
};

export function normalizeEventCategory(category?: string | null): EventCategory {
  const clean = String(category ?? '').trim();
  return EVENT_CATEGORIES.includes(clean as EventCategory) ? clean as EventCategory : '其他';
}

export function isEventCategory(category?: string | null): category is EventCategory {
  const clean = String(category ?? '').trim();
  return EVENT_CATEGORIES.includes(clean as EventCategory);
}

export function inferEventCategory(title?: string | null, text?: string | null): EventCategory {
  const titleText = String(title ?? '');
  const bodyText = String(text ?? '');
  const explicit = EXPLICIT_CATEGORY_RE.exec(`${titleText}，${bodyText}`)?.[1];
  if (explicit) return normalizeEventCategory(explicit);
  if (CATEGORY_RULES[0][1].test(`${titleText}，${bodyText}`)) return '重要';
  if (RELATIVE_REMINDER_RE.test(bodyText)) return '重要';
  const categoryBody = bodyText.replace(LOCATION_CLAUSE_RE, '');
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(titleText)) return category;
  }
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(categoryBody)) return category;
  }
  return '其他';
}

export function colorForEventCategory(category?: string | null): string {
  return CATEGORY_COLORS[normalizeEventCategory(category)];
}

export function textColorForEventCategory(category?: string | null): string {
  return CATEGORY_TEXT_COLORS[normalizeEventCategory(category)];
}

export function fillColorForEventCategory(category?: string | null, alpha = 0.14): string {
  return withAlpha(colorForEventCategory(category), alpha);
}

export function colorForEvent(input: EventColorInput): string {
  return colorForEventCategory(input.category);
}
