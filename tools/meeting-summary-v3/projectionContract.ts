import type { MeetingFactsResultV3, MeetingTemplate } from '../../src/domain/meeting';
import {
  applyMeetingSummaryV3Overrides,
  projectMeetingFactsV3,
} from '../../src/services/meetingSummaryV3';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const transcriptHash = `sha256:${'1'.repeat(64)}`;
const noteHash = `sha256:${'2'.repeat(64)}`;
const result: MeetingFactsResultV3 = {
  documentId: 'document-v3-contract',
  meetingId: 'meeting-v3-contract',
  sourceFingerprint: `sha256:${'3'.repeat(64)}`,
  transcriptRevision: `sha256:${'4'.repeat(64)}`,
  modelRevision: 'ollama:qwen3.5:9b',
  promptRevision: 'facts-v3-r4',
  generatedAt: '2026-08-15T08:00:00.000Z',
  coverage: {
    totalSegments: 8,
    includedSegments: 8,
    topicGroups: 3,
    coveredTopicGroups: 3,
    topicCoverage: 1,
    sourceTypes: ['transcript', 'manual_note'],
    includedSourceTypes: ['transcript', 'manual_note'],
    sourceCoverage: 1,
    usedEmbeddings: false,
    inputTokenBudget: 10_240,
    estimatedInputTokens: 640,
  },
  factsDocument: {
    schemaVersion: 3,
    overview: { text: '团队确认了上线范围、风险和后续验证安排。', factIds: ['topic', 'conclusion'] },
    facts: [
      {
        factId: 'topic', factType: 'topic', certainty: 'confirmed', content: '讨论上线范围',
        evidenceScore: 0.88, conflictGroupId: null,
        sources: [{
          sourceId: 'transcript:segment-1', sourceType: 'transcript', quote: '我们先讨论这次上线范围。',
          contentHash: transcriptHash, startMs: 1_000, endMs: 3_000, speaker: '林清',
        }],
      },
      {
        factId: 'conclusion', factType: 'conclusion', certainty: 'confirmed', content: '首批仅开放内部验证',
        evidenceScore: 0.9, conflictGroupId: null,
        sources: [{
          sourceId: 'manual_note:2:0', sourceType: 'manual_note', quote: '首批仅开放内部验证。',
          contentHash: noteHash, startMs: null, endMs: null, speaker: null,
        }],
      },
      {
        factId: 'risk', factType: 'risk', certainty: 'confirmed', content: '导入路径仍需回归',
        evidenceScore: 0.84, conflictGroupId: null,
        sources: [{
          sourceId: 'transcript:segment-2', sourceType: 'transcript', quote: '导入路径仍需回归。',
          contentHash: transcriptHash, startMs: 4_000, endMs: 6_000, speaker: '周禾',
        }],
      },
      {
        factId: 'quote', factType: 'quote', certainty: 'confirmed', content: '上线标准是稳定而不是功能堆叠',
        evidenceScore: 0.86, conflictGroupId: null,
        sources: [{
          sourceId: 'transcript:segment-3', sourceType: 'transcript', quote: '上线标准是稳定，而不是功能堆叠。',
          contentHash: transcriptHash, startMs: 7_000, endMs: 9_000, speaker: '林清',
        }],
      },
      {
        factId: 'timeline', factType: 'timeline', certainty: 'proposed', content: '下周一完成回归',
        evidenceScore: 0.78, conflictGroupId: null,
        sources: [{
          sourceId: 'transcript:segment-4', sourceType: 'transcript', quote: '计划下周一完成回归。',
          contentHash: transcriptHash, startMs: 10_000, endMs: 12_000, speaker: '周禾',
        }],
      },
      {
        factId: 'action', factType: 'action', certainty: 'confirmed', content: '周禾整理回归清单',
        evidenceScore: 0.91, conflictGroupId: null,
        sources: [{
          sourceId: 'transcript:segment-5', sourceType: 'transcript', quote: '由周禾整理回归清单。',
          contentHash: transcriptHash, startMs: 13_000, endMs: 15_000, speaker: '林清',
        }],
      },
    ],
    relations: [
      { relationType: 'precedes', fromFactId: 'topic', toFactId: 'timeline' },
      { relationType: 'depends_on', fromFactId: 'timeline', toFactId: 'action' },
      { relationType: 'alternative', fromFactId: 'conclusion', toFactId: 'risk' },
    ],
    actionCandidates: [{
      actionId: 'action-1', factId: 'action', content: '整理回归清单', owner: '周禾',
      dueText: null, scheduleFit: 'medium', evidenceScore: 0.91,
    }],
  },
};

const templateIds = ['general', 'one_on_one', 'project_sync', 'interview'] as const;
const templates = templateIds.map(id => ({ id, revision: 3, title: id, sectionSchema: [], actionExtraction: 'standard' } as MeetingTemplate));
const sourceBefore = JSON.stringify(result.factsDocument);
const projected = templates.map(template => projectMeetingFactsV3(result, template, 2));
check(JSON.stringify(result.factsDocument) === sourceBefore, 'template projection mutated the fact document');

const actionIdentity = projected.map(document => JSON.stringify(document.actionItemCandidates.map(action => ({
  id: action.id,
  content: action.content,
  assignee: action.assignee,
  dueText: action.dueText,
  citationHashes: action.citations.map(citation => citation.quoteHash),
}))));
check(new Set(actionIdentity).size === 1, 'template projection changed actions or citation hashes');
check(projected.every(document => document.actionItemCandidates.length === 1), 'action candidates were duplicated');

const general = projected[0];
const overview = general.sections.find(section => section.stableKey === 'general:overview');
check(overview?.richBlock?.items[0]?.text === result.factsDocument.overview.text, 'overview block does not render overview text');
const representativeQuote = general.sections.find(section => section.stableKey === 'general:representative_quote');
check(representativeQuote?.richBlock?.items[0]?.text === '上线标准是稳定，而不是功能堆叠。', 'quote block is not verbatim evidence');

const overridden = applyMeetingSummaryV3Overrides(general, [{
  stableBlockKey: 'general:overview',
  replacementKind: 'paragraph',
  replacementText: '这是用户编辑后的通用概述。',
  userEditedAtMs: 123,
}]);
check(overridden.sections.find(section => section.stableKey === 'general:overview')?.userEdited === true, 'general override was not applied');
check(projected[2].sections.every(section => !section.userEdited), 'general override leaked into another template');

for (const template of templates) {
  const started = performance.now();
  for (let index = 0; index < 250; index += 1) projectMeetingFactsV3(result, template, 2);
  const averageMs = (performance.now() - started) / 250;
  check(averageMs < 100, `${template.id} warm projection exceeded 100ms: ${averageMs.toFixed(2)}ms`);
}
