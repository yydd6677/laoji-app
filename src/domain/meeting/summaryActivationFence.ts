import type { MeetingSummaryActivationFenceV3 } from './summary';

export interface MeetingSummaryActivationSnapshotV3 {
  deviceEpochId: string | null;
  binding: {
    deviceEpochId: string;
    bindingId: string;
    bindingGeneration: string;
    bindingRevision: number;
    state: string;
    cancelRevision: number;
  } | null;
  attachments: readonly {
    attachmentId: string;
    kind: string;
    positionMs: number;
    updatedAtMs: number;
    contentSha256: string;
  }[];
}

const BINDING_GENERATION_PATTERN = /^[0-9a-f]{32}$/;
const CONTENT_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Compares the content-free identity returned with a completed remote task to
 * the state read inside the local activation transaction. Extra, unselected
 * attachments are intentionally ignored; only sources authorized for this
 * generation may invalidate it.
 */
export function meetingSummaryActivationFenceMatches(
  expected: MeetingSummaryActivationFenceV3,
  current: MeetingSummaryActivationSnapshotV3,
): boolean {
  if (
    !expected.deviceEpochId.trim()
    || !expected.bindingId.trim()
    || !BINDING_GENERATION_PATTERN.test(expected.bindingGeneration)
    || !Number.isSafeInteger(expected.bindingRevision)
    || expected.bindingRevision < 1
    || !Number.isSafeInteger(expected.bindingCancelRevision)
    || expected.bindingCancelRevision < 0
  ) return false;

  const binding = current.binding;
  if (
    current.deviceEpochId !== expected.deviceEpochId
    || !binding
    || binding.deviceEpochId !== expected.deviceEpochId
    || binding.bindingId !== expected.bindingId
    || binding.bindingGeneration !== expected.bindingGeneration
    || binding.bindingRevision !== expected.bindingRevision
    || binding.state !== 'active'
    || binding.cancelRevision !== expected.bindingCancelRevision
  ) return false;

  const currentAttachments = new Map(current.attachments.map(item => [item.attachmentId, item]));
  const expectedAttachmentIds = new Set<string>();
  for (const attachment of expected.attachments) {
    if (
      expectedAttachmentIds.has(attachment.attachmentId)
      || !attachment.attachmentId.trim()
      || !Number.isSafeInteger(attachment.positionMs)
      || attachment.positionMs < 0
      || !Number.isSafeInteger(attachment.updatedAtMs)
      || attachment.updatedAtMs < 0
      || !CONTENT_SHA256_PATTERN.test(attachment.contentSha256)
    ) return false;
    expectedAttachmentIds.add(attachment.attachmentId);
    const actual = currentAttachments.get(attachment.attachmentId);
    if (
      !actual
      || actual.kind !== 'text'
      || actual.positionMs !== attachment.positionMs
      || actual.updatedAtMs !== attachment.updatedAtMs
      || actual.contentSha256 !== attachment.contentSha256
    ) return false;
  }
  return true;
}
