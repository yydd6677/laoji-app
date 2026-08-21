import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { MEETING_TEMPLATES } from '../../src/domain/meeting/templates.ts';
import {
  applyMeetingSummaryV3Overrides,
  meetingFactsV3Markdown,
  projectMeetingFactsV3,
} from '../../src/services/meetingSummaryV3.ts';
import { isNormalizedMeetingSummaryActionLabel } from '../../src/domain/meeting/summarySectionClassification.ts';

const HASH = `sha256:${'a'.repeat(64)}`;

function source(id, quote, startMs, speaker = '成员甲') {
  return {
    sourceId: `transcript:${id}`,
    sourceType: 'transcript',
    quote,
    contentHash: HASH,
    startMs,
    endMs: startMs + 900,
    speaker,
  };
}

function fact(factId, factType, certainty, content, startMs, speaker) {
  return {
    factId,
    factType,
    certainty,
    content,
    sources: [source(factId, content, startMs, speaker)],
    evidenceScore: 0.9,
    conflictGroupId: null,
  };
}

function fixture() {
  const facts = [
    fact('topic', 'topic', 'confirmed', '讨论新版本交付范围', 0),
    fact('context', 'context', 'completed', '接口联调已经完成', 1_000),
    fact('conclusion', 'conclusion', 'confirmed', '本轮目标完成率为90%', 2_000),
    fact('risk', 'risk', 'proposed', '测试环境容量仍有风险', 3_000),
    fact('question', 'question', 'uncertain', '需要谁协调测试资源', 4_000),
    fact('quote', 'quote', 'confirmed', '先保证交付质量，再压缩时间', 5_000, '成员乙'),
    fact('timeline', 'timeline', 'proposed', '明天下午完成回归', 6_000),
    fact('action', 'action', 'proposed', '成员甲明天下午完成回归清单', 7_000),
    fact('alternative_a', 'conclusion', 'proposed', '方案一先灰度发布', 8_000),
    fact('alternative_b', 'conclusion', 'proposed', '方案二一次性发布', 9_000),
  ];
  return {
    result: {
      documentId: 'facts-doc-1',
      meetingId: 'meeting-1',
      sourceFingerprint: HASH,
      transcriptRevision: 'transcript-revision-1',
      modelRevision: 'ollama:qwen3.5:9b',
      promptRevision: 'facts-v3-r15',
      generatedAt: '2026-08-21T08:00:00.000Z',
      coverage: {
        totalSegments: 10,
        includedSegments: 10,
        topicGroups: 2,
        coveredTopicGroups: 2,
        topicCoverage: 1,
        sourceTypes: ['transcript'],
        includedSourceTypes: ['transcript'],
        sourceCoverage: 1,
        usedEmbeddings: false,
        inputTokenBudget: 10_240,
        estimatedInputTokens: 1_000,
      },
      factsDocument: {
        schemaVersion: 3,
        overview: { text: '会议确认了交付范围、当前进展和下一步回归安排。', factIds: ['topic', 'conclusion'] },
        facts,
        relations: [
          { relationType: 'precedes', fromFactId: 'context', toFactId: 'conclusion' },
          { relationType: 'depends_on', fromFactId: 'conclusion', toFactId: 'topic' },
          { relationType: 'alternative', fromFactId: 'alternative_a', toFactId: 'alternative_b' },
        ],
        actionCandidates: [{
          actionId: 'action-1',
          factId: 'action',
          content: '成员甲明天下午完成回归清单',
          owner: '成员甲',
          dueText: '明天下午',
          scheduleFit: 'high',
          evidenceScore: 0.9,
        }],
      },
    },
    transcriptLines: facts.map(item => ({
      id: item.factId,
      start_time: item.sources[0].startMs / 1_000,
      end_time: item.sources[0].endMs / 1_000,
      text: item.sources[0].quote,
      speaker: item.sources[0].speaker,
    })),
  };
}

function actionContract(document) {
  return document.actionItemCandidates.map(action => ({
    id: action.id,
    content: action.content,
    assignee: action.assignee,
    dueText: action.dueText,
    scheduleFit: action.scheduleFit,
    evidenceScore: action.evidenceScore,
    citations: action.citations.map(citation => ({
      segmentId: citation.segmentId,
      startMs: citation.startMs,
      endMs: citation.endMs,
      quoteHash: citation.quoteHash,
    })),
  }));
}

test('four templates project the same immutable facts, references and actions', () => {
  const { result, transcriptLines } = fixture();
  const before = JSON.stringify(result);
  const projected = MEETING_TEMPLATES.map(template => (
    projectMeetingFactsV3(result, template, 4, transcriptLines)
  ));

  assert.equal(JSON.stringify(result), before);
  assert.equal(new Set(projected.map(document => document.remoteVersionId)).size, 1);
  assert.equal(new Set(projected.map(document => document.scheduleSnapshotHash)).size, 1);
  assert.deepEqual(projected.map(actionContract), projected.map(() => actionContract(projected[0])));
  for (const [index, document] of projected.entries()) {
    const template = MEETING_TEMPLATES[index];
    const keys = new Set(document.sections.map(section => section.stableKey));
    for (const definition of template.sectionSchema) {
      assert.ok(keys.has(`${template.id}:${definition.stableKey}`), `${template.id}:${definition.stableKey}`);
    }
    assert.ok(document.sections.every(section => section.stableKey.startsWith(`${template.id}:`)));
    assert.ok(document.sections.every(section => section.title !== '决定'));
    assert.equal(document.actionItemCandidates.length, 1);
    assert.equal(document.actionItemCandidates[0].citations[0].segmentId, 'action');
  }
});

test('template override stays local and Markdown contains one action copy', () => {
  const { result, transcriptLines } = fixture();
  const general = projectMeetingFactsV3(result, MEETING_TEMPLATES[0], 4, transcriptLines);
  const project = projectMeetingFactsV3(result, MEETING_TEMPLATES[2], 4, transcriptLines);
  const edited = applyMeetingSummaryV3Overrides(general, [{
    stableBlockKey: 'general:overview',
    replacementKind: 'paragraph',
    replacementText: '用户编辑后的概述',
    userEditedAtMs: 123,
  }]);

  assert.equal(edited.sections[0].content, '用户编辑后的概述');
  assert.equal(edited.sections[0].richBlock.originalSourceLabel, '原始依据');
  assert.notEqual(general.sections[0].content, edited.sections[0].content);
  assert.notEqual(project.sections[0].content, edited.sections[0].content);
  const markdown = meetingFactsV3Markdown(result, MEETING_TEMPLATES[0], 4);
  assert.equal(markdown.split('成员甲明天下午完成回归清单').length - 1, 1);
});

test('warm local projection remains comfortably inside the 100 ms switch budget', () => {
  const { result, transcriptLines } = fixture();
  for (const template of MEETING_TEMPLATES) {
    projectMeetingFactsV3(result, template, 4, transcriptLines);
  }
  const started = performance.now();
  for (let index = 0; index < 100; index += 1) {
    projectMeetingFactsV3(result, MEETING_TEMPLATES[index % MEETING_TEMPLATES.length], 4, transcriptLines);
  }
  assert.ok(performance.now() - started < 100);
});

test('interview follow-up questions are not hidden as an action section', () => {
  assert.equal(isNormalizedMeetingSummaryActionLabel('后续问题'), false);
  assert.equal(isNormalizedMeetingSummaryActionLabel('后续行动'), true);
});
