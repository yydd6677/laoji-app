import type { MeetingListOrderEntry, MeetingListProjectionItem } from "../data/repositories/meetingNoteRepository";

function recordedAtMs(item: MeetingListProjectionItem): number {
  return item.recordedAtMs ?? item.startedAtMs ?? item.createdAtMs;
}

function compareDefault(
  left: MeetingListProjectionItem,
  right: MeetingListProjectionItem,
): number {
  return recordedAtMs(right) - recordedAtMs(left) || right.id.localeCompare(left.id);
}

/**
 * Manual positions are presentation-only. Newly created, still-unranked
 * meetings stay above an existing manual sequence until the next drag writes
 * a complete order for the active scope.
 */
export function sortMeetingDisplayItems(
  items: readonly MeetingListProjectionItem[],
  order: readonly MeetingListOrderEntry[],
): MeetingListProjectionItem[] {
  const positionById = new Map(order.map(entry => [entry.meetingId, entry.position]));
  if (positionById.size === 0) return [...items].sort(compareDefault);
  return [...items].sort((left, right) => {
    const leftPosition = positionById.get(left.id);
    const rightPosition = positionById.get(right.id);
    if (leftPosition === undefined && rightPosition === undefined) return compareDefault(left, right);
    if (leftPosition === undefined) return -1;
    if (rightPosition === undefined) return 1;
    return leftPosition - rightPosition || compareDefault(left, right);
  });
}
