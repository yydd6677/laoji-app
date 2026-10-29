import { gzipSync, strToU8 } from 'fflate';
import { fromByteArray } from 'base64-js';

export interface InlineQuestionSource {
  source_type: string;
  source_id: string;
  source_revision_id: string;
  content_sha256: string;
  text: string;
}

export type InlineQuestionSourcePayload =
  | { sources: readonly InlineQuestionSource[]; compressed_sources?: never }
  | { sources?: never; compressed_sources: {
    encoding: 'gzip-base64'; uncompressed_bytes: number; data: string;
  } };

// This changes wire bytes only. Task handles, fingerprint, source identity and
// each UTF-8 text/hash remain exactly those already owned by the Q2 request.
export function encodeInlineQuestionSources(sources: readonly InlineQuestionSource[]): InlineQuestionSourcePayload {
  const bytes = strToU8(JSON.stringify(sources));
  if (bytes.byteLength > 256 * 1024 || sources.length > 1_024) {
    throw new RangeError('Question source payload exceeds inline contract');
  }
  if (bytes.byteLength < 1_024) return { sources };
  const data = fromByteArray(gzipSync(bytes, { level: 1, mtime: 0 }));
  // Tiny/incompressible sources keep their smaller original representation.
  // This is not a failed-request fallback or a different source owner.
  if (data.length + 100 >= bytes.byteLength) return { sources };
  return { compressed_sources: { encoding: 'gzip-base64', uncompressed_bytes: bytes.byteLength, data } };
}
