import { Colors as C } from '../src/theme/colors';
import {
  EVENT_CATEGORIES,
  colorForEvent,
  colorForEventCategory,
  normalizeEventCategory,
} from '../src/utils/eventColors';

describe('event color rules', () => {
  it('keeps the shared fixed category enum in client code', () => {
    expect(EVENT_CATEGORIES).toEqual(['工作', '学习', '健康', '生活', '社交', '出行', '财务', '重要', '其他']);
  });

  it('maps canonical categories to app colors', () => {
    expect(colorForEventCategory('工作')).toBe(C.blue);
    expect(colorForEventCategory('学习')).toBe(C.green);
    expect(colorForEventCategory('健康')).toBe(C.teal);
    expect(colorForEventCategory('生活')).toBe(C.purple);
    expect(colorForEventCategory('社交')).toBe(C.pink);
    expect(colorForEventCategory('出行')).toBe(C.orange);
    expect(colorForEventCategory('重要')).toBe(C.red);
  });

  it('normalizes unknown labels to other', () => {
    expect(normalizeEventCategory('会议')).toBe('其他');
    expect(colorForEventCategory('会议')).toBe(C.faint);
  });

  it('colors events only by category', () => {
    expect(colorForEvent({ category: '财务' })).toBe('#9B59B6');
    expect(colorForEvent({ category: null })).toBe(C.faint);
  });
});
