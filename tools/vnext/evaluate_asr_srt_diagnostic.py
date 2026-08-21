#!/usr/bin/env python3
"""Run a privacy-minimized ASR diagnostic against weak SRT references.

SRT files supplied with the meeting samples may contain omissions or errors,
so this command can never emit promotion-eligible evidence.  It extracts
deterministic, non-overlapping windows, sends PCM through the ASR v2 candidate,
and persists only hashes plus aggregate/row metrics (never transcript text).
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import unicodedata
from urllib import request


EVIDENCE_CONTRACT = "media-weak-reference-diagnostic-v1"
TIMESTAMP_RE = re.compile(
    r"(?P<sh>\d{2}):(?P<sm>\d{2}):(?P<ss>\d{2})[,.](?P<sms>\d{3})\s*-->\s*"
    r"(?P<eh>\d{2}):(?P<em>\d{2}):(?P<es>\d{2})[,.](?P<ems>\d{3})"
)
TAG_RE = re.compile(r"<[^>]+>")
TEXT_NORMALIZE_RE = re.compile(r"[^0-9a-z\u3400-\u9fff]+")
NUMBER_RE = re.compile(
    r"(?:\d+(?:[.:]\d+)?|[零〇一二两三四五六七八九十百千万]+)"
    r"(?:点|时|分|秒|年|月|日|号|天|周|星期|元|万|亿|%|％|轮|册|种|台|次)?"
)
CHINESE_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
                  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
CHINESE_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}


@dataclass(frozen=True)
class Cue:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class Window:
    source_index: int
    ordinal: int
    start_ms: int
    end_ms: int
    reference: str
    media: Path
    media_sha256: str
    srt_sha256: str

    @property
    def case_id(self) -> str:
        value = f"{self.media_sha256}|{self.start_ms}|{self.end_ms}".encode("utf-8")
        return "asr-srt:" + hashlib.sha256(value).hexdigest()[:24]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def text_sha256(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(0, math.ceil(quantile * len(ordered)) - 1)
    return ordered[rank]


def parse_timestamp(match: re.Match[str], prefix: str) -> int:
    return (
        int(match.group(prefix + "h")) * 3_600_000
        + int(match.group(prefix + "m")) * 60_000
        + int(match.group(prefix + "s")) * 1000
        + int(match.group(prefix + "ms"))
    )


def parse_srt(path: Path) -> list[Cue]:
    content = path.read_text(encoding="utf-8-sig", errors="replace")
    cues: list[Cue] = []
    for block in re.split(r"\r?\n\s*\r?\n", content):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timestamp_index = next((i for i, line in enumerate(lines) if TIMESTAMP_RE.search(line)), None)
        if timestamp_index is None:
            continue
        match = TIMESTAMP_RE.search(lines[timestamp_index])
        assert match is not None
        text = "".join(TAG_RE.sub("", line) for line in lines[timestamp_index + 1:]).strip()
        if not text:
            continue
        start_ms = parse_timestamp(match, "s")
        end_ms = parse_timestamp(match, "e")
        if end_ms > start_ms:
            cues.append(Cue(start_ms, end_ms, text))
    return cues


def build_windows(cues: list[Cue], *, target_ms: int, windows_per_source: int) -> list[tuple[int, int, str]]:
    candidates: list[tuple[int, int, str]] = []
    cursor = 0
    while cursor < len(cues):
        start = cues[cursor].start_ms
        end = cues[cursor].end_ms
        texts = [cues[cursor].text]
        cursor += 1
        while cursor < len(cues) and end - start < target_ms:
            cue = cues[cursor]
            if cue.start_ms - end > 2500:
                break
            texts.append(cue.text)
            end = max(end, cue.end_ms)
            cursor += 1
        reference = "".join(texts).strip()
        if len(normalize_text(reference)) >= 12 and 3000 <= end - start <= max(30_000, target_ms * 2):
            candidates.append((start, end, reference))
    if len(candidates) <= windows_per_source:
        return candidates
    numeric = [index for index, row in enumerate(candidates) if numeric_tokens(row[2])]
    selected: set[int] = set()
    if numeric:
        selected.add(numeric[len(numeric) // 2])
    remaining = windows_per_source - len(selected)
    for ordinal in range(remaining):
        position = round((ordinal + 0.5) * (len(candidates) - 1) / max(remaining, 1))
        while position in selected and position + 1 < len(candidates):
            position += 1
        selected.add(position)
    if len(selected) < windows_per_source:
        selected.update(index for index in range(len(candidates)) if index not in selected)
    return [candidates[index] for index in sorted(selected)[:windows_per_source]]


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).lower()
    return TEXT_NORMALIZE_RE.sub("", normalized)


def levenshtein(left: str, right: str) -> int:
    if len(left) > len(right):
        left, right = right, left
    previous = list(range(len(left) + 1))
    for right_index, right_char in enumerate(right, 1):
        current = [right_index]
        for left_index, left_char in enumerate(left, 1):
            current.append(min(
                current[-1] + 1,
                previous[left_index] + 1,
                previous[left_index - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]


def chinese_integer(text: str) -> int | None:
    if not text or any(character not in CHINESE_DIGITS and character not in CHINESE_UNITS for character in text):
        return None
    if all(character in CHINESE_DIGITS for character in text):
        return int("".join(str(CHINESE_DIGITS[character]) for character in text))
    total = 0
    section = 0
    digit = 0
    for character in text:
        if character in CHINESE_DIGITS:
            digit = CHINESE_DIGITS[character]
            continue
        unit = CHINESE_UNITS[character]
        if unit == 10000:
            section = (section + digit) * unit
            total += section
            section = 0
        else:
            section += (digit or 1) * unit
        digit = 0
    return total + section + digit


def numeric_tokens(text: str) -> Counter[str]:
    result: Counter[str] = Counter()
    normalized = unicodedata.normalize("NFKC", text)
    normalized = re.sub(
        r"百分之([零〇一二两三四五六七八九十百千万]+|\d+(?:\.\d+)?)",
        lambda match: (
            str(chinese_integer(match.group(1)))
            if not match.group(1)[0].isdigit()
            else match.group(1)
        ) + "%",
        normalized,
    )
    for match in NUMBER_RE.finditer(normalized):
        token = match.group(0)
        numeric = re.match(r"[零〇一二两三四五六七八九十百千万]+", token)
        if numeric:
            value = chinese_integer(numeric.group(0))
            if value is not None:
                token = str(value) + token[len(numeric.group(0)):]
        elif token.endswith("万") and token[:-1].isdigit():
            token = str(int(token[:-1]) * 10_000)
        elif token.endswith("亿") and token[:-1].isdigit():
            token = str(int(token[:-1]) * 100_000_000)
        result[token] += 1
    return result


def extract_pcm(window: Window) -> bytes:
    duration = max(0.001, (window.end_ms - window.start_ms) / 1000)
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{window.start_ms / 1000:.3f}", "-i", str(window.media),
            "-t", f"{duration:.3f}", "-vn", "-ac", "1", "-ar", "16000",
            "-f", "s16le", "-",
        ],
        check=True,
        capture_output=True,
        timeout=max(45, duration * 4),
    )
    return result.stdout


def post_batch(endpoint: str, windows: list[Window], pcm_by_id: dict[str, bytes]) -> dict:
    payload = {
        "schema_version": 2,
        "contract_revision": "asr.batch.v2",
        "priority": "offline",
        "items": [
            {
                "id": window.case_id,
                "sample_rate": 16000,
                "language": "Chinese",
                "source_start_ms": window.start_ms,
                "source_end_ms": window.end_ms,
                "pcm_base64": base64.b64encode(pcm_by_id[window.case_id]).decode("ascii"),
            }
            for window in windows
        ],
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    call = request.Request(endpoint, data=body, headers={"Content-Type": "application/json"})
    with request.urlopen(call, timeout=900) as response:
        return json.load(response)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pair", action="append", required=True, metavar="MEDIA::SRT")
    parser.add_argument("--endpoint", default="http://127.0.0.1:28031/v2/asr/batch")
    parser.add_argument("--windows-per-source", type=int, default=3)
    parser.add_argument("--window-seconds", type=float, default=12.0)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--local-review-output",
        type=Path,
        help=(
            "optional plaintext reference/prediction JSONL for local human review; "
            "keep outside the repository and delete after adjudication"
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 1 <= args.windows_per_source <= 20:
        raise SystemExit("--windows-per-source must be between 1 and 20")
    if not 3 <= args.window_seconds <= 30:
        raise SystemExit("--window-seconds must be between 3 and 30")
    windows: list[Window] = []
    source_manifest: list[dict[str, object]] = []
    for source_index, spec in enumerate(args.pair):
        if "::" not in spec:
            raise SystemExit("--pair must use MEDIA::SRT")
        media_text, srt_text = spec.split("::", 1)
        media, srt = Path(media_text), Path(srt_text)
        if not media.is_file() or not srt.is_file():
            raise SystemExit(f"missing media or SRT for pair {source_index + 1}")
        media_hash, srt_hash = file_sha256(media), file_sha256(srt)
        selected = build_windows(
            parse_srt(srt),
            target_ms=round(args.window_seconds * 1000),
            windows_per_source=args.windows_per_source,
        )
        source_manifest.append({
            "source_index": source_index,
            "media_sha256": media_hash,
            "reference_sha256": srt_hash,
            "selected_window_count": len(selected),
        })
        windows.extend(
            Window(source_index, ordinal, start, end, reference, media, media_hash, srt_hash)
            for ordinal, (start, end, reference) in enumerate(selected)
        )
    if not windows:
        raise SystemExit("no eligible SRT windows")

    with ThreadPoolExecutor(max_workers=min(8, len(windows))) as executor:
        audio = list(executor.map(extract_pcm, windows))
    pcm_by_id = {window.case_id: pcm for window, pcm in zip(windows, audio, strict=True)}
    responses: list[dict] = []
    for offset in range(0, len(windows), 8):
        responses.append(post_batch(args.endpoint, windows[offset:offset + 8], pcm_by_id))
    model_revisions = {str(response.get("model_revision") or "") for response in responses}
    if len(model_revisions) != 1 or not next(iter(model_revisions)):
        raise RuntimeError("ASR model revision was missing or changed")
    items = {
        str(item.get("id")): item
        for response in responses
        for item in response.get("items", [])
        if isinstance(item, dict)
    }
    if set(items) != {window.case_id for window in windows}:
        raise RuntimeError("ASR response identities did not match diagnostic windows")

    cases: list[dict[str, object]] = []
    review_rows: list[dict[str, object]] = []
    numeric_total = 0
    numeric_correct = 0
    for window in windows:
        item = items[window.case_id]
        prediction = str(item.get("text") or "").strip()
        reference_normalized = normalize_text(window.reference)
        prediction_normalized = normalize_text(prediction)
        distance = levenshtein(reference_normalized, prediction_normalized)
        cer = distance / max(len(reference_normalized), 1)
        reference_numbers = numeric_tokens(window.reference)
        prediction_numbers = numeric_tokens(prediction)
        correct = sum(min(count, prediction_numbers[token]) for token, count in reference_numbers.items())
        numeric_total += sum(reference_numbers.values())
        numeric_correct += correct
        cases.append({
            "case_id": window.case_id,
            "source_index": window.source_index,
            "window_ordinal": window.ordinal,
            "source_start_ms": window.start_ms,
            "source_end_ms": window.end_ms,
            "reference_sha256": text_sha256(window.reference),
            "prediction_sha256": text_sha256(prediction),
            "reference_character_count": len(reference_normalized),
            "prediction_character_count": len(prediction_normalized),
            "edit_distance": distance,
            "cer": round(cer, 6),
            "reference_numeric_time_count": sum(reference_numbers.values()),
            "matched_numeric_time_count": correct,
            "outcome": item.get("outcome"),
        })
        review_rows.append({
            "case_id": window.case_id,
            "source_index": window.source_index,
            "source_start_ms": window.start_ms,
            "source_end_ms": window.end_ms,
            "reference": window.reference,
            "prediction": prediction,
            "cer": round(cer, 6),
        })
    cers = [float(case["cer"]) for case in cases]
    report = {
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "candidate_only": True,
        "promotion_eligible": False,
        "source_policy": "weak_subtitle_diagnostic",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_revision": next(iter(model_revisions)),
        "source_manifest": source_manifest,
        "sample_count": len(cases),
        "metrics": {
            "cer_median": round(percentile(cers, 0.50), 6),
            "cer_p95": round(percentile(cers, 0.95), 6),
            "numeric_time_accuracy": (
                round(numeric_correct / numeric_total, 6) if numeric_total else None
            ),
            "numeric_time_reference_count": numeric_total,
            "no_speech_count": sum(case["outcome"] == "no_speech" for case in cases),
        },
        "cases": cases,
        "limitations": [
            "SRT subtitles may contain errors, omissions, normalization differences, or timing drift.",
            "The report stores no transcript text and cannot replace a blinded human-corrected reference.",
            "This diagnostic cannot close the Stage 2 quality or capability gate.",
        ],
    }
    unsigned = json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    report["report_sha256"] = "sha256:" + hashlib.sha256(unsigned).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.local_review_output:
        args.local_review_output.parent.mkdir(parents=True, exist_ok=True)
        args.local_review_output.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in review_rows),
            encoding="utf-8",
        )
    print(json.dumps({"sample_count": len(cases), **report["metrics"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
