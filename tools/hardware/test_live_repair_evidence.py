"""Fault evidence is scoped to this capture, never cumulative fixture history."""
import json
import unittest
from verify_live_repair import latest_capture_gaps, wait_control
from unittest.mock import patch


class LiveRepairEvidenceTest(unittest.TestCase):
    def test_previous_recordings_are_not_counted_as_this_recordings_faults(self):
        rows = [{'event':'capture.started'}, {'event':'injected_live_gap','sequence':9},
                {'event':'capture.finished'}, {'event':'capture.started'},
                {'event':'injected_live_gap','sequence':800}, {'event':'injected_live_gap','sequence':801}]
        log='fixture log\n'+'\n'.join(json.dumps(row) for row in rows)
        self.assertEqual([800,801],[row['sequence'] for row in latest_capture_gaps(log)])

    def test_missing_capture_marker_cannot_approve_unscoped_evidence(self):
        with self.assertRaises(AssertionError):latest_capture_gaps('{"event":"injected_live_gap"}')

    def test_busy_accessibility_snapshot_is_retried_without_using_stale_coordinates(self):
        node = {'content-desc':'结束','enabled':'true'}
        class Phone:
            def __init__(self): self.samples = iter([[], [node]])
            def nodes(self): return next(self.samples)
        with patch('verify_live_repair.time.sleep'):
            self.assertIs(wait_control(Phone(), lambda n:n.get('content-desc')=='结束'), node)

    def test_ambiguous_control_never_selects_an_arbitrary_one(self):
        class Phone:
            def nodes(self): return [{'enabled':'true'},{'enabled':'true'}]
        with self.assertRaises(AssertionError):wait_control(Phone(), lambda n:True)


if __name__=='__main__':unittest.main()
