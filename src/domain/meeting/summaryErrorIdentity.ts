/**
 * Error objects can cross a Metro reload, a Promise recovery queue, or a
 * native bridge boundary. In those cases the prototype identity is not
 * guaranteed to survive even though the stable `name` field does. Summary
 * recovery must therefore not rely on `instanceof` alone when deciding
 * whether a completed remote artifact is safe to activate locally.
 */
export function errorHasStableName(reason: unknown, expectedName: string): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const value = (reason as { name?: unknown }).name;
  return typeof value === 'string' && value === expectedName;
}

function errorHasInternalSentinel(reason: unknown, sentinel: string): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const value = (reason as { message?: unknown }).message;
  return typeof value === 'string' && value.includes(sentinel);
}

export function isMeetingSummaryInputChangedErrorLike(reason: unknown): boolean {
  return errorHasStableName(reason, 'MeetingSummaryInputChangedError')
    || errorHasInternalSentinel(
      reason,
      '会议内容已更新，本次结果未替换当前整理，请重新整理。',
    );
}

export function isSummaryV3ActivationFenceErrorLike(reason: unknown): boolean {
  return errorHasStableName(reason, 'SummaryV3ActivationFenceError')
    || errorHasInternalSentinel(reason, 'summary v3 activation fence changed');
}

export function createSummaryV3ActivationFenceError(): Error {
  const error = new Error('summary v3 activation fence changed');
  error.name = 'SummaryV3ActivationFenceError';
  return error;
}
