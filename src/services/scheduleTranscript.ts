export interface ScheduleTranscriptSegment {
  text: string;
  receivedAt: number;
  startTime?: number;
  endTime?: number;
}

function sameTimeline(
  left: ScheduleTranscriptSegment,
  right: ScheduleTranscriptSegment,
): boolean {
  if (left.startTime == null || right.startTime == null) return false;
  const leftEnd = left.endTime ?? left.startTime;
  const rightEnd = right.endTime ?? right.startTime;
  return Math.abs(left.startTime - right.startTime) < 0.2
    || (left.startTime <= rightEnd && right.startTime <= leftEnd);
}

export function appendScheduleTranscriptSegment(
  current: ScheduleTranscriptSegment[],
  incoming: ScheduleTranscriptSegment,
): ScheduleTranscriptSegment[] {
  const text = incoming.text.trim();
  if (!text || isStandaloneFiller(text)) return current;
  const normalized = { ...incoming, text };
  if (current.some(segment => segment.text === text)) return current;
  const last = current[current.length - 1];
  if (!last) return [normalized];

  const sameText = last.text === text;
  const sameTime = sameTimeline(last, normalized);
  if (sameText) return current;

  const oneContainsTheOther = text.includes(last.text) || last.text.includes(text);
  const likelyRevision = oneContainsTheOther && sameTime;
  if (likelyRevision) {
    const preferred = text.length >= last.text.length ? normalized : { ...last, receivedAt: normalized.receivedAt };
    return [...current.slice(0, -1), preferred];
  }

  return [...current, normalized];
}

export function scheduleTranscriptDisplayText(segments: ScheduleTranscriptSegment[]): string {
  return mergeScheduleTranscriptSegments(
    segments.map(segment => segment.text.trim()).filter(Boolean),
  );
}

export function scheduleTranscriptText(segments: ScheduleTranscriptSegment[]): string {
  const cleaned = segments
    .map(segment => repairCommonScheduleHomophones(repairTemporalPrefix(segment.text)))
    .filter(text => !isExplicitAsrNoise(text) && !isLowInformationRepetition(text));
  return mergeScheduleTranscriptSegments(cleaned
    .filter((text, index) => (
      cleaned.indexOf(text) === index
      && !isLikelyPartialDuplicate(text, index, cleaned)
    )));
}

/**
 * Schedule ASR chunks are transport boundaries, not sentence boundaries.
 * Qwen commonly appends a full stop to every independently decoded VAD chunk;
 * keeping those stops turns one spoken request into several apparent sentences
 * and can incorrectly route an otherwise local-safe draft back to the model.
 */
function mergeScheduleTranscriptSegments(texts: string[]): string {
  return texts
    .map(text => text.trim().replace(/[。．.]+$/u, '').trim())
    .filter(Boolean)
    .map((text, index) => index === 0 ? text : text.replace(/^[，,。．.]+/u, ''))
    .join('');
}

function isStandaloneFiller(text: string): boolean {
  const normalized = text.replace(/[\s，。！？、,.!?]/g, '');
  return /^(嗯+|啊+|呃+|额+|哦+|噢+|唔+|对+)$/.test(normalized);
}

function isExplicitAsrNoise(text: string): boolean {
  return /(没有没有|没有.*没有.*没有|字幕|谢谢观看|请不吝点赞)/.test(text);
}

function isLikelyPartialDuplicate(candidate: string, index: number, all: string[]): boolean {
  const compactCandidate = candidate.replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '');
  if (
    compactCandidate.length < 5
    || /^(不对|不是|改成|更正|说错)/.test(compactCandidate)
  ) return false;
  const strongerMatches = all.filter((other, otherIndex) => {
    if (otherIndex === index) return false;
    const compactOther = other.replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '');
    if (compactOther.length <= compactCandidate.length) return false;
    if (compactOther.includes(compactCandidate)) return true;
    const commonSuffix = commonSuffixLength(compactCandidate, compactOther);
    return commonSuffix >= 5 && commonSuffix / compactCandidate.length >= 0.7;
  });
  return strongerMatches.length >= 2;
}

function commonSuffixLength(left: string, right: string): number {
  let length = 0;
  while (
    length < left.length
    && length < right.length
    && left[left.length - 1 - length] === right[right.length - 1 - length]
  ) length += 1;
  return length;
}

function isLowInformationRepetition(text: string): boolean {
  const compact = text.replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '');
  if (compact.length < 4 || hasScheduleCue(compact)) return false;
  return new Set(compact.toLowerCase()).size / compact.length <= 0.75;
}

function hasScheduleCue(text: string): boolean {
  return /(今天|明天|后天|今晚|明早|下周|本周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}[号日]?|[0-2]?\d[:：][0-5]\d|[0-2]?\d\s*[点时]|上午|下午|中午|晚上|早上|会|提醒|安排|上课|考试|面试|提交|汇报|打电话|吃饭|聚餐|健身|出发|到达|预约|复诊|缴费|还款|体检|看病|服药|吃药|买|取|拿|带|发|写|完成|学习|复习|出差|旅行|生日)/.test(text);
}

function repairTemporalPrefix(text: string): string {
  return text
    .replace(/^我(?=今天|明天|后天|今晚|明早|下周|本周|周[一二三四五六日天]|星期[一二三四五六日天])/, '')
    .replace(/^我?一天(?=上午|下午|中午|晚上|早上|凌晨)/, '明天')
    .replace(/^天(?=上午|下午|中午|晚上|早上|凌晨)/, '明天')
    .replace(/^午(?=(?:[0-2]?\d|[一二两三四五六七八九十]{1,3})[点时])/, '下午');
}

function repairCommonScheduleHomophones(text: string): string {
  return text
    .replace(/医院提检/g, '医院体检')
    .replace(/医愿体检/g, '医院体检');
}
