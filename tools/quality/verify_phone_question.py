"""Physical-phone Q2 send/re-entry through visible UI, not database injection.

Requires the question sheet with the specified draft already entered. Does not
install an IME, change clipboard/radios, delete data or manufacture an answer.
Elapsed time includes accessibility inspection overhead, not precise render time.
"""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hardware"))
from verify_phone_transfer import Phone


def turn_texts(nodes, turn):
    # Android's accessibility tree may flatten the non-accessible View's
    # children into sibling nodes. Scope by visible turn bounds, not DOM shape.
    left, top, right, bottom = Phone.bounds(turn)
    texts = []
    for node in nodes:
        if not node.get("text") or node.get("package") != "com.laoji.app":
            continue
        x1, y1, x2, y2 = Phone.bounds(node)
        if left <= x1 < x2 <= right and top <= y1 < y2 <= bottom:
            texts.append(node.get("text"))
    return texts


def main(args):
    phone = Phone(args.serial)
    report = {"boundary": "real phone UI and production services", "checks": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    def record(case, **values):
        row = {"case": case, **values}
        report["checks"].append(row)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(row, ensure_ascii=False), flush=True)
    def unique(nodes, key, value):
        matches = [node for node in nodes if node.get(key) == value]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one visible {value}, got {len(matches)}")
        return matches[0]
    try:
        nodes = phone.nodes()
        if not any(node.get("text") == args.title for node in nodes):
            raise RuntimeError("Question belongs to another meeting")
        began = time.monotonic()
        report["start_epoch_ms"] = int(time.time() * 1000)
        prior_turns = set()
        if not args.observe:
            field = unique(nodes, "resource-id", "meeting-question-input")
            if field.get("text") != args.question:
                raise RuntimeError("Draft differs from the intended real question")
            prior_turns = {node.get("resource-id") for node in nodes
                           if node.get("resource-id", "").startswith("meeting-question-turn-")}
            phone.tap(unique(nodes, "resource-id", "meeting-question-send"))
            nodes = phone.nodes()
            record("after_send", pending=any(node.get("resource-id") == "meeting-question-pending-turn" for node in nodes))
            if any(node.get("resource-id") == "meeting-question-input" and node.get("text") == args.question for node in nodes):
                raise RuntimeError("Probe tap did not dispatch the draft; inspect keyboard/overlay before retrying")
        if args.reenter and not args.observe:
            phone.tap(unique(nodes, "content-desc", "关闭会议问答"))
            nodes = phone.nodes()
            phone.tap(unique(nodes, "content-desc", "更多会议记录操作"))
            nodes = phone.nodes()
            phone.tap(unique(nodes, "text", "会议问答"))
            nodes = phone.nodes()
            record("reentered", pending=any(node.get("resource-id") == "meeting-question-pending-turn" for node in nodes))
        while time.monotonic() - began < 120:
            turns = [node for node in nodes if node.get("resource-id", "").startswith("meeting-question-turn-")
                     and node.get("resource-id") not in prior_turns]
            for turn in turns:
                texts = turn_texts(nodes, turn)
                if args.question in texts:
                    record("completed", elapsed_upper_bound_s=round(time.monotonic() - began, 3), texts=texts)
                    return
            error = [node.get("text") for node in nodes if node.get("text", "").startswith(("上一条未能完成", "会议问答暂时", "会议服务暂时"))]
            if error:
                raise RuntimeError(";".join(error))
            time.sleep(0.5)
            nodes = phone.nodes()
        record("probe_inconclusive", reason="No matching visible completed turn in observation window")
        raise RuntimeError("No completed local turn within the observation window; not a service failure verdict")
    finally:
        phone.cleanup()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--question", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reenter", action="store_true")
    parser.add_argument("--observe", action="store_true", help="Read an existing visible result; does not send a question")
    main(parser.parse_args())
