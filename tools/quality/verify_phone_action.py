"""Exercise an explicitly owned test action through real Android UI.

Start in the intended meeting detail. --create creates the supplied ASCII title;
otherwise the caller must own the named test row. Only that row is deleted.
This checks persistence and dialog ownership, not generated-action quality.
"""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hardware'))
from verify_phone_transfer import Phone


def main(args):
    p = Phone(args.serial)
    checks = []

    def wait(predicate):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            nodes = p.nodes()
            if predicate(nodes):
                return nodes
            time.sleep(.2)
        raise RuntimeError('Expected UI state not reached; no product pass asserted')

    def has(nodes, key, value):
        return any(n.get(key) == value for n in nodes)

    def tap(key, value, prefix=False):
        match = lambda n: n.get(key, '').startswith(value) if prefix else n.get(key) == value
        nodes = wait(lambda ns: any(match(n) for n in ns))
        targets = [n for n in nodes if match(n) and p.bounds(n)[3] - p.bounds(n)[1] < p.height]
        if len(targets) != 1:
            raise RuntimeError(f'Ambiguous or absent target: {value}')
        p.tap(targets[0])

    def record(case):
        checks.append(case)
        print(json.dumps({'case': case, 'passed': True}), flush=True)

    def open_collection():
        tap('content-desc', '更多会议记录操作')
        tap('text', '本场待办', prefix=True)
        return wait(lambda ns: has(ns, 'content-desc', '关闭本场待办'))

    try:
        nodes = p.nodes()
        if not has(nodes, 'text', args.meeting):
            raise RuntimeError('Not in the intended meeting detail')
        nodes = open_collection()
        if args.create:
            if has(nodes, 'text', args.title):
                raise RuntimeError('Test title already exists; refusing to create a duplicate')
            if not args.title.isascii():
                raise RuntimeError('For non-ASCII input enter the owned test draft through the installed IME instead')
            tap('content-desc', '新建待办事项')
            tap('content-desc', '待办事项内容')
            p.cmd('shell', 'input', 'text', args.title.replace(' ', '%s'))
            # Do not assume a software keyboard is open: BACK may close the
            # editor itself (for example with a hardware/ADB keyboard).
            tap('content-desc', '创建待办事项')
        nodes = wait(lambda ns: has(ns, 'text', args.title))
        if has(nodes, 'content-desc', '完成待办事项：' + args.title):
            tap('content-desc', '完成待办事项：' + args.title)
        wait(lambda ns: has(ns, 'text', args.title) and has(ns, 'content-desc', '恢复待办事项：' + args.title))
        record('completed_row_retained')
        tap('content-desc', '关闭本场待办')
        wait(lambda ns: not has(ns, 'content-desc', '关闭本场待办'))
        nodes = open_collection()
        if not has(nodes, 'content-desc', '恢复待办事项：' + args.title):
            raise RuntimeError('Completion was not restored')
        record('completed_after_reentry')
        tap('content-desc', '编辑待办事项：' + args.title)
        tap('content-desc', '删除待办事项')
        nodes = wait(lambda ns: has(ns, 'text', '删除待办事项') and not has(ns, 'content-desc', '关闭本场待办'))
        record('delete_confirmation_above_sheets')
        tap('text', '取消')
        wait(lambda ns: has(ns, 'content-desc', '待办事项内容') and has(ns, 'text', args.title))
        record('cancel_keeps_original_action')
        tap('content-desc', '删除待办事项')
        wait(lambda ns: has(ns, 'text', '删除待办事项') and not has(ns, 'content-desc', '关闭本场待办'))
        tap('text', '删除')
        wait(lambda ns: has(ns, 'content-desc', '关闭本场待办') and not has(ns, 'text', args.title))
        record('owned_action_deleted_and_collection_restored')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({'checks': checks, 'boundary': 'real UI, local persistence; no semantic quality verdict'}, indent=2) + '\n')
    finally:
        p.cleanup()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', required=True)
    parser.add_argument('--meeting', required=True)
    parser.add_argument('--title', required=True)
    parser.add_argument('--create', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    main(parser.parse_args())
