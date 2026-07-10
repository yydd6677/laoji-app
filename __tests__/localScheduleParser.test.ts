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
});
