import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMeetingSummaryInputChangedError,
  createSummaryV3ActivationFenceError,
  errorHasStableName,
  isMeetingSummaryInputChangedErrorLike,
  isSummaryV3ActivationFenceErrorLike,
} from '../../src/domain/meeting/summaryErrorIdentity.ts';

test('creates a stable source-stream input-changed error', () => {
  const error = createMeetingSummaryInputChangedError();
  assert.equal(error.name, 'MeetingSummaryInputChangedError');
  assert.equal(isMeetingSummaryInputChangedErrorLike(error), true);
});

test('recognizes an Error instance by its stable name', () => {
  const error = new Error('changed');
  error.name = 'MeetingSummaryInputChangedError';
  assert.equal(isMeetingSummaryInputChangedErrorLike(error), true);
});

test('recognizes a bridge-safe plain error record', () => {
  assert.equal(isSummaryV3ActivationFenceErrorLike({
    name: 'SummaryV3ActivationFenceError',
    message: 'summary v3 activation fence changed',
  }), true);
});

test('recognizes a native transaction wrapper by its fixed internal sentinel', () => {
  assert.equal(isSummaryV3ActivationFenceErrorLike(new Error(
    "Call to native transaction rejected: summary v3 activation fence changed",
  )), true);
  assert.equal(isMeetingSummaryInputChangedErrorLike(new Error(
    '会议内容已更新，本次结果未替换当前整理，请重新整理。',
  )), true);
});

test('creates a stable source-stream activation fence error', () => {
  const error = createSummaryV3ActivationFenceError();
  assert.equal(error.name, 'SummaryV3ActivationFenceError');
  assert.equal(isSummaryV3ActivationFenceErrorLike(error), true);
});

test('does not infer a control-flow error from message text', () => {
  assert.equal(isMeetingSummaryInputChangedErrorLike({
    name: 'Error',
    message: 'MeetingSummaryInputChangedError',
  }), false);
  assert.equal(errorHasStableName(null, 'MeetingSummaryInputChangedError'), false);
});
