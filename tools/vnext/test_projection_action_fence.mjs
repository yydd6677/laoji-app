import assert from 'node:assert/strict';
import test from 'node:test';

import { fenceNativeProjectionAction } from '../../src/native/projectionActionFence.ts';

const current = Object.freeze({
  deviceEpoch: 'epoch-1',
  entityId: 'meeting-1',
  entityRevision: 3,
  viewRevision: 7,
  surfaceInstanceId: 'surface-new',
  payloadSha256: `sha256:${'a'.repeat(64)}`,
});

test('stable builds preserve the pre-vNext action path', () => {
  assert.deepEqual(fenceNativeProjectionAction(false, null, null), {
    accepted: true,
    reason: 'candidate_disabled',
  });
});

test('candidate fails closed while its current projection hash is pending', () => {
  assert.deepEqual(fenceNativeProjectionAction(true, null, current), {
    accepted: false,
    reason: 'projection_pending',
  });
});

test('candidate rejects an action without a projection', () => {
  assert.deepEqual(fenceNativeProjectionAction(true, current, null), {
    accepted: false,
    reason: 'projection_missing',
  });
});

for (const field of [
  'deviceEpoch',
  'entityId',
  'entityRevision',
  'viewRevision',
  'surfaceInstanceId',
  'payloadSha256',
]) {
  test(`candidate rejects a stale ${field}`, () => {
    const stale = { ...current, [field]: typeof current[field] === 'number' ? current[field] - 1 : `${current[field]}-old` };
    assert.deepEqual(fenceNativeProjectionAction(true, current, stale), {
      accepted: false,
      reason: 'projection_stale',
    });
  });
}

test('candidate accepts only the exact current projection', () => {
  assert.deepEqual(fenceNativeProjectionAction(true, current, { ...current }), {
    accepted: true,
    reason: 'current_projection',
  });
});
