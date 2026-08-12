"""Record stretches of time where recording was expected but is missing."""

import logging
import random
import string
from collections.abc import Callable
from typing import Any

from frigate.models import RecordingGaps
from frigate.record.types import RecordingGapReasonEnum

logger = logging.getLogger(__name__)

# Two losses this far apart or closer are treated as one incident. A camera
# that is down produces a loss every segment, so anything shorter than a couple
# of segments would split a single outage into a row per segment.
MIN_COALESCE_TOLERANCE = 30


class RecordingGapRecorder:
    """Accumulate recording losses and persist them as coalesced ranges.

    Losses arrive one segment at a time. Writing a row each time would turn a
    six hour outage into thousands of rows, so consecutive losses that share a
    camera and a reason extend a single open range instead. Ranges are only
    handed to the sink on `flush`, which keeps a pass that drops thousands of
    segments to one write rather than thousands.

    Callers are expected to feed losses for a given camera and reason in
    ascending start order, which is how both the cache and the storage
    maintainer walk them.
    """

    def __init__(self, sink: Callable[[dict[str, Any]], None]) -> None:
        self.sink = sink
        self._open: dict[tuple[str, str], dict[str, Any]] = {}
        self._dirty: set[tuple[str, str]] = set()

    def record(
        self,
        camera: str,
        reason: RecordingGapReasonEnum,
        start_time: float,
        end_time: float,
        tolerance: float = MIN_COALESCE_TOLERANCE,
    ) -> None:
        """Note a loss, extending the open range for this camera and reason."""
        if end_time <= start_time:
            return

        key = (camera, reason.value)
        gap = self._open.get(key)

        if gap is not None and start_time <= gap["end_time"] + tolerance:
            # the same incident continuing, so widen it rather than start again
            gap["end_time"] = max(gap["end_time"], end_time)
            gap["segments"] += 1
        else:
            rand_id = "".join(
                random.choices(string.ascii_lowercase + string.digits, k=6)
            )
            self._open[key] = {
                RecordingGaps.id.name: f"{start_time}-{rand_id}",
                RecordingGaps.camera.name: camera,
                RecordingGaps.reason.name: reason.value,
                RecordingGaps.start_time.name: start_time,
                RecordingGaps.end_time.name: end_time,
                RecordingGaps.segments.name: 1,
            }

        self._dirty.add(key)

    def flush(self) -> None:
        """Persist every range touched since the last flush."""
        if not self._dirty:
            return

        for key in self._dirty:
            gap = self._open.get(key)

            if gap is not None:
                self.sink(dict(gap))

        self._dirty.clear()


def upsert_recording_gap(gap: dict[str, Any]) -> None:
    """Write a gap directly, for callers that already hold the database."""
    RecordingGaps.insert(gap).on_conflict(
        conflict_target=[RecordingGaps.id],
        update=gap,
    ).execute()
