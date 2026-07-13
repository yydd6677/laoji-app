import { parseLocalScheduleText, shouldUseLocalScheduleParseFirst } from '../src/services/localScheduleParser';

const BASE_DATE = new Date(2026, 6, 9, 9, 0, 0);

describe('local schedule parser', () => {
  it('parses explicit relative date and time without network or model access', () => {
    const parsed = parseLocalScheduleText('明天下午三点开会', BASE_DATE);

    expect(parsed).toMatchObject({
      title: '开会',
      event_type: 'once',
      start_date: '2026-07-10',
      start_time: '15:00',
      end_time: '16:00',
      category: '工作',
      parse_source: 'rules',
      confidence: 0,
      needs_clarification: false,
    });
  });

  it('keeps weekday math available locally', () => {
    const parsed = parseLocalScheduleText('周日上午十点吃饭', BASE_DATE);

    expect(parsed).toMatchObject({
      start_date: '2026-07-12',
      start_time: '10:00',
      end_time: '11:00',
    });
  });

  it('parses multi-day ranges locally', () => {
    const parsed = parseLocalScheduleText('七月十五号到七月十八号出差', BASE_DATE);

    expect(parsed).toMatchObject({
      start_date: '2026-07-15',
      end_date: '2026-07-18',
      spanning: true,
      category: '出行',
    });
  });

  it('parses month-end date ranges locally', () => {
    const parsed = parseLocalScheduleText('7月18日到月底整理数据报表检查', BASE_DATE);

    expect(parsed).toMatchObject({
      start_date: '2026-07-18',
      end_date: '2026-07-31',
      spanning: true,
      category: '工作',
    });
  });

  it('uses expanded category keywords locally', () => {
    expect(parseLocalScheduleText('明天下午三点背单词', BASE_DATE)).toMatchObject({ category: '学习' });
    expect(parseLocalScheduleText('明天下午三点预约理发', BASE_DATE)).toMatchObject({ category: '生活' });
    expect(parseLocalScheduleText('明天下午三点签证材料', BASE_DATE)).toMatchObject({ category: '出行' });
  });

  it.each([
    ['下周三下午两点到四点在A301复盘项目', '复盘项目', 'A301', '工作'],
    ['明天下午三点在图书馆复习英语', '复习英语', '图书馆', '学习'],
    ['周五上午十点在健身房缴水电费', '缴水电费', '健身房', '财务'],
    ['明天上午九点在会议室开会', '开会', '会议室', '工作'],
    ['明天下午三点在家整理房间', '整理房间', '家', '生活'],
    ['周五下午两点在上海图书馆复习', '复习', '上海图书馆', '学习'],
    ['下周一上午九点在图书馆附近集合后出发', '集合后出发', '图书馆附近', '出行'],
  ])('separates a physical location from its following action: %s', (text, title, location, category) => {
    expect(parseLocalScheduleText(text, BASE_DATE)).toMatchObject({ title, location, category });
  });

  it('keeps explicit location fields without consuming the event action', () => {
    expect(
      parseLocalScheduleText('明天下午三点地点是研发区小会议室，讨论预算', BASE_DATE)
    ).toMatchObject({
      title: '预算',
      description: '预算',
      location: '研发区小会议室',
      category: '工作',
    });
  });

  it.each([
    '明天下午三点在公司群里确认方案',
    '周五上午十点在家人面前讨论预算',
  ])('does not treat a conversation context as a physical location: %s', text => {
    expect(parseLocalScheduleText(text, BASE_DATE)).toMatchObject({ location: null });
  });

  it('returns a clarification draft for low-information notes', () => {
    const parsed = parseLocalScheduleText('帮我记一下那个事情', BASE_DATE);

    expect(parsed).toMatchObject({
      start_date: '2026-07-09',
      is_all_day: true,
      needs_clarification: true,
      confidence: 0,
    });
  });

  it('returns null when neither schedule structure nor note intent is present', () => {
    expect(parseLocalScheduleText('只是随便说句话', BASE_DATE)).toBeNull();
  });

  it('rejects explicit non-schedule control text locally', () => {
    expect(parseLocalScheduleText('我刚才只是测试麦克风，不要真的创建日程', BASE_DATE)).toBeNull();
  });

  it('allows local-first routing only for simple complete schedules', () => {
    const parsed = parseLocalScheduleText('明天下午三点开会', BASE_DATE);

    expect(shouldUseLocalScheduleParseFirst('明天下午三点开会', parsed)).toBe(true);
  });

  it('routes correction text to the server instead of trusting local rules first', () => {
    const text = '不是星期日，是星期五上午九点报销发票';
    const parsed = parseLocalScheduleText(text, BASE_DATE);

    expect(parsed).not.toBeNull();
    expect(shouldUseLocalScheduleParseFirst(text, parsed)).toBe(false);
  });

  it('routes ASR filler-fragmented corrections to the server', () => {
    const variants = [
      '整理发票不呃是今天，是下周二下午四点半',
      '整理发票不，那个，对今天，改成下周二下午四点半',
      '整理发票说嗯错今天，改额成下周二下午四点半',
    ];

    variants.forEach(text => {
      const parsed = parseLocalScheduleText(text, BASE_DATE);
      expect(parsed).not.toBeNull();
      expect(shouldUseLocalScheduleParseFirst(text, parsed)).toBe(false);
    });
  });

  it('recovers sparse ASR fillers only inside explicit date ranges', () => {
    const today = new Date(2026, 6, 13);
    expect(parseLocalScheduleText('7月21号到然后下周日准备寄文件', today)).toMatchObject({
      start_date: '2026-07-21',
      end_date: '2026-07-26',
    });
    expect(parseLocalScheduleText('从7月18日始到8月5号发邮件', today)).toMatchObject({
      start_date: '2026-07-18',
      end_date: '2026-08-05',
    });
    expect(parseLocalScheduleText('8月2号到8月嗯5号取快递', today)).toMatchObject({
      start_date: '2026-08-02',
      end_date: '2026-08-05',
    });
    expect(parseLocalScheduleText('本月25号到可能8月5号修空调', today)).toMatchObject({
      start_date: '2026-07-25',
      end_date: '2026-08-05',
    });
  });

  it('keeps the final date and time as an accurate offline correction fallback', () => {
    const text = '原来是周三下午两点，不对，改成本周五下午三点安全培训';
    const parsed = parseLocalScheduleText(text, BASE_DATE);

    expect(parsed).toMatchObject({
      start_date: '2026-07-10',
      start_time: '15:00',
      end_time: '16:00',
    });
    expect(shouldUseLocalScheduleParseFirst(text, parsed)).toBe(false);
  });

  it('removes the whole next-month-end marker from quick titles', () => {
    expect(
      parseLocalScheduleText('下月底23:00前必须模拟考试，提前十分钟提醒', BASE_DATE)
    ).toMatchObject({
      title: '模拟考试',
      start_date: '2026-08-31',
      reminder_minutes: 10,
    });
  });

  it('repairs an omitted hour character in an ASR reminder phrase', () => {
    expect(
      parseLocalScheduleText('老纪 下周一 上午十点半 提交材料 提前两时提醒', BASE_DATE)
    ).toMatchObject({
      title: '提交材料',
      reminder_minutes: 120,
    });
  });

  it('keeps confirmation-document nouns in the event title', () => {
    expect(
      parseLocalScheduleText('2026年8月6日下午四点半考试确认单打印', BASE_DATE)
    ).toMatchObject({ title: '考试确认单打印' });
  });

  it('parses an explicit next-month day and removes ASR meta speech', () => {
    const monthStart = new Date(2026, 6, 1, 9, 0, 0);
    expect(
      parseLocalScheduleText('日程里加一下下月20号16:40公开课直播声音可能有点小', monthStart)
    ).toMatchObject({
      title: '公开课直播',
      start_date: '2026-08-20',
      start_time: '16:40',
    });
  });

  it('does not leak ASR date-preservation instructions into the title', () => {
    expect(
      parseLocalScheduleText('7月15号10:20亲戚拜访嗯不要漏掉前面日期', BASE_DATE)
    ).toMatchObject({ title: '亲戚拜访' });
  });

  it('recognizes recurring phrases with sparse ASR fillers', () => {
    const yearly = parseLocalScheduleText('给我安排，每额年7月20号下午两点提醒我接口联调', BASE_DATE);
    const weekly = parseLocalScheduleText('从现在开始周三16:40都要线上培训，先按重日程记', BASE_DATE);

    expect(yearly).toMatchObject({ event_type: 'yearly', title: '接口联调' });
    expect(weekly).toMatchObject({ event_type: 'weekly', title: '线上培训' });
  });

  it('preserves finite daily ranges and explicit open-ended starts', () => {
    expect(
      parseLocalScheduleText('下周一到下周三在上海参加培训，每天上午九点开始', BASE_DATE)
    ).toMatchObject({
      event_type: 'once',
      start_date: '2026-07-13',
      end_date: '2026-07-15',
      spanning: true,
      start_time: '09:00',
    });
    expect(
      parseLocalScheduleText('从下周一开始每天上午九点复习英语', BASE_DATE)
    ).toMatchObject({
      event_type: 'daily',
      start_date: '2026-07-13',
      end_date: null,
      start_time: '09:00',
      title: '复习英语',
      category: '学习',
    });
  });

  it('routes conflicting ranges and instruction-heavy text to the server', () => {
    const rangeText = '7月21号到7月18号下午三点提交材料';
    const range = parseLocalScheduleText(rangeText, BASE_DATE);
    const verboseText = '记一条。2026年8月6日下午两点需求评审。标题就写需求评审。';
    const verbose = parseLocalScheduleText(verboseText, BASE_DATE);

    expect(range).not.toBeNull();
    expect(range).toMatchObject({
      needs_clarification: true,
      clarification_question: '听到了日期范围，但开始或结束日期不够清楚，需要确认完整的起止日期。',
    });
    expect(shouldUseLocalScheduleParseFirst(rangeText, range)).toBe(false);
    expect(verbose).not.toBeNull();
    expect(shouldUseLocalScheduleParseFirst(verboseText, verbose)).toBe(false);
  });

  it('routes uncertain locations to the server for clarification', () => {
    const text = '8月2号到8月5号取快递，地点可能是东门';
    const parsed = parseLocalScheduleText(text, BASE_DATE);

    expect(parsed).not.toBeNull();
    expect(shouldUseLocalScheduleParseFirst(text, parsed)).toBe(false);
  });
});
