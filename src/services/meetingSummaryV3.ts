import type {
  MeetingActionCandidateV3,
  MeetingFactCertaintyV3,
  MeetingFactRelationV3,
  MeetingFactSourceV3,
  MeetingFactTypeV3,
  MeetingFactV3,
  MeetingFactsDocumentV3,
  MeetingFactsResultV3,
  MeetingSummaryCitation,
  MeetingSummaryDocument,
  MeetingSummaryRichBlock,
  MeetingSummarySection,
  MeetingTemplate,
} from '../domain/meeting';
import type { MeetingSummary } from '../types';

const FACT_TYPES = new Set<MeetingFactTypeV3>([
  'topic', 'context', 'conclusion', 'action', 'risk', 'question', 'quote', 'timeline',
]);
const CERTAINTIES = new Set<MeetingFactCertaintyV3>([
  'confirmed', 'proposed', 'uncertain', 'negated', 'completed',
]);
const RELATIONS = new Set<MeetingFactRelationV3['relationType']>([
  'supports', 'contradicts', 'precedes', 'depends_on', 'alternative',
]);
const SOURCE_TYPES = new Set<MeetingFactSourceV3['sourceType']>([
  'transcript', 'manual_note', 'attachment',
]);
const TEMPLATE_IDS = new Set<MeetingTemplate['id']>([
  'general', 'one_on_one', 'project_sync', 'interview',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maximum: number, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximum || /\u0000/.test(normalized)) return null;
  return normalized;
}

function integer(value: unknown, minimum = 0): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : null;
}

function finite(value: unknown, minimum = 0, maximum = 1): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function parseSource(value: unknown): MeetingFactSourceV3 | null {
  const item = record(value);
  if (!item) return null;
  const sourceId = text(item.source_id, 220);
  const sourceType = text(item.source_type, 32) as MeetingFactSourceV3['sourceType'] | null;
  const quote = text(item.quote, 600);
  const contentHash = text(item.content_hash, 71);
  if (
    !sourceId || !sourceType || !SOURCE_TYPES.has(sourceType) || !quote || !contentHash
    || !/^sha256:[0-9a-f]{64}$/.test(contentHash)
  ) return null;
  const startMs = item.start_ms == null ? null : integer(item.start_ms);
  const endMs = item.end_ms == null ? startMs : integer(item.end_ms);
  if ((item.start_ms != null && startMs === null) || (item.end_ms != null && endMs === null)) return null;
  if (startMs !== null && endMs !== null && endMs < startMs) return null;
  return {
    sourceId,
    sourceType,
    quote,
    contentHash,
    startMs,
    endMs,
    speaker: item.speaker == null ? null : text(item.speaker, 100),
  };
}

function parseFact(value: unknown): MeetingFactV3 | null {
  const item = record(value);
  if (!item) return null;
  const factId = text(item.fact_id, 64);
  const factType = text(item.fact_type, 32) as MeetingFactTypeV3 | null;
  const certainty = text(item.certainty, 32) as MeetingFactCertaintyV3 | null;
  const content = text(item.content, 500);
  const evidenceScore = finite(item.evidence_score);
  const sources = Array.isArray(item.sources) ? item.sources.map(parseSource) : [];
  if (
    !factId || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(factId)
    || !factType || !FACT_TYPES.has(factType)
    || !certainty || !CERTAINTIES.has(certainty)
    || !content || evidenceScore === null
    || sources.length < 1 || sources.length > 3 || sources.some(source => source === null)
  ) return null;
  const conflictGroupId = item.conflict_group_id == null
    ? null
    : text(item.conflict_group_id, 32);
  if (conflictGroupId !== null && !/^conflict:[0-9a-f]{16}$/.test(conflictGroupId)) return null;
  return {
    factId,
    factType,
    certainty,
    content,
    sources: sources as MeetingFactSourceV3[],
    evidenceScore,
    conflictGroupId,
  };
}

function parseRelation(value: unknown): MeetingFactRelationV3 | null {
  const item = record(value);
  if (!item) return null;
  const relationType = text(item.relation_type, 32) as MeetingFactRelationV3['relationType'] | null;
  const fromFactId = text(item.from_fact_id, 64);
  const toFactId = text(item.to_fact_id, 64);
  return relationType && RELATIONS.has(relationType) && fromFactId && toFactId && fromFactId !== toFactId
    ? { relationType, fromFactId, toFactId }
    : null;
}

function parseAction(value: unknown): MeetingActionCandidateV3 | null {
  const item = record(value);
  if (!item) return null;
  const actionId = text(item.action_id, 64);
  const factId = text(item.fact_id, 64);
  const content = text(item.content, 300);
  const scheduleFit = text(item.schedule_fit, 16) as MeetingActionCandidateV3['scheduleFit'] | null;
  const evidenceScore = finite(item.evidence_score);
  if (
    !actionId || !factId || !content || !scheduleFit
    || !['high', 'medium', 'low'].includes(scheduleFit) || evidenceScore === null
  ) return null;
  const owner = item.owner == null ? null : text(item.owner, 80);
  const dueText = item.due_text == null ? null : text(item.due_text, 120);
  if ((item.owner != null && owner === null) || (item.due_text != null && dueText === null)) return null;
  return { actionId, factId, content, owner, dueText, scheduleFit, evidenceScore };
}

function parseFactsDocument(value: unknown): MeetingFactsDocumentV3 | null {
  const root = record(value);
  const overview = record(root?.overview);
  const overviewText = text(overview?.text, 160);
  const overviewIds = Array.isArray(overview?.fact_ids)
    ? overview!.fact_ids.map(value => text(value, 64))
    : [];
  const facts = Array.isArray(root?.facts) ? root!.facts.map(parseFact) : [];
  const relations = Array.isArray(root?.relations) ? root!.relations.map(parseRelation) : [];
  const actions = Array.isArray(root?.action_candidates) ? root!.action_candidates.map(parseAction) : [];
  if (
    root?.schema_version !== 3 || !overviewText
    || overviewIds.length < 1 || overviewIds.some(id => id === null)
    || facts.length < 1 || facts.length > 40 || facts.some(fact => fact === null)
    || relations.length > 48 || relations.some(relation => relation === null)
    || actions.length > 10 || actions.some(action => action === null)
  ) return null;
  const resolvedFacts = facts as MeetingFactV3[];
  const factIds = new Set(resolvedFacts.map(fact => fact.factId));
  if (factIds.size !== resolvedFacts.length || overviewIds.some(id => !factIds.has(id!))) return null;
  const resolvedRelations = relations as MeetingFactRelationV3[];
  if (resolvedRelations.some(relation => !factIds.has(relation.fromFactId) || !factIds.has(relation.toFactId))) return null;
  const resolvedActions = actions as MeetingActionCandidateV3[];
  if (resolvedActions.some(action => !factIds.has(action.factId))) return null;
  return {
    schemaVersion: 3,
    overview: { text: overviewText, factIds: overviewIds as string[] },
    facts: resolvedFacts,
    relations: resolvedRelations,
    actionCandidates: resolvedActions,
  };
}

export function parseMeetingFactsResultV3(value: unknown): MeetingFactsResultV3 | null {
  const root = record(value);
  const coverage = record(root?.coverage);
  const factsDocument = parseFactsDocument(root?.facts_document);
  const documentId = text(root?.document_id, 160);
  const meetingId = text(root?.meeting_id, 160);
  const sourceFingerprint = text(root?.source_fingerprint, 80);
  const transcriptRevision = text(root?.transcript_revision, 512);
  const modelRevision = text(root?.model_revision, 160);
  const promptRevision = text(root?.prompt_revision, 80);
  const generatedAt = text(root?.generated_at, 80);
  const sourceTypes = Array.isArray(coverage?.source_types)
    ? coverage!.source_types.filter((item): item is MeetingFactSourceV3['sourceType'] => SOURCE_TYPES.has(item as MeetingFactSourceV3['sourceType']))
    : [];
  const includedSourceTypes = Array.isArray(coverage?.included_source_types)
    ? coverage!.included_source_types.filter((item): item is MeetingFactSourceV3['sourceType'] => SOURCE_TYPES.has(item as MeetingFactSourceV3['sourceType']))
    : [];
  if (
    root?.schema_version !== 3 || !factsDocument || !documentId || !meetingId
    || !sourceFingerprint || !/^sha256:[0-9a-f]{64}$/.test(sourceFingerprint)
    || !transcriptRevision || !modelRevision || !promptRevision || !generatedAt
    || !Number.isFinite(Date.parse(generatedAt)) || !coverage
  ) return null;
  const totalSegments = integer(coverage.total_segments);
  const includedSegments = integer(coverage.included_segments);
  const topicGroups = integer(coverage.topic_groups);
  const coveredTopicGroups = integer(coverage.covered_topic_groups);
  const topicCoverage = finite(coverage.topic_coverage);
  const sourceCoverage = finite(coverage.source_coverage);
  const inputTokenBudget = integer(coverage.input_token_budget, 1);
  const estimatedInputTokens = integer(coverage.estimated_input_tokens);
  if (
    totalSegments === null || includedSegments === null || includedSegments > totalSegments
    || topicGroups === null || coveredTopicGroups === null || coveredTopicGroups > topicGroups
    || topicCoverage === null || sourceCoverage === null
    || inputTokenBudget === null || estimatedInputTokens === null || estimatedInputTokens > inputTokenBudget
    || coverage.used_embeddings !== true && coverage.used_embeddings !== false
  ) return null;
  return {
    documentId,
    meetingId,
    factsDocument,
    sourceFingerprint,
    transcriptRevision,
    modelRevision,
    promptRevision,
    generatedAt,
    coverage: {
      totalSegments,
      includedSegments,
      topicGroups,
      coveredTopicGroups,
      topicCoverage,
      sourceTypes,
      includedSourceTypes,
      sourceCoverage,
      usedEmbeddings: coverage.used_embeddings,
      inputTokenBudget,
      estimatedInputTokens,
    },
  };
}

export function meetingFactsResultV3ToWire(result: MeetingFactsResultV3): Record<string, unknown> {
  return {
    schema_version: 3,
    document_id: result.documentId,
    meeting_id: result.meetingId,
    source_fingerprint: result.sourceFingerprint,
    transcript_revision: result.transcriptRevision,
    model_revision: result.modelRevision,
    prompt_revision: result.promptRevision,
    generated_at: result.generatedAt,
    coverage: {
      total_segments: result.coverage.totalSegments,
      included_segments: result.coverage.includedSegments,
      topic_groups: result.coverage.topicGroups,
      covered_topic_groups: result.coverage.coveredTopicGroups,
      topic_coverage: result.coverage.topicCoverage,
      source_types: result.coverage.sourceTypes,
      included_source_types: result.coverage.includedSourceTypes,
      source_coverage: result.coverage.sourceCoverage,
      used_embeddings: result.coverage.usedEmbeddings,
      input_token_budget: result.coverage.inputTokenBudget,
      estimated_input_tokens: result.coverage.estimatedInputTokens,
    },
    facts_document: {
      schema_version: 3,
      overview: {
        text: result.factsDocument.overview.text,
        fact_ids: result.factsDocument.overview.factIds,
      },
      facts: result.factsDocument.facts.map(fact => ({
        fact_id: fact.factId,
        fact_type: fact.factType,
        certainty: fact.certainty,
        content: fact.content,
        evidence_score: fact.evidenceScore,
        conflict_group_id: fact.conflictGroupId,
        sources: fact.sources.map(source => ({
          source_id: source.sourceId,
          source_type: source.sourceType,
          quote: source.quote,
          content_hash: source.contentHash,
          start_ms: source.startMs,
          end_ms: source.endMs,
          speaker: source.speaker,
        })),
      })),
      relations: result.factsDocument.relations.map(relation => ({
        relation_type: relation.relationType,
        from_fact_id: relation.fromFactId,
        to_fact_id: relation.toFactId,
      })),
      action_candidates: result.factsDocument.actionCandidates.map(action => ({
        action_id: action.actionId,
        fact_id: action.factId,
        content: action.content,
        owner: action.owner,
        due_text: action.dueText,
        schedule_fit: action.scheduleFit,
        evidence_score: action.evidenceScore,
      })),
    },
  };
}

function certaintyPrefix(certainty: MeetingFactCertaintyV3): string {
  if (certainty === 'proposed') return '建议：';
  if (certainty === 'uncertain') return '待确认：';
  if (certainty === 'negated') return '已否定：';
  if (certainty === 'completed') return '已完成：';
  return '';
}

function factText(fact: MeetingFactV3): string {
  return `${certaintyPrefix(fact.certainty)}${fact.content}`;
}

function transcriptCitations(facts: readonly MeetingFactV3[], sectionKey: string): MeetingSummaryCitation[] {
  const seen = new Set<string>();
  const citations: MeetingSummaryCitation[] = [];
  facts.forEach(fact => fact.sources.forEach(source => {
    if (source.sourceType !== 'transcript' || source.startMs === null || seen.has(source.sourceId)) return;
    seen.add(source.sourceId);
    citations.push({
      id: `${sectionKey}:citation:${citations.length}:${source.sourceId}`,
      segmentId: source.sourceId.replace(/^transcript:/, ''),
      startMs: source.startMs,
      endMs: source.endMs ?? source.startMs,
      quoteHash: source.contentHash,
      sourceType: source.sourceType,
      sourceLabel: source.speaker,
    });
  }));
  return citations;
}

function sourceLabel(source: MeetingFactSourceV3 | undefined): string | null {
  if (source?.sourceType === 'manual_note') return '我的笔记';
  if (source?.sourceType === 'attachment') return '附件';
  return source?.speaker ?? null;
}

function richItems(facts: readonly MeetingFactV3[]) {
  return facts.map(fact => {
    const source = fact.sources[0];
    return {
      id: fact.factId,
      title: null,
      text: factText(fact),
      meta: sourceLabel(source),
      sourceId: source?.sourceId ?? null,
      startMs: source?.startMs ?? null,
    };
  });
}

function quoteItems(facts: readonly MeetingFactV3[]) {
  const seen = new Set<string>();
  return facts.flatMap(fact => {
    const source = fact.sources.find(candidate => {
      const identity = `${candidate.sourceId}\u0000${candidate.quote}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    if (!source) return [];
    return [{
      id: `${fact.factId}:quote:${source.sourceId}`,
      title: null,
      text: source.quote,
      meta: sourceLabel(source),
      sourceId: source.sourceId,
      startMs: source.startMs,
    }];
  }).slice(0, 8);
}

function section(
  template: MeetingTemplate,
  stableKey: string,
  title: string,
  kind: MeetingSummaryRichBlock['kind'],
  iconKey: MeetingSummaryRichBlock['iconKey'],
  facts: readonly MeetingFactV3[],
  options: {
    edges?: MeetingSummaryRichBlock['edges'];
    text?: string;
    useSourceQuotes?: boolean;
  } = {},
): MeetingSummarySection | null {
  const key = `${template.id}:${stableKey}`;
  const items = options.text !== undefined
    ? [{
      id: `${key}:text`,
      title: null,
      text: options.text,
      meta: null,
      sourceId: null,
      startMs: null,
    }]
    : options.useSourceQuotes
      ? quoteItems(facts)
      : richItems(facts);
  const content = options.text ?? items.map(item => item.text).join('\n');
  if (!content.trim()) return null;
  return {
    id: key,
    stableKey: key,
    kind,
    title,
    content,
    citations: transcriptCitations(facts, key),
    richBlock: {
      kind,
      iconKey,
      items,
      ...(options.edges ? { edges: options.edges } : {}),
    },
  };
}

function factsOf(document: MeetingFactsDocumentV3, ...types: MeetingFactTypeV3[]): MeetingFactV3[] {
  const wanted = new Set(types);
  return document.facts.filter(fact => wanted.has(fact.factType));
}

function flowSection(document: MeetingFactsDocumentV3, template: MeetingTemplate): MeetingSummarySection | null {
  const relations = document.relations.filter(relation => (
    relation.relationType === 'precedes' || relation.relationType === 'depends_on'
  )).slice(0, 10);
  const byId = new Map(document.facts.map(fact => [fact.factId, fact]));
  const nodeIds = [...new Set(relations.flatMap(relation => [relation.fromFactId, relation.toFactId]))].slice(0, 8);
  const facts = nodeIds.map(id => byId.get(id)).filter((fact): fact is MeetingFactV3 => Boolean(fact));
  if (facts.length < 2) return null;
  const nodeSet = new Set(facts.map(fact => fact.factId));
  const edges = relations
    .filter(relation => nodeSet.has(relation.fromFactId) && nodeSet.has(relation.toFactId))
    .map(relation => ({
      from: relation.fromFactId,
      to: relation.toFactId,
      label: relation.relationType === 'depends_on' ? '依赖' : null,
    }));
  const adjacency = new Map<string, string[]>();
  edges.forEach(edge => adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((adjacency.get(id) ?? []).some(cyclic)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  const hasCycle = facts.some(fact => cyclic(fact.factId));
  return section(
    template,
    'dependencies',
    '依赖与流程',
    hasCycle || edges.length === 0 ? 'bullet_group' : 'flow',
    'flow',
    facts,
    hasCycle ? {} : { edges },
  );
}

function statSection(document: MeetingFactsDocumentV3, template: MeetingTemplate): MeetingSummarySection | null {
  const facts = document.facts.filter(fact => /\d+(?:\.\d+)?(?:%|％|万|亿|元|人|次|个|天|周|月|年)?/.test(fact.content)).slice(0, 4);
  return section(template, 'numbers', '明确数字', 'stat', 'stat', facts);
}

const EXPLICIT_TIME = /(?:今天|明天|后天|本周|下周|本月|下月|月底|年底|季度|周[一二三四五六日天]|星期[一二三四五六日天]|(?:上午|下午|晚上|凌晨)|\d{1,4}(?:年|月|日|号|点|时|分))/;

function timelineFacts(document: MeetingFactsDocumentV3): MeetingFactV3[] {
  return factsOf(document, 'timeline').filter(fact => (
    fact.sources.some(source => source.startMs !== null)
    || EXPLICIT_TIME.test(fact.sources.map(source => source.quote).join(' '))
  )).slice(0, 12);
}

function comparisonSection(document: MeetingFactsDocumentV3, template: MeetingTemplate): MeetingSummarySection | null {
  const ids = [...new Set(document.relations
    .filter(relation => relation.relationType === 'alternative')
    .flatMap(relation => [relation.fromFactId, relation.toFactId]))].slice(0, 3);
  const byId = new Map(document.facts.map(fact => [fact.factId, fact]));
  const facts = ids.map(id => byId.get(id)).filter((fact): fact is MeetingFactV3 => Boolean(fact));
  return facts.length >= 2
    ? section(template, 'alternatives', '方案对比', 'comparison', 'compare', facts)
    : null;
}

export interface MeetingSummaryViewOverrideInputV3 {
  stableBlockKey: string;
  replacementKind: 'paragraph' | 'bullet_group';
  replacementText: string;
  userEditedAtMs: number;
}

export function applyMeetingSummaryV3Overrides(
  document: MeetingSummaryDocument,
  overrides: readonly MeetingSummaryViewOverrideInputV3[],
): MeetingSummaryDocument {
  if (overrides.length === 0) return document;
  const byKey = new Map(overrides.map(override => [override.stableBlockKey, override]));
  return {
    ...document,
    sections: document.sections.map(section => {
      const override = byKey.get(section.stableKey);
      if (!override) return section;
      const content = override.replacementText.replace(/\r\n?/g, '\n').trim();
      if (!content) return section;
      const itemTexts = override.replacementKind === 'paragraph'
        ? [content]
        : content.split('\n').map(item => item.trim()).filter(Boolean);
      return {
        ...section,
        kind: override.replacementKind,
        content,
        userEdited: true,
        userEditedAtMs: override.userEditedAtMs,
        richBlock: {
          kind: override.replacementKind,
          iconKey: section.richBlock?.iconKey ?? 'overview',
          items: itemTexts.map((item, index) => ({
            id: `${section.stableKey}:override:${index}`,
            title: null,
            text: item,
            meta: null,
            sourceId: null,
            startMs: null,
          })),
          edited: true,
          originalSourceLabel: '原始依据',
        },
      };
    }),
  };
}

export function projectMeetingFactsV3(
  result: MeetingFactsResultV3,
  template: MeetingTemplate,
  manualNoteRevision: number,
): MeetingSummaryDocument {
  if (!TEMPLATE_IDS.has(template.id) || template.revision !== 3) {
    throw new Error('整理模板版本无效');
  }
  const document = result.factsDocument;
  const sections: Array<MeetingSummarySection | null> = [];
  const overviewFacts = document.overview.factIds
    .map(id => document.facts.find(fact => fact.factId === id))
    .filter((fact): fact is MeetingFactV3 => Boolean(fact));
  sections.push(section(template, 'overview', '概述', 'paragraph', 'overview', overviewFacts, {
    text: document.overview.text,
  }));

  if (template.id === 'general') {
    sections.push(section(template, 'topics', '主要议题', 'bullet_group', 'topic', factsOf(document, 'topic', 'context', 'question')));
    sections.push(section(template, 'conclusions', '关键结论', 'bullet_group', 'topic', factsOf(document, 'conclusion')));
    sections.push(section(template, 'representative_quote', '代表性引用', 'quote', 'quote', factsOf(document, 'quote').slice(0, 3), { useSourceQuotes: true }));
    sections.push(statSection(document, template));
  } else if (template.id === 'one_on_one') {
    sections.push(section(template, 'discussion', '讨论主题', 'bullet_group', 'topic', factsOf(document, 'topic', 'context')));
    sections.push(section(template, 'feedback', '反馈与关注', 'quote', 'quote', factsOf(document, 'quote', 'risk'), { useSourceQuotes: true }));
    sections.push(section(template, 'support', '支持需求', 'bullet_group', 'action', factsOf(document, 'question')));
  } else if (template.id === 'project_sync') {
    sections.push(section(template, 'progress', '进展', 'bullet_group', 'topic', document.facts.filter(fact => fact.certainty === 'completed' || fact.factType === 'context' || fact.factType === 'conclusion')));
    sections.push(section(template, 'risks', '风险与阻塞', 'risk_card', 'risk', factsOf(document, 'risk')));
    sections.push(section(template, 'timeline', '范围和里程碑', 'timeline', 'time', timelineFacts(document)));
    sections.push(flowSection(document, template));
  } else {
    sections.push(section(template, 'topics', '主题', 'bullet_group', 'topic', factsOf(document, 'topic', 'context')));
    sections.push(section(template, 'views', '受访者观点', 'quote', 'quote', document.facts.filter(fact => fact.factType === 'quote' || fact.sources.some(source => Boolean(source.speaker))).slice(0, 8), { useSourceQuotes: true }));
    sections.push(section(template, 'evidence', '证据摘录', 'quote', 'quote', factsOf(document, 'quote').slice(0, 6), { useSourceQuotes: true }));
    sections.push(section(template, 'follow_up_questions', '后续问题', 'bullet_group', 'topic', factsOf(document, 'question')));
  }
  sections.push(comparisonSection(document, template));

  const factsById = new Map(document.facts.map(fact => [fact.factId, fact]));
  const actions = document.actionCandidates.map(action => {
    const fact = factsById.get(action.factId);
    const citations = fact ? transcriptCitations([fact], `${template.id}:action:${action.actionId}`) : [];
    return {
      id: action.actionId,
      content: action.content,
      assignee: action.owner,
      dueAtMs: null,
      dueText: action.dueText,
      reminderAtMs: null,
      reminderNotificationId: null,
      followupEventSourceId: null,
      status: 'pending' as const,
      citations,
      sourceSegmentId: citations[0]?.segmentId ?? null,
      sourceStartMs: citations[0]?.startMs ?? null,
      scheduleFit: action.scheduleFit,
      evidenceScore: action.evidenceScore,
    };
  });
  const generatedAtMs = Date.parse(result.generatedAt);
  return {
    schemaVersion: 2,
    remoteVersionId: result.documentId,
    meetingId: result.meetingId,
    templateId: template.id,
    templateRevision: 3,
    transcriptRevisionId: null,
    manualNoteRevision,
    scheduleSnapshotHash: result.sourceFingerprint,
    status: 'ready',
    generatedBy: result.modelRevision,
    supersedesVersionId: null,
    createdAtMs: Number.isFinite(generatedAtMs) ? generatedAtMs : Date.now(),
    completedAtMs: Number.isFinite(generatedAtMs) ? generatedAtMs : Date.now(),
    sections: sections.filter((item): item is MeetingSummarySection => Boolean(item)),
    actionItemCandidates: actions,
  };
}

export function meetingFactsV3ToSummary(
  result: MeetingFactsResultV3,
  template: MeetingTemplate,
  manualNoteRevision: number,
): MeetingSummary {
  const structured = projectMeetingFactsV3(result, template, manualNoteRevision);
  return {
    id: result.documentId,
    meeting_id: result.meetingId,
    overview: result.factsDocument.overview.text,
    generated_at: result.generatedAt,
    structured_document: structured,
    facts_document_v3: result,
    action_items: structured.actionItemCandidates.map(action => ({
      id: action.id,
      content: action.content,
      assignee: action.assignee,
      due_date: action.dueText ?? null,
      status: action.status,
    })),
  };
}

export function meetingFactsV3Markdown(
  result: MeetingFactsResultV3,
  template: MeetingTemplate,
  manualNoteRevision: number,
): string {
  const document = projectMeetingFactsV3(result, template, manualNoteRevision);
  return meetingSummaryV3DocumentMarkdown(document);
}

export function meetingSummaryV3DocumentMarkdown(document: MeetingSummaryDocument): string {
  const sections = document.sections.map(section => {
    const lines = section.content.split('\n').map(line => line.trim()).filter(Boolean);
    const body = section.kind === 'paragraph'
      ? section.content
      : section.kind === 'quote'
        ? lines.map(line => `> ${line}`).join('\n')
        : lines.map(line => `- ${line}`).join('\n');
    return `## ${section.title ?? '整理内容'}\n\n${body}`;
  });
  if (document.actionItemCandidates.length > 0) {
    sections.push(`## 行动候选\n\n${document.actionItemCandidates.map(action => `- ${action.content}`).join('\n')}`);
  }
  return sections.join('\n\n').trim();
}
