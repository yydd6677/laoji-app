import * as Crypto from 'expo-crypto';
import {
  DeviceV2ApiError,
  deviceV2Request,
  loadDeviceV2Capabilities,
} from './deviceV2Api';

const CONTRACT_REVISION = 'source.stream.v2' as const;
const MAX_MANIFEST_DESCRIPTORS = 10_000;
const MAX_BUNDLE_ITEMS = 50_000;

export type SourceStreamCapability = 'summary' | 'question';
export type SourceStreamSourceType = 'transcript' | 'manual_note' | 'attachment';

export interface DeviceV2SourceStreamSnapshot {
  schema_version: 2;
  contract_revision: typeof CONTRACT_REVISION;
  stream_id: string;
  task_id: string;
  binding_id: string;
  binding_generation: string;
  binding_revision: number;
  cancel_revision: number;
  client_operation_id: string;
  generation_id: string;
  state: 'open' | 'consuming' | 'complete' | 'cancelled' | 'expired';
  next_manifest_page: number;
  next_manifest_chapter: number;
  next_consumable_chapter: number;
  final_chapter_count: number | null;
  source_manifest_sha256: string | null;
  checkpoint_through_chapter: number | null;
  expires_at: number;
}

export interface SourceStreamBindingFence {
  bindingId: string;
  bindingGeneration: string;
  bindingRevision: number;
  cancelRevision: number;
}

export interface CreateDeviceV2SourceStreamInput extends SourceStreamBindingFence {
  taskId: string;
  streamId?: string;
  clientOperationId: string;
  generationId: string;
  requestSha256: string;
  capability: SourceStreamCapability;
  entityId: string;
  entityRevision: number;
  taskInputSha256: string;
}

export interface SourceManifestDescriptor {
  chapter_ordinal: number;
  declared_bundle_count: number;
  declared_item_count: number;
  declared_uncompressed_bytes: number;
  chapter_sha256: string;
}

export interface SourceBundleItem {
  item_id: string;
  source_type: SourceStreamSourceType;
  source_id: string;
  source_revision_id: string;
  source_start_utf8: number;
  source_end_utf8: number;
  content_sha256: string;
  content: string;
  start_ms?: number | null;
  end_ms?: number | null;
  speaker?: string | null;
}

export interface SourceBundleGroupInput {
  groupId: string;
  chapterOrdinal: number;
  declaredBundleCount: number;
  declaredItemCount: number;
  declaredUncompressedBytes: number;
  chapterSha256: string;
  requestSha256: string;
}

export interface SourceBundleInput {
  bundleId: string;
  ordinal: number;
  bundleSha256: string;
  items: readonly SourceBundleItem[];
}

export interface DeviceV2SourceBundleGroup {
  schema_version: 2;
  group_id: string;
  stream_id: string;
  chapter_ordinal: number;
  state: 'open' | 'committed' | 'consumed' | 'cancelled';
  next_bundle_ordinal: number;
  declared_bundle_count: number;
  declared_item_count: number;
  declared_uncompressed_bytes: number;
  chapter_sha256: string;
  bundle_count: number;
  item_count: number;
}

export class DeviceV2SourceStreamUnavailableError extends Error {
  constructor() {
    super('来源流服务尚未启用');
    this.name = 'DeviceV2SourceStreamUnavailableError';
  }
}

function id(value: string, field: string, maximum = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field}无效`);
  }
  return normalized;
}

function contentText(value: string, field: string, maximum: number): string {
  if (!value || value.length > maximum || /[\u0000]/.test(value)) throw new Error(`${field}无效`);
  return value;
}

function sha256(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error(`${field}无效`);
  return normalized;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}无效`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  const normalized = nonNegativeInteger(value, field);
  if (normalized < 1) throw new Error(`${field}无效`);
  return normalized;
}

function boundedInteger(value: number, field: string, maximum: number): number {
  const normalized = positiveInteger(value, field);
  if (normalized > maximum) throw new Error(`${field}无效`);
  return normalized;
}

function optionalTime(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  const normalized = nonNegativeInteger(value, field);
  if (normalized > 604_800_000) throw new Error(`${field}无效`);
  return normalized;
}

function optionalSpeaker(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return id(value, 'speaker', 100);
}

function generation(value: string, field: string): string {
  const normalized = id(value, field, 64).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new Error(`${field}无效`);
  return normalized;
}

function bodyBase(): { schema_version: 2; contract_revision: typeof CONTRACT_REVISION } {
  return { schema_version: 2, contract_revision: CONTRACT_REVISION };
}

async function requireSourceStreamCapability(): Promise<void> {
  const capabilities = await loadDeviceV2Capabilities();
  if (!capabilities.sourceStreamV2) throw new DeviceV2SourceStreamUnavailableError();
}

function normalizeSnapshot(value: any): DeviceV2SourceStreamSnapshot {
  if (!value || Number(value.schema_version) !== 2 || value.contract_revision !== CONTRACT_REVISION) {
    throw new DeviceV2ApiError('来源流响应格式无效', 502, 'SOURCE_STREAM_RESPONSE_INVALID');
  }
  const result: DeviceV2SourceStreamSnapshot = {
    schema_version: 2,
    contract_revision: CONTRACT_REVISION,
    stream_id: id(String(value.stream_id ?? ''), 'stream_id', 180),
    task_id: id(String(value.task_id ?? ''), 'task_id'),
    binding_id: id(String(value.binding_id ?? ''), 'binding_id', 180),
    binding_generation: id(String(value.binding_generation ?? ''), 'binding_generation', 64).toLowerCase(),
    binding_revision: positiveInteger(Number(value.binding_revision), 'binding_revision'),
    cancel_revision: nonNegativeInteger(Number(value.cancel_revision), 'cancel_revision'),
    client_operation_id: id(String(value.client_operation_id ?? ''), 'client_operation_id', 180),
    generation_id: id(String(value.generation_id ?? ''), 'generation_id'),
    state: value.state,
    next_manifest_page: nonNegativeInteger(Number(value.next_manifest_page), 'next_manifest_page'),
    next_manifest_chapter: nonNegativeInteger(Number(value.next_manifest_chapter), 'next_manifest_chapter'),
    next_consumable_chapter: nonNegativeInteger(Number(value.next_consumable_chapter), 'next_consumable_chapter'),
    final_chapter_count: value.final_chapter_count === null || value.final_chapter_count === undefined
      ? null : positiveInteger(Number(value.final_chapter_count), 'final_chapter_count'),
    source_manifest_sha256: value.source_manifest_sha256 === null || value.source_manifest_sha256 === undefined
      ? null : sha256(String(value.source_manifest_sha256), 'source_manifest_sha256'),
    checkpoint_through_chapter: value.checkpoint_through_chapter === null || value.checkpoint_through_chapter === undefined
      ? null : nonNegativeInteger(Number(value.checkpoint_through_chapter), 'checkpoint_through_chapter'),
    expires_at: nonNegativeInteger(Number(value.expires_at), 'expires_at'),
  };
  if (!['open', 'consuming', 'complete', 'cancelled', 'expired'].includes(result.state)) {
    throw new DeviceV2ApiError('来源流状态无效', 502, 'SOURCE_STREAM_STATE_INVALID');
  }
  if (!/^[0-9a-f]{32}$/.test(result.binding_generation)) {
    throw new DeviceV2ApiError('来源流 binding generation 无效', 502, 'SOURCE_STREAM_BINDING_INVALID');
  }
  return result;
}

function normalizeGroup(value: any): DeviceV2SourceBundleGroup {
  const group = value?.group ?? value;
  if (!group || Number(group.schema_version) !== 2) {
    throw new DeviceV2ApiError('来源章节响应格式无效', 502, 'SOURCE_GROUP_RESPONSE_INVALID');
  }
  const state = group.state;
  if (!['open', 'committed', 'consumed', 'cancelled'].includes(state)) {
    throw new DeviceV2ApiError('来源章节状态无效', 502, 'SOURCE_GROUP_STATE_INVALID');
  }
  return {
    schema_version: 2,
    group_id: id(String(group.group_id ?? ''), 'group_id', 180),
    stream_id: id(String(group.stream_id ?? ''), 'stream_id', 180),
    chapter_ordinal: nonNegativeInteger(Number(group.chapter_ordinal), 'chapter_ordinal'),
    state,
    next_bundle_ordinal: nonNegativeInteger(Number(group.next_bundle_ordinal), 'next_bundle_ordinal'),
    declared_bundle_count: boundedInteger(Number(group.declared_bundle_count), 'declared_bundle_count', 8),
    declared_item_count: boundedInteger(Number(group.declared_item_count), 'declared_item_count', MAX_BUNDLE_ITEMS),
    declared_uncompressed_bytes: boundedInteger(Number(group.declared_uncompressed_bytes), 'declared_uncompressed_bytes', 128 * 1024 * 1024),
    chapter_sha256: sha256(String(group.chapter_sha256 ?? ''), 'chapter_sha256'),
    bundle_count: nonNegativeInteger(Number(group.bundle_count), 'bundle_count'),
    item_count: nonNegativeInteger(Number(group.item_count), 'item_count'),
  };
}

export async function createDeviceV2SourceStream(
  input: CreateDeviceV2SourceStreamInput,
): Promise<DeviceV2SourceStreamSnapshot> {
  await requireSourceStreamCapability();
  const bindingId = id(input.bindingId, 'binding_id', 180);
  const body = {
    ...bodyBase(),
    stream_id: id(input.streamId ?? Crypto.randomUUID(), 'stream_id', 180),
    task_id: id(input.taskId, 'task_id'),
    binding_generation: generation(input.bindingGeneration, 'binding_generation'),
    binding_revision: positiveInteger(input.bindingRevision, 'binding_revision'),
    cancel_revision: nonNegativeInteger(input.cancelRevision, 'cancel_revision'),
    client_operation_id: id(input.clientOperationId, 'client_operation_id', 180),
    generation_id: id(input.generationId, 'generation_id'),
    request_sha256: sha256(input.requestSha256, 'request_sha256'),
    capability: input.capability,
    entity_id: id(input.entityId, 'entity_id'),
    entity_revision: positiveInteger(input.entityRevision, 'entity_revision'),
    task_input_sha256: sha256(input.taskInputSha256, 'task_input_sha256'),
  };
  if (body.capability !== 'summary' && body.capability !== 'question') throw new Error('来源流能力无效');
  const value = await deviceV2Request<any>(
    `/meetings/${encodeURIComponent(bindingId)}/source-streams`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': body.client_operation_id }, body: JSON.stringify(body) },
    '创建来源流失败',
  );
  return normalizeSnapshot(value);
}

export async function getDeviceV2SourceStream(streamId: string): Promise<DeviceV2SourceStreamSnapshot> {
  await requireSourceStreamCapability();
  const value = await deviceV2Request<any>(`/source-streams/${encodeURIComponent(id(streamId, 'stream_id', 180))}`, {}, '读取来源流失败');
  return normalizeSnapshot(value);
}

export async function appendDeviceV2SourceManifestPage(input: {
  streamId: string;
  pageSeq: number;
  firstChapterOrdinal: number;
  descriptors: readonly SourceManifestDescriptor[];
  pageSha256: string;
  finalPage: boolean;
}): Promise<DeviceV2SourceStreamSnapshot> {
  await requireSourceStreamCapability();
  if (input.descriptors.length < 1 || input.descriptors.length > MAX_MANIFEST_DESCRIPTORS) throw new Error('来源清单数量无效');
  const descriptors = input.descriptors.map(item => ({
    chapter_ordinal: nonNegativeInteger(item.chapter_ordinal, 'chapter_ordinal'),
    declared_bundle_count: boundedInteger(item.declared_bundle_count, 'declared_bundle_count', 8),
    declared_item_count: boundedInteger(item.declared_item_count, 'declared_item_count', MAX_BUNDLE_ITEMS),
    declared_uncompressed_bytes: boundedInteger(item.declared_uncompressed_bytes, 'declared_uncompressed_bytes', 128 * 1024 * 1024),
    chapter_sha256: sha256(item.chapter_sha256, 'chapter_sha256'),
  }));
  const body = {
    ...bodyBase(), page_seq: nonNegativeInteger(input.pageSeq, 'page_seq'),
    first_chapter_ordinal: nonNegativeInteger(input.firstChapterOrdinal, 'first_chapter_ordinal'),
    descriptors, page_sha256: sha256(input.pageSha256, 'page_sha256'), final_page: input.finalPage === true,
  };
  const value = await deviceV2Request<any>(`/source-streams/${encodeURIComponent(id(input.streamId, 'stream_id', 180))}/manifest-pages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, '提交来源清单失败');
  return normalizeSnapshot(value);
}

export async function createDeviceV2SourceBundleGroup(input: {
  streamId: string;
  group: SourceBundleGroupInput;
}): Promise<DeviceV2SourceBundleGroup> {
  await requireSourceStreamCapability();
  const group = input.group;
  const body = {
    ...bodyBase(), group_id: id(group.groupId, 'group_id', 180),
    chapter_ordinal: nonNegativeInteger(group.chapterOrdinal, 'chapter_ordinal'),
    declared_bundle_count: boundedInteger(group.declaredBundleCount, 'declared_bundle_count', 8),
    declared_item_count: boundedInteger(group.declaredItemCount, 'declared_item_count', MAX_BUNDLE_ITEMS),
    declared_uncompressed_bytes: boundedInteger(group.declaredUncompressedBytes, 'declared_uncompressed_bytes', 128 * 1024 * 1024),
    chapter_sha256: sha256(group.chapterSha256, 'chapter_sha256'),
    request_sha256: sha256(group.requestSha256, 'request_sha256'),
  };
  const value = await deviceV2Request<any>(`/source-streams/${encodeURIComponent(id(input.streamId, 'stream_id', 180))}/groups`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': body.group_id }, body: JSON.stringify(body),
  }, '创建来源章节失败');
  return normalizeGroup(value);
}

export async function appendDeviceV2SourceBundle(input: {
  groupId: string;
  bundle: SourceBundleInput;
}): Promise<DeviceV2SourceBundleGroup> {
  await requireSourceStreamCapability();
  const bundle = input.bundle;
  if (bundle.items.length < 1 || bundle.items.length > MAX_BUNDLE_ITEMS) throw new Error('来源条目数量无效');
  const items = bundle.items.map(item => ({
    item_id: id(item.item_id, 'item_id', 180), source_type: item.source_type,
    source_id: id(item.source_id, 'source_id', 180), source_revision_id: id(item.source_revision_id, 'source_revision_id', 180),
    source_start_utf8: nonNegativeInteger(item.source_start_utf8, 'source_start_utf8'),
    source_end_utf8: nonNegativeInteger(item.source_end_utf8, 'source_end_utf8'), content_sha256: sha256(item.content_sha256, 'content_sha256'),
    content: contentText(item.content, 'content', 16 * 1024 * 1024),
    start_ms: optionalTime(item.start_ms, 'start_ms'),
    end_ms: optionalTime(item.end_ms, 'end_ms'),
    speaker: optionalSpeaker(item.speaker),
  }));
  if (items.some(item => item.source_end_utf8 < item.source_start_utf8)) throw new Error('来源 UTF-8 范围无效');
  if (items.some(item => item.start_ms !== null && item.end_ms !== null && item.end_ms < item.start_ms)) {
    throw new Error('来源时间范围无效');
  }
  if (items.some(item => !['transcript', 'manual_note', 'attachment'].includes(item.source_type))) {
    throw new Error('来源类型无效');
  }
  const body = { ...bodyBase(), bundle_id: id(bundle.bundleId, 'bundle_id', 180), ordinal: nonNegativeInteger(bundle.ordinal, 'ordinal'), bundle_sha256: sha256(bundle.bundleSha256, 'bundle_sha256'), items };
  if (body.ordinal > 7) throw new Error('ordinal无效');
  const value = await deviceV2Request<any>(`/source-bundle-groups/${encodeURIComponent(id(input.groupId, 'group_id', 180))}/bundles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': body.bundle_id }, body: JSON.stringify(body),
  }, '提交来源条目失败');
  return normalizeGroup(value);
}

export async function commitDeviceV2SourceBundleGroup(groupId: string): Promise<DeviceV2SourceBundleGroup> {
  await requireSourceStreamCapability();
  const value = await deviceV2Request<any>(`/source-bundle-groups/${encodeURIComponent(id(groupId, 'group_id', 180))}/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyBase()),
  }, '提交来源章节完成标记失败');
  return normalizeGroup(value);
}

export async function cancelDeviceV2SourceStream(streamId: string): Promise<void> {
  await requireSourceStreamCapability();
  await deviceV2Request(`/source-streams/${encodeURIComponent(id(streamId, 'stream_id', 180))}`, { method: 'DELETE' }, '取消来源流失败');
}
