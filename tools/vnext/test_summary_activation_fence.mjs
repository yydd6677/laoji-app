import assert from 'node:assert/strict';
import test from 'node:test';

import { meetingSummaryActivationFenceMatches } from '../../src/domain/meeting/summaryActivationFence.ts';

const HASH = `sha256:${'a'.repeat(64)}`;
const GENERATION = 'b'.repeat(32);

function fixture() {
  const fence = {
    deviceEpochId: 'epoch-1',
    bindingId: 'binding-1',
    bindingGeneration: GENERATION,
    bindingRevision: 3,
    bindingCancelRevision: 1,
    attachments: [{
      attachmentId: 'attachment-1',
      positionMs: 1_200,
      updatedAtMs: 9_000,
      contentSha256: HASH,
    }],
  };
  const snapshot = {
    deviceEpochId: 'epoch-1',
    binding: {
      deviceEpochId: 'epoch-1',
      bindingId: 'binding-1',
      bindingGeneration: GENERATION,
      bindingRevision: 3,
      state: 'active',
      cancelRevision: 1,
    },
    attachments: [{
      attachmentId: 'attachment-1',
      kind: 'text',
      positionMs: 1_200,
      updatedAtMs: 9_000,
      contentSha256: HASH,
    }],
  };
  return { fence, snapshot };
}

test('accepts an unchanged epoch, binding and authorized attachment', () => {
  const { fence, snapshot } = fixture();
  assert.equal(meetingSummaryActivationFenceMatches(fence, snapshot), true);
});

for (const [name, mutate] of [
  ['device epoch changes', ({ snapshot }) => { snapshot.deviceEpochId = 'epoch-2'; }],
  ['binding epoch changes', ({ snapshot }) => { snapshot.binding.deviceEpochId = 'epoch-2'; }],
  ['binding disappears', value => { value.snapshot.binding = null; }],
  ['binding id changes', ({ snapshot }) => { snapshot.binding.bindingId = 'binding-2'; }],
  ['binding generation changes', ({ snapshot }) => { snapshot.binding.bindingGeneration = 'c'.repeat(32); }],
  ['binding revision changes', ({ snapshot }) => { snapshot.binding.bindingRevision += 1; }],
  ['binding is cancelled', ({ snapshot }) => { snapshot.binding.state = 'cancelled'; }],
  ['binding cancel revision changes', ({ snapshot }) => { snapshot.binding.cancelRevision += 1; }],
  ['authorized attachment is deleted', ({ snapshot }) => { snapshot.attachments = []; }],
  ['authorized attachment becomes binary', ({ snapshot }) => { snapshot.attachments[0].kind = 'file'; }],
  ['authorized attachment moves', ({ snapshot }) => { snapshot.attachments[0].positionMs += 1; }],
  ['authorized attachment revision changes', ({ snapshot }) => { snapshot.attachments[0].updatedAtMs += 1; }],
  ['authorized attachment body changes', ({ snapshot }) => { snapshot.attachments[0].contentSha256 = `sha256:${'c'.repeat(64)}`; }],
]) {
  test(`rejects activation when ${name}`, () => {
    const value = fixture();
    mutate(value);
    assert.equal(meetingSummaryActivationFenceMatches(value.fence, value.snapshot), false);
  });
}

test('rejects duplicate attachment authorization', () => {
  const { fence, snapshot } = fixture();
  fence.attachments.push({ ...fence.attachments[0] });
  assert.equal(meetingSummaryActivationFenceMatches(fence, snapshot), false);
});

test('ignores an attachment that was not authorized for this generation', () => {
  const { fence, snapshot } = fixture();
  snapshot.attachments.push({
    attachmentId: 'attachment-new',
    kind: 'text',
    positionMs: 0,
    updatedAtMs: 10_000,
    contentSha256: `sha256:${'d'.repeat(64)}`,
  });
  assert.equal(meetingSummaryActivationFenceMatches(fence, snapshot), true);
});

for (const [name, mutate] of [
  ['empty epoch', ({ fence }) => { fence.deviceEpochId = ' '; }],
  ['malformed generation', ({ fence }) => { fence.bindingGeneration = 'generation'; }],
  ['unsafe revision', ({ fence }) => { fence.bindingRevision = Number.MAX_VALUE; }],
  ['negative cancel revision', ({ fence }) => { fence.bindingCancelRevision = -1; }],
  ['empty attachment id', ({ fence }) => { fence.attachments[0].attachmentId = ''; }],
  ['negative attachment position', ({ fence }) => { fence.attachments[0].positionMs = -1; }],
  ['malformed attachment hash', ({ fence }) => { fence.attachments[0].contentSha256 = 'sha256:no'; }],
]) {
  test(`rejects malformed fence: ${name}`, () => {
    const value = fixture();
    mutate(value);
    assert.equal(meetingSummaryActivationFenceMatches(value.fence, value.snapshot), false);
  });
}
