import type { ScopeKey } from '../../domain/meeting';
import { secureClientIdFactory, type ClientIdFactory } from '../../domain/meeting';
import type {
  MeetingAttachmentRecord,
  MeetingNoteRepository,
} from '../../data/repositories/meetingNoteRepository';
import { requestMeetingAttachmentSync } from './attachmentSyncTrigger';
import { requestMeetingRootSync } from './rootSyncTrigger';

const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ManageMeetingAttachmentsUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  async list(
    navigationMeetingId: string,
    scopeKey: ScopeKey,
  ): Promise<readonly MeetingAttachmentRecord[]> {
    const meetingId = await this.requireCanonicalMeetingId(navigationMeetingId, scopeKey);
    return this.repository.listMeetingAttachments(meetingId, scopeKey);
  }

  async addText(input: {
    navigationMeetingId: string;
    scopeKey: ScopeKey;
    markerId: string;
    positionMs: number;
    text: string;
  }): Promise<MeetingAttachmentRecord> {
    const textContent = input.text.normalize('NFKC').trim();
    if (!textContent || [...textContent].length > 500 || /[\u0000]/.test(textContent)) {
      throw new Error('附件文字需为 1 至 500 个字符。');
    }
    const meetingId = await this.requireCanonicalMeetingId(input.navigationMeetingId, input.scopeKey);
    const nowMs = Date.now();
    const attachment = await this.repository.createMeetingAttachment({
      id: this.idFactory.create(),
      meetingId,
      markerId: input.markerId,
      positionMs: input.positionMs,
      kind: 'text',
      textContent,
      localUri: null,
      mimeType: null,
      fileName: null,
      byteSize: null,
      checksumSha256: null,
      remoteId: null,
      remoteRevision: null,
      syncState: input.scopeKey === 'guest' ? 'local' : 'pending',
      pendingOperation: input.scopeKey === 'guest' ? null : 'create',
      lastErrorCode: null,
      remoteUpdatedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    }, input.scopeKey);
    if (input.scopeKey !== 'guest') {
      requestMeetingRootSync(input.scopeKey);
      requestMeetingAttachmentSync(input.scopeKey);
    }
    return attachment;
  }

  async addImage(input: {
    attachmentId: string;
    navigationMeetingId: string;
    scopeKey: ScopeKey;
    markerId: string;
    positionMs: number;
    localUri: string;
    mimeType: string;
    fileName: string;
    byteSize: number;
    checksumSha256: string;
  }): Promise<MeetingAttachmentRecord> {
    const attachmentId = input.attachmentId.trim().toLowerCase();
    if (!SAFE_UUID.test(attachmentId)) throw new Error('图片附件标识无效。');
    const meetingId = await this.requireCanonicalMeetingId(input.navigationMeetingId, input.scopeKey);
    const nowMs = Date.now();
    const attachment = await this.repository.createMeetingAttachment({
      id: attachmentId,
      meetingId,
      markerId: input.markerId,
      positionMs: input.positionMs,
      kind: 'image',
      textContent: null,
      localUri: input.localUri,
      mimeType: input.mimeType,
      fileName: input.fileName,
      byteSize: input.byteSize,
      checksumSha256: input.checksumSha256,
      remoteId: null,
      remoteRevision: null,
      syncState: input.scopeKey === 'guest' ? 'local' : 'pending',
      pendingOperation: input.scopeKey === 'guest' ? null : 'create',
      lastErrorCode: null,
      remoteUpdatedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    }, input.scopeKey);
    if (input.scopeKey !== 'guest') {
      requestMeetingRootSync(input.scopeKey);
      requestMeetingAttachmentSync(input.scopeKey);
    }
    return attachment;
  }

  async delete(input: {
    attachmentId: string;
    navigationMeetingId: string;
    scopeKey: ScopeKey;
  }): Promise<MeetingAttachmentRecord | null> {
    const meetingId = await this.requireCanonicalMeetingId(input.navigationMeetingId, input.scopeKey);
    const attachment = await this.repository.deleteMeetingAttachment(
      input.attachmentId,
      meetingId,
      input.scopeKey,
    );
    if (attachment && input.scopeKey !== 'guest') requestMeetingAttachmentSync(input.scopeKey);
    return attachment;
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
