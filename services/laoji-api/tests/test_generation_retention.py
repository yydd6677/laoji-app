from __future__ import annotations

import sqlite3
import uuid

import pytest

from app.config import settings
from app.services import device_identity, generation_retention as retention, vnext_task_store as tasks
from app.services.device_v2_identity import DeviceV2Context


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'DATABASE_URL', f'sqlite+aiosqlite:///{tmp_path / "quality.db"}')
    device_identity._SCHEMA_READY.clear()
    tasks.ensure_vnext_task_schema()
    return DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)


def task(context, task_id='task', capability='question'):
    tasks.register_binding(context, binding_id='binding', binding_generation='generation')
    return tasks.create_task(context, task_id=task_id, binding_id='binding', binding_generation='generation',
        capability=capability, entity_id=task_id, entity_revision=1, input_sha256='sha256:'+'a'*64,
        generation_id=task_id)


def answer(context, task_id='task'):
    attempt = tasks.claim_attempt(context, task_id, lease_owner='worker')
    assert attempt
    result = {'answer': '陈敏会提交报告。', 'answer_kind': 'answer', 'clauses': [],
              'request_body': 'do not copy original request'}
    assert tasks.mark_success(context, task_id, attempt['attempt_id'], result, lease_owner='worker')
    return result


def test_default_off_does_not_archive_and_recovery_still_succeeds(context):
    assert retention.get_preference(context) == {'schema_version': 2, 'enabled': False, 'revision': 0}
    task(context)
    result = answer(context)
    assert tasks.get_task(context, 'task')['result'] == result
    assert retention.read_retained_results(context) == []


def test_opt_in_archives_generated_output_not_original_request(context):
    retention.set_preference(context, True)
    task(context)
    answer(context)
    saved = retention.read_retained_results(context)
    assert saved == [{'kind': 'question_answer', 'output': {
        'answer': '陈敏会提交报告。', 'answer_kind': 'answer', 'clauses': []}}]
    with device_identity.control_connection() as connection:
        ciphertext = bytes(connection.execute('SELECT encrypted_output FROM vnext_quality_results').fetchone()[0])
    assert '陈敏'.encode() not in ciphertext


def test_disabled_clears_copies_not_recovery_and_cannot_backfill(context):
    retention.set_preference(context, True)
    task(context)
    result = answer(context)
    task(context, 'inflight')
    retention.set_preference(context, False)
    assert retention.read_retained_results(context) == []
    assert tasks.get_task(context, 'task')['result'] == result
    retention.set_preference(context, True)
    answer(context, 'inflight')
    # A replay never acquires newly granted permission.
    task(context)
    assert retention.read_retained_results(context) == []
    task(context, 'new')
    answer(context, 'new')
    assert len(retention.read_retained_results(context)) == 1


def test_enabling_never_collects_a_task_started_without_permission(context):
    task(context)
    retention.set_preference(context, True)
    answer(context)
    assert retention.read_retained_results(context) == []


@pytest.mark.parametrize('same_device', [False, True])
def test_permission_and_revocation_are_owner_isolated(context, same_device):
    other = DeviceV2Context(context.device_id if same_device else str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    retention.set_preference(context, True)
    task(context)
    answer(context)
    assert retention.get_preference(other)['enabled'] is False
    assert retention.read_retained_results(other) == []
    retention.set_preference(other, False)
    assert len(retention.read_retained_results(context)) == 1


def test_repeating_enabled_is_idempotent_not_a_new_permission(context):
    first = retention.set_preference(context, True)
    task(context)
    assert retention.set_preference(context, True) == first
    answer(context)
    assert len(retention.read_retained_results(context)) == 1


def test_purging_task_cascades_quality_results_and_grant(context):
    retention.set_preference(context, True)
    task(context)
    answer(context)
    with device_identity.control_connection() as connection:
        connection.execute('DELETE FROM vnext_tasks WHERE task_id=?', ('task',))
        for table in ('vnext_quality_results', 'vnext_quality_task_grants'):
            assert connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == 0


def test_optional_archive_failure_does_not_rollback_real_result(context, monkeypatch):
    retention.set_preference(context, True)
    task(context)
    monkeypatch.setattr(retention, '_cipher', lambda: (_ for _ in ()).throw(ValueError('test encryption failure')))
    result = answer(context)
    assert tasks.get_task(context, 'task')['result'] == result
    assert retention.read_retained_results(context) == []


def test_copy_and_optout_are_atomic_and_lazy(context):
    task(context)
    with device_identity.control_connection() as connection:
        assert retention.retain_in_transaction(connection, context, task_id='task', result_key='p1',
            kind='transcript', payload=lambda: pytest.fail('unapproved output accessed')) is False
    retention.set_preference(context, True)
    task(context, 'approved', 'transcript')
    with device_identity.control_connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        assert retention.retain_in_transaction(connection, context, task_id='approved', result_key='p1',
            kind='transcript', payload={'text': '实际生成文字'})
        connection.rollback()
    assert retention.read_retained_results(context) == []


@pytest.mark.parametrize('value', ['true', 1, None, {}])
def test_set_requires_an_explicit_boolean(context, value):
    with pytest.raises(ValueError):
        retention.set_preference(context, value)


def test_wire_contract_and_strict_boolean(tmp_path, monkeypatch):
    from test_device_v2_api import _client
    client, _ = _client(tmp_path, monkeypatch)
    url = '/api/device/v2/privacy/generated-results'
    assert client.get(url).json()['enabled'] is False
    assert client.put(url, json={'enabled': True}).json()['enabled'] is True
    for invalid in ({'enabled': 'true'}, {'enabled': 1}, {}, {'enabled': False, 'transcript': 'not accepted'}):
        assert client.put(url, json=invalid).status_code == 422
    assert client.get(url).json()['enabled'] is True
    assert client.put(url, json={'enabled': False}).json()['enabled'] is False
    client.app.dependency_overrides.clear()
    assert client.get(url).status_code == 401
    assert client.put(url, json={'enabled': True}).status_code == 401
