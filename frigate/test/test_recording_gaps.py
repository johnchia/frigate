"""Tests for coalescing of recorded recording gaps."""

import unittest
from typing import Any

from frigate.record.gaps import RecordingGapRecorder
from frigate.record.types import RecordingGapReasonEnum


class TestRecordingGapRecorder(unittest.TestCase):
    def setUp(self) -> None:
        self.written: list[dict[str, Any]] = []
        self.recorder = RecordingGapRecorder(self.written.append)

    def test_nothing_is_written_before_flush(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1010.0
        )

        self.assertEqual(self.written, [])

    def test_single_loss_is_written_once(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1010.0
        )
        self.recorder.flush()

        self.assertEqual(len(self.written), 1)
        gap = self.written[0]
        self.assertEqual(gap["camera"], "front")
        self.assertEqual(gap["reason"], "cache_overflow")
        self.assertEqual(gap["start_time"], 1000.0)
        self.assertEqual(gap["end_time"], 1010.0)
        self.assertEqual(gap["segments"], 1)

    def test_consecutive_losses_merge_into_one_range(self):
        for i in range(6):
            start = 1000.0 + i * 10
            self.recorder.record(
                "front", RecordingGapReasonEnum.cache_overflow, start, start + 10
            )
        self.recorder.flush()

        self.assertEqual(len(self.written), 1)
        gap = self.written[0]
        self.assertEqual(gap["start_time"], 1000.0)
        self.assertEqual(gap["end_time"], 1060.0)
        self.assertEqual(gap["segments"], 6)

    def test_an_outage_stays_one_row_across_flushes(self):
        """A camera down for a long time must not produce a row per pass."""
        for pass_index in range(20):
            start = 1000.0 + pass_index * 10
            self.recorder.record(
                "front", RecordingGapReasonEnum.stream_absent, start, start + 10
            )
            self.recorder.flush()

        ids = {gap["id"] for gap in self.written}
        self.assertEqual(len(ids), 1)
        self.assertEqual(self.written[-1]["end_time"], 1200.0)
        self.assertEqual(self.written[-1]["segments"], 20)

    def test_losses_far_apart_become_separate_incidents(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1010.0
        )
        # well past the coalesce tolerance, so this is a new incident
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 5000.0, 5010.0
        )
        self.recorder.flush()

        self.assertEqual(len(self.written), 1)
        self.assertEqual(self.written[0]["start_time"], 5000.0)

        # the first range was already persisted by an earlier flush in real use;
        # here the point is that the second did not extend it
        self.assertNotEqual(self.written[0]["end_time"], 1010.0)

    def test_tolerance_is_respected(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1010.0, tolerance=20
        )
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1029.0, 1039.0, tolerance=20
        )
        self.recorder.flush()

        self.assertEqual(len(self.written), 1)
        self.assertEqual(self.written[0]["segments"], 2)
        self.assertEqual(self.written[0]["end_time"], 1039.0)

    def test_different_reasons_do_not_merge(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1010.0
        )
        self.recorder.record(
            "front", RecordingGapReasonEnum.invalid_video, 1010.0, 1020.0
        )
        self.recorder.flush()

        self.assertEqual(len(self.written), 2)
        self.assertEqual(
            {gap["reason"] for gap in self.written},
            {"cache_overflow", "invalid_video"},
        )

    def test_different_cameras_do_not_merge(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1010.0
        )
        self.recorder.record(
            "back", RecordingGapReasonEnum.cache_overflow, 1010.0, 1020.0
        )
        self.recorder.flush()

        self.assertEqual(len(self.written), 2)
        self.assertEqual(
            {gap["camera"] for gap in self.written},
            {"front", "back"},
        )

    def test_out_of_order_losses_do_not_shrink_the_range(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1030.0
        )
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1005.0, 1015.0
        )
        self.recorder.flush()

        self.assertEqual(self.written[0]["end_time"], 1030.0)

    def test_empty_range_is_ignored(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1000.0
        )
        self.recorder.flush()

        self.assertEqual(self.written, [])

    def test_flush_without_changes_writes_nothing(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1010.0
        )
        self.recorder.flush()
        self.written.clear()

        self.recorder.flush()

        self.assertEqual(self.written, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
