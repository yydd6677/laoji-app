import type { ScopeKey } from '../../domain/meeting';
import { secureClientIdFactory, type ClientIdFactory } from '../../domain/meeting';
import type {
  MeetingNoteRepository,
  MeetingOrganizationOptions,
  MeetingOrganizationProjection,
  MeetingSearchResult,
  MeetingTagAssignment,
  MeetingTagRecord,
  RenameMeetingTagResult,
} from '../../data/repositories/meetingNoteRepository';
import { requestMeetingTagCatalogSync } from './tagCatalogSyncTrigger';

export interface NormalizedMeetingTagName {
  name: string;
  normalizedName: string;
}

export function normalizeMeetingTagName(value: string): NormalizedMeetingTagName {
  const name = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!name || [...name].length > 30 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('标签名称需为 1 至 30 个字符。');
  }
  return { name, normalizedName: name.toLocaleLowerCase() };
}

export class ManageMeetingOrganizationUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  listTags(scopeKey: ScopeKey): Promise<readonly MeetingTagRecord[]> {
    return this.repository.listMeetingTagsForScope(scopeKey);
  }

  listAssignments(scopeKey: ScopeKey): Promise<readonly MeetingTagAssignment[]> {
    return this.repository.listMeetingTagAssignments(scopeKey);
  }

  listAggregates(
    scopeKey: ScopeKey,
    options?: MeetingOrganizationOptions,
  ): Promise<MeetingOrganizationProjection> {
    return this.repository.listMeetingOrganization(scopeKey, options);
  }

  async listMeetingTags(
    navigationMeetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingTagRecord[]> {
    const meetingId = await this.requireCanonicalMeetingId(navigationMeetingId, scopeKey);
    return this.repository.listMeetingTags(meetingId, scopeKey);
  }

  async createTag(scopeKey: ScopeKey, value: string): Promise<MeetingTagRecord> {
    const normalized = normalizeMeetingTagName(value);
    const nowMs = Date.now();
    const tag = await this.repository.createMeetingTag({
      id: this.idFactory.create(),
      scopeKey,
      ...normalized,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    requestMeetingTagCatalogSync(scopeKey);
    return tag;
  }

  async renameOrMergeTag(
    tagId: string,
    scopeKey: ScopeKey,
    value: string,
  ): Promise<RenameMeetingTagResult> {
    const normalized = normalizeMeetingTagName(value);
    const result = await this.repository.renameOrMergeMeetingTag(
      tagId,
      scopeKey,
      normalized.name,
      normalized.normalizedName,
      Date.now(),
    );
    requestMeetingTagCatalogSync(scopeKey);
    return result;
  }

  async deleteTag(tagId: string, scopeKey: ScopeKey): Promise<readonly string[]> {
    const result = await this.repository.deleteMeetingTag(tagId, scopeKey);
    requestMeetingTagCatalogSync(scopeKey);
    return result;
  }

  async replaceMeetingTags(
    navigationMeetingId: string,
    scopeKey: ScopeKey,
    tagIds: readonly string[],
  ): Promise<readonly MeetingTagRecord[]> {
    const meetingId = await this.requireCanonicalMeetingId(navigationMeetingId, scopeKey);
    const tags = await this.repository.replaceMeetingTags(meetingId, scopeKey, tagIds, Date.now());
    requestMeetingTagCatalogSync(scopeKey);
    return tags;
  }

  search(
    scopeKey: ScopeKey,
    query: string,
    limit = 60,
  ): Promise<readonly MeetingSearchResult[]> {
    return this.repository.searchMeetingContent(scopeKey, query, limit);
  }

  private async requireCanonicalMeetingId(
    navigationMeetingId: string,
    scopeKey: ScopeKey,
  ): Promise<string> {
    const meetingId = await this.repository.resolveCanonicalMeetingId(navigationMeetingId, scopeKey);
    if (!meetingId) throw new Error('会议记录尚未完成本机索引，请刷新后重试。');
    return meetingId;
  }
}
