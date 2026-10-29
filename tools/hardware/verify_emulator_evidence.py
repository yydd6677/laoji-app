"""Recheck captured emulator evidence; no device writes, no service calls."""
import argparse
import hashlib
import io
import json
import tarfile
import wave
from pathlib import Path


def wav_pcm(data):
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
        return w.readframes(w.getnframes())


def archive_wavs(path):
    with tarfile.open(path) as tar:
        return {Path(m.name).name: tar.extractfile(m).read() for m in tar.getmembers()
                if m.isfile() and m.name.endswith('.wav')}


def verify(root):
    checks = []
    real = [json.loads(line) for line in (root / 'relay-real-1.jsonl').read_text().splitlines()]
    assert any(r.get('firmware') == 'laoji-recorder-2.0.0' for r in real)
    commands = [r.get('op') for r in real if r['event'] == 'app_command']
    for op in ('hello', 'capture.start', 'capture.pause', 'capture.resume', 'capture.stop', 'recording.rename'):
        assert op in commands
    checks.append('real_firmware_handshake_capture_pause_resume_stop_and_rename')
    finished = next(r for r in real if r.get('op') == 'capture.finished')
    pcm = wav_pcm((root / 'real-board-capture.wav').read_bytes())
    assert len(pcm) == finished['audio_bytes'] == 1391616
    assert 'sha256:' + hashlib.sha256(pcm).hexdigest() == finished['checksum_sha256']
    checks.append('real_capture_pcm_sha_matches_board_source')
    before, after = archive_wavs(root / 'pending-before.tar'), archive_wavs(root / 'pending-after.tar')
    assert before and all(after.get(name) == data for name, data in before.items())
    checks.append('all_preexisting_pending_wavs_byte_identical')
    gap = [json.loads(line) for line in (root / 'relay-real-gap.jsonl').read_text().splitlines()]
    injected = next(r for r in gap if r['event'] == 'injected_live_gap')
    assert injected['sequence'] == 5 and injected['source_offset'] == 1968
    transfer = next(r['transfer'] for r in gap if r.get('transfer'))
    assert transfer['offset'] == 1968 and transfer['length'] == 154704
    gap_final = next(r for r in gap if r.get('op') == 'capture.finished')
    assert any('sha256:' + hashlib.sha256(wav_pcm(data)).hexdigest() == gap_final['checksum_sha256']
               for data in after.values())
    checks.append('real_gap_resumed_at_exact_offset_and_final_pcm_sha_matches')
    log = (root / 'native-hardware.log').read_text()
    assert 'pcm_integrity_refetch expected_bytes=851968' in log
    assert 'pcm_integrity_failed received_bytes=576000 expected_bytes=576000' in log
    bad, healthy = json.loads((root / 'bad-sha-pending.json').read_text()), json.loads((root / 'retry-healthy-pending.json').read_text())
    assert len(healthy) == len(bad) + 1
    fresh = next(r for r in healthy if r['id'] not in {b['id'] for b in bad})
    assert fresh['bytes'] == 576044
    checks.append('wrong_prefix_refetched_bad_sha_not_indexed_healthy_retry_accepted')
    transcript = json.loads((root / 'fixture-transcript.json').read_text())
    assert transcript['kind'] == 'final' and not transcript['completing'] and len(transcript['lines']) == 5
    facts = json.loads((root / 'fixture-facts.json').read_text())[0]
    assert facts['model_revision'] == 'ollama:qwen3.5:9b'
    assert json.loads(facts['document_json'])['schema_version'] == 3
    checks.append('fixture_real_service_final_transcript_and_facts_v3_persisted')
    thread = json.loads((root / 'fixture-question.json').read_text())['thread']
    assert thread['meetingId'] == 'ca250255-a2ce-4b46-b53d-8712757814f2' and len(thread['turns']) == 1
    turn = thread['turns'][0]
    assert turn['answer'] == '发言人参与修订了集团的科技项目管理办法。' and len(turn['citations']) == 1
    citation = turn['citations'][0]
    assert citation['startMs'] == 12000
    assert any(line['text'] == citation['sourceExcerpt'] for line in transcript['lines'])
    checks.append('question_answer_correct_and_single_citation_matches_current_source')
    state = json.loads((root / 'restart-local-state.json').read_text())
    assert state[0] == [{'versions': 1}] and state[2] == [{'integrity_check': 'ok'}]
    restored = json.loads((root / 'restart-question.json').read_text())['thread']
    assert restored['id'] == thread['id'] and restored['turns'] == thread['turns']
    checks.append('restart_kept_single_summary_question_turn_and_database_integrity')
    return {'result': 'pass_for_evidence_checks_not_full_product_acceptance', 'checks': checks,
            'question_turn_ms': turn['completedAtMs'] - turn['createdAtMs'],
            'not_covered': ['physical Android BLE/Wi-Fi', 'speech pickup quality', 'hardware live ASR',
                            'summary/action semantic quality', 'cold file-list performance']}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('evidence', type=Path)
    print(json.dumps(verify(p.parse_args().evidence), ensure_ascii=False, indent=2))
