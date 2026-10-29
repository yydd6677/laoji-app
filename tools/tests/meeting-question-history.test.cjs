const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const crypto = require('node:crypto');
const digest = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

function load(overrides) {
  const file = path.resolve(__dirname, '../../src/services/meetingQuestionsQ2.ts');
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const repository = {
    getQ2Thread: async () => ({ threadId: 'thread', meetingId: 'meeting', snapshotId: 'snapshot',
      createdAtMs: 1, updatedAtMs: 2, turns: [{ turnId: 'turn', requestId: 'request', ordinal: 0,
        question: '先处理什么？', answer: '先核对资料。', answerKind: 'answer', completedAtMs: 2, createdAtMs: 1,
        clauses: [] }] }),
    getQ2Snapshot: async () => ({ meetingId: 'meeting', sourceFingerprint: 'current' }),
    ...overrides,
  };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'expo-crypto') return { CryptoDigestAlgorithm: { SHA256: 'sha256' },
      digestStringAsync: async (_algorithm, value) => crypto.createHash('sha256').update(value).digest('hex') };
    if (name.endsWith('questionQ2Repository')) return repository;
    if (name.endsWith('deviceOperationsRepository')) return {
      getDeviceOperation: async () => ({ remoteState: overrides?.operationState ?? 'running' }),
    };
    return {};
  }, module, module.exports);
  return module.exports;
}

const evidence = { meetingId: 'meeting', sourceFingerprint: 'current', transcriptRevisionId: 'revision',
  manualNoteRevision: null, includeManualNote: true, transcript: [], attachments: [] };

test('opening a current historical thread preserves saved answers', async () => {
  const result = await load().openQ2ThreadHistory(evidence, 'thread');
  assert.equal(result.readOnly, false);
  assert.equal(result.thread.turns[0].answer, '先核对资料。');
});

test('changed-source history is readable but never links old citations to current text', async () => {
  const result = await load({ getQ2Snapshot: async () => ({ meetingId: 'meeting', sourceFingerprint: 'old' }) })
    .openQ2ThreadHistory(evidence, 'thread');
  assert.equal(result.readOnly, true);
  assert.equal(result.thread.inputFingerprint, 'old');
  assert.deepEqual(result.thread.turns[0].citations, []);
});

test('a thread belonging to another meeting cannot be opened', async () => {
  const api = load({ getQ2Thread: async () => ({ meetingId: 'other' }) });
  await assert.rejects(api.openQ2ThreadHistory(evidence, 'thread'), /不属于当前会议/);
});

for (const operationState of ['queued', 'running', 'failure', 'cancelled']) {
  test(`reopening a question projects its durable ${operationState} state`, async () => {
    const api = load({ operationState, getQ2Thread: async () => ({
      threadId: 'thread', meetingId: 'meeting', snapshotId: 'snapshot', createdAtMs: 1, updatedAtMs: 2,
      turns: [{ turnId: 'pending', currentOperationId: 'operation', question: '下一步做什么？',
        ordinal: 0, completedAtMs: null, answer: null, answerKind: null, clauses: [] }],
    }) });
    const result = await api.openQ2ThreadHistory(evidence, 'thread');
    const active = operationState === 'queued' || operationState === 'running';
    assert.equal(result.pendingQuestion, active ? '下一步做什么？' : null);
    assert.equal(result.failedQuestion, active ? null : '下一步做什么？');
    assert.deepEqual(result.thread.turns, []);
  });
}

test('an unfinished old-source question never blocks the current composer', async () => {
  const result = await load({
    getQ2Snapshot: async () => ({ meetingId: 'meeting', sourceFingerprint: 'old' }),
    getQ2Thread: async () => ({ threadId: 'thread', meetingId: 'meeting', snapshotId: 'snapshot',
      createdAtMs: 1, updatedAtMs: 2, turns: [{ completedAtMs: null, question: '旧问题', currentOperationId: 'old' }] }),
  }).openQ2ThreadHistory(evidence, 'thread');
  assert.equal(result.readOnly, true);
  assert.equal(result.pendingQuestion, null);
  assert.equal(result.failedQuestion, null);
});

function citation(id, sourceId, text, start, end) {
  const quote = Buffer.from(text).subarray(start, end).toString('utf8');
  return { citationId: id, sourceType: 'transcript', sourceId, sourceRevisionId: 'revision',
    contentSha256: digest(text), sourceStartUtf8: start, sourceEndUtf8: end, quoteSha256: digest(quote) };
}

async function projectedCitations(rows, sourceRows, extraEvidence = {}) {
  const session = await load({ getQ2Thread: async () => ({ threadId: 'thread', meetingId: 'meeting', snapshotId: 'snapshot',
    turns: [{ ordinal: 0, answer: '先核对资料。', answerKind: 'answer', completedAtMs: 2,
      clauses: rows.map(row => ({ citations: [row] })) }] }) })
    .openQ2ThreadHistory({ ...evidence, transcript: sourceRows, ...extraEvidence }, 'thread');
  return session.thread.turns[0].citations;
}

test('the same exact proof in different clauses is displayed once without rewriting stored clauses', async () => {
  const text = '先核对资料。';
  const row = citation('c1-e1', 'segment', text, 0, Buffer.byteLength(text));
  const rows = [row, { ...row, citationId: 'c2-e1' }];
  const result = await projectedCitations(rows, [{ segmentId: 'segment', text, startMs: 1000, endMs: 2000 }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'c1-e1');
  assert.equal(rows.length, 2);
});

test('different proof ranges show actual quoted spans, not the same whole-source excerpt', async () => {
  const a = '先核对资料。', b = '再提交清单。', text = a + b;
  const rows = [citation('c1-e1', 'segment', text, 0, Buffer.byteLength(a)),
    citation('c2-e1', 'segment', text, Buffer.byteLength(a), Buffer.byteLength(text))];
  const result = await projectedCitations(rows, [{ segmentId: 'segment', text, startMs: 1000, endMs: 2000 }]);
  assert.deepEqual(result.map(row => row.sourceExcerpt), [a, b]);
});

test('a note citation displays only its verified quote', async () => {
  const quote = '先核对资料。', text = quote + '另外安排评审。';
  const row = { ...citation('note', 'manual_note:meeting', text, 0, Buffer.byteLength(quote)),
    sourceType: 'manual_note', sourceRevisionId: '7' };
  const result = await projectedCitations([row], [], { manualNote: text, manualNoteRevision: 7 });
  assert.equal(result[0].kind, 'manual_note');
  assert.equal(result[0].sourceExcerpt, quote);
});

test('an attachment citation displays only its verified quote', async () => {
  const quote = '先核对资料。', text = quote + '另有一份清单。';
  const row = { ...citation('attachment', 'attachment:document', text, 0, Buffer.byteLength(quote)),
    sourceType: 'attachment', sourceRevisionId: 'attachment-revision' };
  const result = await projectedCitations([row], [], { attachments: [{ attachmentId: 'document',
    revisionId: 'attachment-revision', positionMs: 12000, text }] });
  assert.equal(result[0].kind, 'attachment');
  assert.equal(result[0].sourceExcerpt, quote);
});

test('identical words at different source positions remain distinct evidence', async () => {
  const text = '好的。好的。', size = Buffer.byteLength('好的。');
  const rows = [citation('first', 'segment', text, 0, size), citation('second', 'segment', text, size, size * 2)];
  const result = await projectedCitations(rows, [{ segmentId: 'segment', text, startMs: 1000, endMs: 2000 }]);
  assert.equal(result.length, 2);
});

test('a duplicate-looking proof cannot hide an invalid quote hash', async () => {
  const text = '先核对资料。', row = citation('first', 'segment', text, 0, Buffer.byteLength(text));
  await assert.rejects(projectedCitations([row, { ...row, citationId: 'second', quoteSha256: digest('wrong') }],
    [{ segmentId: 'segment', text, startMs: 1000, endMs: 2000 }]), /引用校验失败/);
});
