#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { runProbe, reexecWithoutEnvironmentProxy } = require('./probe_realtime_asr_file');
const { percentile, similarity } = require('./benchmark_realtime_asr');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function validateBaseUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('base URLs must be absolute HTTP(S) URLs without credentials');
  }
  return parsed.toString().replace(/\/$/, '');
}

function sampleFile(manifestPath, sample, format) {
  const value = sample.files?.[format];
  if (!value) throw new Error(`sample ${sample.id} has no ${format} file`);
  const fromCwd = path.resolve(value);
  return fs.existsSync(fromCwd) ? fromCwd : path.resolve(path.dirname(manifestPath), value);
}

async function responseJson(label, response, allowed) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!allowed.includes(response.status)) throw new Error(`${label} returned HTTP ${response.status}`);
  return data;
}

async function deleteTemporaryAccount(authBase, token, password) {
  const response = await fetch(`${authBase}/api/auth/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: password, confirmation: '删除账号' }),
  });
  const data = await responseJson('delete temporary account', response, [200]);
  return Boolean(data?.deleted);
}

function metric(rows, field) {
  const values = rows.map(row => row.timing[field]).filter(Number.isFinite);
  return {
    min: values.length ? Math.min(...values) : null,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

async function main() {
  if (!process.argv.includes('--confirm-live-mutations')) {
    throw new Error('--confirm-live-mutations is required');
  }
  const authBase = validateBaseUrl(argument('auth-base', ''));
  const meetingBase = validateBaseUrl(argument('meeting-base', ''));
  const manifestPath = path.resolve(argument('manifest', 'test-assets/asr-voice-samples/manifest.json'));
  const format = argument('format', 'wav');
  const enrollId = argument('enroll-id', '001');
  const sampleIds = argument('sample-ids', '001,002,004,009').split(',').map(value => value.trim());
  const repeats = Number(argument('repeats', '2'));
  const concurrency = Number(argument('concurrency', '1'));
  const minimumSimilarity = Number(argument('threshold', '0.95'));
  const maxSegmentTailMs = Number(argument('max-segment-tail-ms', '1500'));
  const output = argument('output', '');
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const byId = new Map(manifest.samples.map(sample => [String(sample.id), sample]));
  const enrollSample = byId.get(enrollId);
  if (!enrollSample) throw new Error(`unknown enroll sample: ${enrollId}`);
  const selected = sampleIds.map(id => {
    const sample = byId.get(id);
    if (!sample) throw new Error(`unknown sample: ${id}`);
    return { ...sample, file: sampleFile(manifestPath, sample, format) };
  });
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > selected.length) {
    throw new Error('--concurrency must be a positive integer no greater than the sample count');
  }
  const enrolledVoice = enrollSample.voice;
  if (selected.some(sample => sample.voice !== enrolledVoice)) {
    throw new Error('all probe samples must use the enrolled voice');
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const account = `laoji.speaker.benchmark.${runId}@example.com`;
  const password = `Aa1!${randomUUID().replace(/-/g, '')}`;
  const speakerName = '基准讲话人';
  let token = '';
  let cleanupDeleted = false;
  const rows = [];
  let speaker = null;
  try {
    const registerResponse = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password, nickname: '声纹延迟基准' }),
    });
    const registration = await responseJson('register temporary account', registerResponse, [201]);
    token = registration?.access_token;
    if (!token) throw new Error('registration returned no access token');

    const enrollmentFile = sampleFile(manifestPath, enrollSample, format);
    const form = new FormData();
    form.append('name', speakerName);
    form.append('audio', await fs.openAsBlob(enrollmentFile, { type: 'audio/wav' }), path.basename(enrollmentFile));
    const speakerResponse = await fetch(`${meetingBase}/api/laoji/speakers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const speakerResult = await responseJson('register speaker', speakerResponse, [200, 201]);
    speaker = speakerResult?.speaker ?? null;

    const meetingResponse = await fetch(`${meetingBase}/api/laoji/meetings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '已登记讲话人实时延迟基准',
        participants: [speakerName],
        mode: 'realtime',
        client_request_id: `speaker-benchmark:${runId}`,
      }),
    });
    const meeting = await responseJson('create benchmark meeting', meetingResponse, [201]);
    if (!meeting?.id) throw new Error('meeting creation returned no id');

    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (let offset = 0; offset < selected.length; offset += concurrency) {
        const batch = selected.slice(offset, offset + concurrency);
        const batchRows = await Promise.all(batch.map(async sample => {
          const report = await runProbe({
            baseUrl: meetingBase,
            route: 'meeting',
            files: [sample.file],
            meetingId: meeting.id,
            accessToken: token,
            title: `Registered speaker benchmark ${sample.id}`,
          });
          const actual = report.transcripts.map(item => item.text).join(' ');
          const score = similarity(sample.text, actual);
          const first = report.transcripts[0] ?? {};
          return {
            repeat,
            sample_id: sample.id,
            expected: sample.text,
            actual,
            score: Number(score.toFixed(4)),
            identified: first.identified === true,
            speaker_name: first.speaker_name ?? null,
            timing: report.timing,
          };
        }));
        rows.push(...batchRows);
      }
    }
  } finally {
    if (token) cleanupDeleted = await deleteTemporaryAccount(authBase, token, password).catch(() => false);
  }

  const issues = [];
  rows.forEach(row => {
    if (row.score < minimumSimilarity) issues.push(`${row.sample_id}:accuracy`);
    if (!row.identified || row.speaker_name !== speakerName) issues.push(`${row.sample_id}:identity`);
    if (!Number.isFinite(row.timing.first_completed_after_segment_end_ms)) issues.push(`${row.sample_id}:missing_tail`);
    else if (row.timing.first_completed_after_segment_end_ms > maxSegmentTailMs) issues.push(`${row.sample_id}:tail`);
  });
  if (!cleanupDeleted) issues.push('cleanup');
  const report = {
    generated_at: new Date().toISOString(),
    endpoint: meetingBase,
    enrolled_voice: enrolledVoice,
    enrollment_quality: speaker?.quality ?? null,
    repeats,
    concurrency,
    samples: selected.map(sample => sample.id),
    budgets: { minimum_similarity: minimumSimilarity, max_segment_tail_ms: maxSegmentTailMs },
    passed: issues.length === 0,
    issues,
    cleanup_deleted: cleanupDeleted,
    first_completed_after_audio_start_ms: metric(rows, 'first_completed_after_audio_start_ms'),
    first_completed_after_segment_end_ms: metric(rows, 'first_completed_after_segment_end_ms'),
    rows,
  };
  if (output) {
    const outputPath = path.resolve(output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    passed: report.passed,
    issues: report.issues,
    cleanup_deleted: report.cleanup_deleted,
    enrollment_quality: report.enrollment_quality,
    first_completed_after_audio_start_ms: report.first_completed_after_audio_start_ms,
    first_completed_after_segment_end_ms: report.first_completed_after_segment_end_ms,
  }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

if (require.main === module) {
  const reexecStatus = reexecWithoutEnvironmentProxy();
  if (reexecStatus !== null) process.exit(reexecStatus);
  else main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = { metric, sampleFile, validateBaseUrl };
