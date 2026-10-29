"""Read-only deployed retention check; never emit generated/source content."""
import argparse
import json
import os
from pathlib import Path
from types import SimpleNamespace


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-pid', type=int, required=True)
    parser.add_argument('--task-id', required=True)
    parser.add_argument('--enabled', choices=('true', 'false'), required=True)
    args = parser.parse_args()
    env = Path(f'/proc/{args.runtime_pid}/environ').read_text().split('\0')
    os.environ.update(dict(item.split('=', 1) for item in env if '=' in item))
    from app.services import device_identity, generation_retention, vnext_source_stream_store
    with device_identity.control_connection() as connection:
        task = connection.execute('SELECT * FROM vnext_tasks WHERE task_id=?', (args.task_id,)).fetchone()
        assert task is not None and task['state'] == 'success'
        context = SimpleNamespace(device_id=task['device_id'], epoch_id=task['epoch_id'])
        count = connection.execute('''SELECT COUNT(*) FROM vnext_quality_results result
            JOIN vnext_tasks task ON task.task_id=result.task_id WHERE task.device_id=? AND task.epoch_id=?''',
            (context.device_id, context.epoch_id)).fetchone()[0]
    enabled = args.enabled == 'true'
    preference = generation_retention.get_preference(context)
    assert preference['enabled'] == enabled
    copies = generation_retention.read_retained_results(context)
    artifact = vnext_source_stream_store.load_generated_artifact(context, args.task_id)
    assert artifact is not None, 'recovery artifact must remain available independently of permission'
    matches = any(row['kind'] == 'summary' and row['output'] == artifact['output'] for row in copies)
    if enabled:
        assert matches and count >= 1
    else:
        assert count == 0 and not copies
    print(json.dumps({'enabled': enabled, 'revision': preference['revision'], 'quality_copies': count,
        'matches_actual_generated_result': matches, 'recovery_readable': True,
        'recovery_output_sha256': artifact['output_sha256']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
