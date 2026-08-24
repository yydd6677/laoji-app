from __future__ import annotations

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_schedule_database_isolation as verifier


class ScheduleDatabaseIsolationTest(unittest.TestCase):
    def test_source_boundaries(self) -> None:
        verifier.verify_source_boundaries()

    def test_sqlite_isolation(self) -> None:
        verifier.verify_sqlite_isolation()


if __name__ == "__main__":
    unittest.main()
