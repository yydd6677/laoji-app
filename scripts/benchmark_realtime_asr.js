#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  describeError,
  reexecWithoutEnvironmentProxy,
  runProbe,
} = require('./probe_realtime_asr_file');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function similarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  const length = Math.max(a.length, b.length);
  return length === 0 ? 1 : 1 - editDistance(a, b) / length;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function metricSummary(rows, field) {
  const values = rows.map(row => row.report?.timing?.[field]).filter(value => Number.isFinite(value));
  return {
    min: values.length ? Math.min(...values) : null,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

function resolveSampleFile(manifestDirectory, sample, format) {
  const value = sample.files?.[format];
  if (!value) throw new Error(`sample ${sample.id} has no ${format} file`);
  const fromCwd = path.resolve(value);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(manifestDirectory, value);
}

async function main() {
  const baseUrl = argument('base-url', 'http://127.0.0.1:18020').replace(/\/$/, '');
  const route = argument('route', 'schedule');
  const manifestPath = path.resolve(argument('manifest', 'test-assets/asr-voice-samples/manifest.json'));
  const format = argument('format', 'wav');
  const levels = argument('levels', '1,2,4').split(',').map(Number);
  const repeats = Number(argument('repeats', '2'));
  const sampleIds = argument('sample-ids', '001,002,003,004').split(',');
  const threshold = Number(argument('threshold', '0.85'));
  const maxFirstCompletionMs = Number(argument('max-first-completion-ms', '6000'));
  const maxReadyAfterStopMs = Number(argument('max-ready-after-stop-ms', '5000'));
  const maxSlowdownRatio = Number(argument('max-slowdown-ratio', '2'));
  const output = argument('output', '');
  const respectEnvironmentProxy = process.argv.includes('--respect-environment-proxy');
  if (!['schedule', 'meeting'].includes(route)) throw new Error('--route must be schedule or meeting');
  if (levels.some(value => !Number.isInteger(value) || value < 1)) throw new Error('--levels must be positive integers');
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');
  if (Math.max(...levels) > sampleIds.length) throw new Error('provide at least one distinct --sample-ids value per concurrent session');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const byId = new Map(manifest.samples.map(sample => [String(sample.id), sample]));
  const selected = sampleIds.map(id => {
    const sample = byId.get(id);
    if (!sample) throw new Error(`unknown sample id: ${id}`);
    return {
      ...sample,
      file: resolveSampleFile(path.dirname(manifestPath), sample, format),
    };
  });

  process.stderr.write(`warmup ${selected[0].id}\n`);
  await runProbe({
    baseUrl,
    route,
    files: [selected[0].file],
    title: `Realtime ASR benchmark warmup ${Date.now()}`,
    respectEnvironmentProxy,
  });

  const rows = [];
  for (const level of levels) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      process.stderr.write(`level=${level} repeat=${repeat}/${repeats}\n`);
      const batch = selected.slice(0, level).map(async sample => {
        let report;
        try {
          report = await runProbe({
            baseUrl,
            route,
            files: [sample.file],
            title: `Realtime ASR benchmark c${level} r${repeat} ${sample.id}`,
            respectEnvironmentProxy,
          });
        } catch (error) {
          return {
            level,
            repeat,
            sample_id: sample.id,
            expected: sample.text,
            actual: '',
            score: 0,
            contamination: [],
            passed: false,
            issues: ['probe_error'],
            error: describeError(error),
            report: null,
          };
        }
        const actual = report.transcripts.map(item => item.text).join(' ');
        const score = similarity(sample.text, actual);
        const otherPhrases = selected
          .slice(0, level)
          .filter(other => other.id !== sample.id)
          .map(other => normalize(other.text));
        const normalizedActual = normalize(actual);
        const contamination = otherPhrases.filter(phrase => phrase && normalizedActual.includes(phrase));
        const issues = [];
        if (score < threshold) issues.push(`accuracy:${score.toFixed(4)}<${threshold}`);
        if (contamination.length) issues.push('cross_session_contamination');
        if (report.cleanup_status !== 204) issues.push(`cleanup_status:${report.cleanup_status}`);
        const firstCompletion = report.timing.first_completed_after_audio_start_ms;
        if (!Number.isFinite(firstCompletion)) issues.push('missing_transcript');
        else if (firstCompletion > maxFirstCompletionMs) {
          issues.push(`first_completion_ms:${firstCompletion}>${maxFirstCompletionMs}`);
        }
        const readyAfterStop = report.timing.ready_after_stop_signal_ms;
        if (!Number.isFinite(readyAfterStop)) issues.push('missing_ready_to_stop');
        else if (readyAfterStop > maxReadyAfterStopMs) {
          issues.push(`ready_after_stop_ms:${readyAfterStop}>${maxReadyAfterStopMs}`);
        }
        return {
          level,
          repeat,
          sample_id: sample.id,
          expected: sample.text,
          actual,
          score: Number(score.toFixed(4)),
          contamination,
          passed: issues.length === 0,
          issues,
          error: null,
          report,
        };
      });
      rows.push(...await Promise.all(batch));
    }
  }

  const levelReports = levels.map(level => {
    const levelRows = rows.filter(row => row.level === level);
    return {
      concurrency: level,
      sessions: levelRows.length,
      passed: levelRows.filter(row => row.passed).length,
      score: {
        min: Math.min(...levelRows.map(row => row.score)),
        median: percentile(levelRows.map(row => row.score), 0.5),
      },
      first_completed_after_audio_start_ms: metricSummary(levelRows, 'first_completed_after_audio_start_ms'),
      first_completed_after_speech_end_ms: metricSummary(levelRows, 'first_completed_after_speech_end_ms'),
      ready_after_stop_signal_ms: metricSummary(levelRows, 'ready_after_stop_signal_ms'),
      total_ms: metricSummary(levelRows, 'total_ms'),
    };
  });
  const baseline = levelReports.find(level => level.concurrency === 1);
  const slowdownIssues = [];
  if (baseline?.first_completed_after_audio_start_ms.median) {
    for (const level of levelReports.filter(item => item.concurrency > 1)) {
      const ratio = level.first_completed_after_audio_start_ms.median
        / baseline.first_completed_after_audio_start_ms.median;
      level.first_completion_slowdown_ratio = Number(ratio.toFixed(3));
      if (ratio > maxSlowdownRatio) {
        slowdownIssues.push(`concurrency_${level.concurrency}_slowdown:${ratio.toFixed(3)}>${maxSlowdownRatio}`);
      }
    }
  }
  const report = {
    generated_at: new Date().toISOString(),
    endpoint: baseUrl,
    route,
    manifest: manifestPath,
    format,
    levels,
    repeats,
    budgets: {
      minimum_similarity: threshold,
      max_first_completion_after_audio_start_ms: maxFirstCompletionMs,
      max_ready_after_stop_signal_ms: maxReadyAfterStopMs,
      max_concurrency_slowdown_ratio: maxSlowdownRatio,
    },
    total_sessions: rows.length,
    passed_sessions: rows.filter(row => row.passed).length,
    slowdown_issues: slowdownIssues,
    passed: rows.every(row => row.passed) && slowdownIssues.length === 0,
    levels_report: levelReports,
    rows,
  };
  if (output) {
    const outputPath = path.resolve(output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    passed: report.passed,
    total_sessions: report.total_sessions,
    passed_sessions: report.passed_sessions,
    slowdown_issues: report.slowdown_issues,
    levels_report: report.levels_report,
  }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

module.exports = { describeError, editDistance, normalize, percentile, similarity };

if (require.main === module) {
  const reexecStatus = reexecWithoutEnvironmentProxy();
  if (reexecStatus !== null) {
    process.exit(reexecStatus);
  } else {
    main().catch(error => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exit(1);
    });
  }
}
