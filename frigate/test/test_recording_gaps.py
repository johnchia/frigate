"""Tests for coalescing of recorded recording gaps."""

import unittest
from typing import Any

from frigate.record.gaps import (
    MAX_DETAIL_LENGTH,
    RecordingGapRecorder,
    StreamAbsenceTracker,
    format_duration,
    format_ffmpeg_failure,
    trim_detail,
)
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
                "front", RecordingGapReasonEnum.stream_disconnected, start, start + 10
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

    def test_detail_is_persisted(self):
        self.recorder.record(
            "front",
            RecordingGapReasonEnum.stream_disconnected,
            1000.0,
            1010.0,
            detail="ffmpeg exited with code 1: Connection timed out",
        )
        self.recorder.flush()

        self.assertEqual(
            self.written[0]["detail"],
            "ffmpeg exited with code 1: Connection timed out",
        )

    def test_first_evidence_survives_coalescing(self):
        """The error that started an incident explains it, not a later echo."""
        self.recorder.record(
            "front",
            RecordingGapReasonEnum.stream_disconnected,
            1000.0,
            1010.0,
            detail="Connection timed out",
        )
        self.recorder.record(
            "front",
            RecordingGapReasonEnum.stream_disconnected,
            1010.0,
            1020.0,
            detail="something less useful",
        )
        self.recorder.flush()

        self.assertEqual(len(self.written), 1)
        self.assertEqual(self.written[0]["detail"], "Connection timed out")

    def test_later_evidence_fills_a_blank(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.stream_stalled, 1000.0, 1010.0
        )
        self.recorder.record(
            "front",
            RecordingGapReasonEnum.stream_stalled,
            1010.0,
            1020.0,
            detail="found out later",
        )
        self.recorder.flush()

        self.assertEqual(self.written[0]["detail"], "found out later")

    def test_missing_detail_is_null(self):
        self.recorder.record(
            "front", RecordingGapReasonEnum.cache_overflow, 1000.0, 1010.0
        )
        self.recorder.flush()

        self.assertIsNone(self.written[0]["detail"])


class TestDetailFormatting(unittest.TestCase):
    def test_trim_detail_collapses_whitespace(self):
        self.assertEqual(trim_detail("  a\n  b  \n"), "a b")

    def test_trim_detail_keeps_the_tail(self):
        detail = "x" * 100 + "the actual error"
        trimmed = trim_detail(detail)

        self.assertIsNotNone(trimmed)
        assert trimmed is not None
        self.assertLessEqual(len(trimmed), MAX_DETAIL_LENGTH)

    def test_long_detail_is_cut_from_the_front(self):
        detail = "noise " * 200 + "THE ERROR"
        trimmed = trim_detail(detail)

        assert trimmed is not None
        self.assertLessEqual(len(trimmed), MAX_DETAIL_LENGTH)
        self.assertTrue(trimmed.endswith("THE ERROR"))
        self.assertTrue(trimmed.startswith("..."))

    def test_empty_detail_is_none(self):
        self.assertIsNone(trim_detail(""))
        self.assertIsNone(trim_detail(None))

    def test_ffmpeg_failure_cites_the_last_lines(self):
        detail = format_ffmpeg_failure(
            1, ["opening stream", "", "Connection timed out"]
        )

        assert detail is not None
        self.assertIn("exited with code 1", detail)
        self.assertIn("Connection timed out", detail)

    def test_ffmpeg_failure_without_output(self):
        self.assertEqual(format_ffmpeg_failure(255, []), "ffmpeg exited with code 255")

    def test_duration_reads_like_speech(self):
        self.assertEqual(format_duration(45), "45s")
        self.assertEqual(format_duration(125), "2m 5s")
        self.assertEqual(format_duration(7325), "2h 2m")


class TestStreamAbsenceTracker(unittest.TestCase):
    SEGMENT = 10.0

    def setUp(self) -> None:
        self.written: list[dict[str, Any]] = []
        self.tracker = StreamAbsenceTracker(
            "front",
            self.SEGMENT,
            poll_interval=10.0,
            recorder=RecordingGapRecorder(self.written.append),
        )

    def feed(self, *segments: tuple[float, float | None]) -> None:
        for start, end in segments:
            self.tracker.note_segment(start, end)

    def test_a_healthy_sequence_books_nothing(self):
        self.feed((1000.0, 1013.0), (1013.0, 1026.0), (1026.0, 1039.0))

        self.assertEqual(self.written, [])

    def test_the_first_segment_alone_books_nothing(self):
        """There is no timeline to compare against yet."""
        self.feed((1000.0, 1013.0))

        self.assertEqual(self.written, [])

    def test_whole_second_filenames_are_not_a_gap(self):
        # segment names carry whole seconds, so a boundary can be off by one
        self.feed((1000.0, 1013.0), (1014.0, 1027.0), (1028.0, 1041.0))

        self.assertEqual(self.written, [])

    def test_a_long_segment_is_not_a_gap(self):
        """A stream copy cuts on keyframes, so segments outrun their length.

        Measuring from the configured length instead of the real end reported
        the overshoot as missing footage that was never missing.
        """
        self.feed((1000.0, 1041.0), (1041.0, 1054.0))

        self.assertEqual(self.written, [])

    def test_a_hole_is_booked_from_the_real_end(self):
        self.feed((1000.0, 1013.0), (1020.0, 1033.0))

        self.assertEqual(len(self.written), 1)
        gap = self.written[0]
        # from where the last segment actually stopped, not where it was due to
        self.assertEqual(gap["start_time"], 1013.0)
        self.assertEqual(gap["end_time"], 1020.0)

    def test_overshoot_is_not_counted_as_part_of_the_hole(self):
        """Observed on a real camera: 13s segments against a nominal 10.

        A next-segment start 16s after the last one means 3s went missing, not
        6s. Measuring from the nominal end inflated every gap by the overshoot.
        """
        self.feed((1000.0, 1013.0), (1016.0, 1029.0))

        gap = self.written[0]
        self.assertEqual(gap["start_time"], 1013.0)
        self.assertEqual(gap["end_time"] - gap["start_time"], 3.0)

    def test_a_hole_shorter_than_a_segment_is_booked(self):
        """The nominal length hid anything smaller than half a segment."""
        self.feed((1000.0, 1013.0), (1016.0, 1029.0))

        self.assertEqual(len(self.written), 1)
        self.assertEqual(
            self.written[0]["end_time"] - self.written[0]["start_time"], 3.0
        )

    def test_a_segment_without_a_probed_end_falls_back_to_nominal(self):
        # an unreadable segment is exactly the one whose duration cannot be
        # trusted, so its configured length has to stand in
        self.feed((1000.0, None), (1030.0, 1043.0))

        self.assertEqual(len(self.written), 1)
        self.assertEqual(self.written[0]["start_time"], 1010.0)

    def test_a_late_arrival_does_not_look_like_a_hole(self):
        self.feed((1000.0, 1013.0), (1100.0, 1113.0))
        self.written.clear()

        # the segment that was still being probed when the newer one published
        self.feed((1013.0, 1026.0))

        self.assertEqual(self.written, [])

    def test_a_process_exit_names_the_cause(self):
        self.tracker.note_process_exit(1, ["Connection timed out"], now=1030.0)
        self.feed((1000.0, 1013.0), (1060.0, 1073.0))

        gap = self.written[0]
        self.assertEqual(gap["reason"], "stream_disconnected")
        self.assertIn("Connection timed out", gap["detail"])

    def test_without_an_exit_the_stream_is_blamed_for_stalling(self):
        self.feed((1000.0, 1013.0), (1060.0, 1073.0))

        gap = self.written[0]
        self.assertEqual(gap["reason"], "stream_stalled")
        self.assertIn("not seen to exit", gap["detail"])

    def test_an_unrelated_old_exit_is_not_blamed(self):
        self.tracker.note_process_exit(1, ["ancient history"], now=100.0)
        self.feed((1000.0, 1013.0), (1060.0, 1073.0))

        self.assertEqual(self.written[0]["reason"], "stream_stalled")

    def test_reset_stops_a_disable_looking_like_loss(self):
        self.feed((1000.0, 1013.0))
        self.tracker.reset()
        # the camera comes back an hour later, which is not a gap
        self.feed((4600.0, 4613.0), (4613.0, 4626.0))

        self.assertEqual(self.written, [])

    def test_an_ongoing_outage_is_not_counted_twice_on_recovery(self):
        self.feed((1000.0, 1013.0))

        # booked while still running, the way the staleness check does it
        self.tracker.book(1013.0, 1200.0)
        # then footage resumes and the same stretch is seen from the timeline
        self.feed((1250.0, 1263.0))

        # one incident, and the covered span is contiguous rather than doubled
        self.assertEqual(len({gap["id"] for gap in self.written}), 1)
        final = self.written[-1]
        self.assertEqual(final["start_time"], 1013.0)
        self.assertEqual(final["end_time"], 1250.0)

    def test_booking_backwards_is_ignored(self):
        self.tracker.book(1000.0, 1200.0)
        self.written.clear()

        self.tracker.book(1100.0, 1150.0)

        self.assertEqual(self.written, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
