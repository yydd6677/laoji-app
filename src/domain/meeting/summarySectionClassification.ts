/**
 * Classifies an already-normalized summary section label.
 *
 * Keep this helper dependency-free so the projection contract can exercise the
 * exact production predicate outside the React Native runtime.
 */
export function isNormalizedMeetingSummaryActionLabel(label: string): boolean {
  const nonActionQuestion = /^(?:后续|下一步)?(?:问题|提问|疑问|待确认问题|开放问题)$/;
  const exactAction = /^(?:待办事项|待办|行动项|行动事项|任务|任务清单|后续事项|后续行动|下一步|跟进事项|todo(?:s)?|actionitems?|tasks?|followups?)$/;
  const actionPrefix = /^(?:待办|行动|任务|后续|下一步|跟进)/;
  if (nonActionQuestion.test(label)) return false;
  return exactAction.test(label) || actionPrefix.test(label);
}
