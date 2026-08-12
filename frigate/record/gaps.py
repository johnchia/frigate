"""Record stretches of time where recording was expected but is missing."""

from __future__ import annotations

import datetime
import logging
import random
import string
from collections.abc import Callable, Iterable
from typing import TYPE_CHECKING, Any

from frigate.models import RecordingGaps, Recordings
from frigate.record.types import RecordingGapReasonEnum
from frigate.util.builtin import get_record_segment_time

if TYPE_CHECKING:
    from frigate.config import FrigateConfig

logger = logging.getLogger(__name__)

# Two losses this far apart or closer are treated as one incident. A camera
# that is down produces a loss every segment, so anything shorter than a couple
# of segments would split a single outage into a row per segment.
MIN_COALESCE_TOLERANCE = 30

# The detail column is sized to hold an error, not a log. Anything longer is
# cut from the front because the last lines before a failure are the useful
# ones.
MAX_DETAIL_LENGTH = 255

# Segment cache filenames are stamped to the second, so a segment's recorded
# end and the next one's start can disagree by about a second with nothing
# actually missing between them.
SEGMENT_BOUNDARY_JITTER = 2.0


def trim_detail(detail: str | None) -> str | None:
    """Reduce evidence to something that fits the column, keeping the tail."""
    if not detail:
        return None

    collapsed = " ".join(detail.split())

    if len(collapsed) <= MAX_DETAIL_LENGTH:
        return collapsed

    return f"...{collapsed[-(MAX_DETAIL_LENGTH - 3) :]}"


def format_ffmpeg_failure(returncode: int | None, output: Iterable[str]) -> str:
    """Describe an ffmpeg failure using its own last words.

    The lines come from a LogPipe, which has already stripped camera
    credentials, so this is safe to persist.
    """
    lines = [line.strip() for line in output if line.strip()]
    tail = " | ".join(lines[-3:])

    if returncode is None:
        return trim_detail(tail) or "ffmpeg produced no output"

    return trim_detail(
        f"ffmpeg exited with code {returncode}: {tail}"
        if tail
        else f"ffmpeg exited with code {returncode}"
    )


def format_duration(seconds: float) -> str:
    """Render a span the way a person would say it."""
    total = int(seconds)

    if total < 60:
        return f"{total}s"

    if total < 3600:
        return f"{total // 60}m {total % 60}s"

    return f"{total // 3600}h {(total % 3600) // 60}m"


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
        detail: str | None = None,
    ) -> None:
        """Note a loss, extending the open range for this camera and reason."""
        if end_time <= start_time:
            return

        key = (camera, reason.value)
        gap = self._open.get(key)
        detail = trim_detail(detail)

        if gap is not None and start_time <= gap["end_time"] + tolerance:
            # the same incident continuing, so widen it rather than start again
            gap["end_time"] = max(gap["end_time"], end_time)
            gap["segments"] += 1

            # the first evidence is the proximate cause, so later passes only
            # fill in a blank rather than overwrite what started the incident
            if gap[RecordingGaps.detail.name] is None:
                gap[RecordingGaps.detail.name] = detail
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
                RecordingGaps.detail.name: detail,
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


class StreamAbsenceTracker:
    """Turn a camera's segment timeline into gaps that name a suspect.

    A stretch with no segments is only half a diagnosis. The recording
    watchdog is the one place that sees both when segments stopped arriving
    and what the recording process said on its way out, so the two are joined
    here rather than leaving the absence to be explained later by guesswork.

    Absence is measured in segments rather than in cache staleness on purpose:
    a recording maintainer that is running late still moves every segment it
    was given, so lateness must not read as a camera that stopped producing.
    Only a segment that was never written leaves a hole in the sequence.
    """

    def __init__(
        self,
        camera: str,
        segment_time: float,
        poll_interval: float,
        recorder: RecordingGapRecorder,
    ) -> None:
        self.camera = camera
        self.segment_time = segment_time
        self.poll_interval = poll_interval
        self.recorder = recorder
        self.last_segment_end: float = 0
        self.booked_until: float = 0
        self.exit_time: float = 0
        self.exit_detail: str | None = None

    def reset(self) -> None:
        """Forget the timeline across a deliberate stop.

        Disabling a camera or reloading its config is not lost footage, so the
        stretches either side of the change must not be joined into a gap.
        """
        self.last_segment_end = 0
        self.booked_until = 0

    def note_segment(
        self, start_time: float | None, end_time: float | None = None
    ) -> None:
        """Track that a segment existed, booking anything skipped before it.

        The end is where the previous segment actually stopped, not where its
        configured length said it would. A stream copy can only cut on a
        keyframe, so segments regularly outrun the configured length, and
        measuring from the nominal end reports that overshoot as missing
        footage that was never missing.
        """
        if start_time is None:
            return

        previous_end = self.last_segment_end

        # a segment that could not be probed has no trustworthy duration, so
        # its nominal length is the best guess available for where it ended
        self.last_segment_end = max(
            previous_end,
            end_time if end_time else start_time + self.segment_time,
        )

        if previous_end <= 0:
            return

        # segment filenames carry whole seconds, so a boundary can look off by
        # about a second in either direction without anything being wrong
        if start_time <= previous_end + SEGMENT_BOUNDARY_JITTER:
            return

        self.book(previous_end, start_time)

    def note_process_exit(
        self, returncode: int | None, output: Iterable[str], now: float | None = None
    ) -> str:
        """Keep what the recording process said on its way out."""
        self.exit_time = now if now is not None else datetime.datetime.now().timestamp()
        self.exit_detail = format_ffmpeg_failure(returncode, output)
        return self.exit_detail

    def classify(
        self, start: float, end: float
    ) -> tuple[RecordingGapReasonEnum, str | None]:
        """Name the suspect for a stretch where no segment was written."""
        # the poll that noticed an exit can land a cycle either side of the
        # stretch it explains, so allow for that before blaming the process
        slack = max(self.poll_interval, self.segment_time)

        if self.exit_time > 0 and (start - slack) <= self.exit_time <= (end + slack):
            return RecordingGapReasonEnum.stream_disconnected, self.exit_detail

        return (
            RecordingGapReasonEnum.stream_stalled,
            f"no segments written for {format_duration(end - start)} and the "
            "recording process was not seen to exit",
        )

    def book(self, start: float, end: float) -> None:
        """Record a stretch with no segments, without counting it twice.

        An outage is booked while it is still running and again once segments
        resume, so each booking starts where the last one ended.
        """
        start = max(start, self.booked_until)

        if end <= start:
            return

        reason, detail = self.classify(start, end)
        self.recorder.record(
            self.camera,
            reason,
            start,
            end,
            tolerance=max(MIN_COALESCE_TOLERANCE, 2 * self.segment_time),
            detail=detail,
        )
        self.recorder.flush()
        self.booked_until = end


def upsert_recording_gap(gap: dict[str, Any]) -> None:
    """Write a gap directly, for callers that already hold the database."""
    RecordingGaps.insert(gap).on_conflict(
        conflict_target=[RecordingGaps.id],
        update=gap,
    ).execute()


def record_restart_gaps(config: FrigateConfig) -> None:
    """Book the footage lost while Frigate was not running.

    Nothing inside a single run can observe this: the watchdog only sees the
    segment timeline of the process it lives in. Comparing the newest kept
    segment against startup is the only way a restart stops being blamed on
    the camera.
    """
    now = datetime.datetime.now().timestamp()
    recorder = RecordingGapRecorder(upsert_recording_gap)

    for camera, camera_config in config.cameras.items():
        if not camera_config.record.enabled_in_config:
            continue

        try:
            latest = (
                Recordings.select(Recordings.end_time)
                .where(Recordings.camera == camera)
                .order_by(Recordings.end_time.desc())
                .limit(1)
                .scalar()
            )
        except Exception:
            logger.exception("Unable to read the latest recording for %s", camera)
            continue

        # a camera that has never recorded has nothing to be missing from
        if not latest:
            continue

        segment_time = get_record_segment_time(camera_config)
        away = now - float(latest)

        # a clean restart still costs the segment that was in flight, so only
        # book spans that lost more than the changeover itself
        if away <= max(MIN_COALESCE_TOLERANCE, 2 * segment_time):
            continue

        recorder.record(
            camera,
            RecordingGapReasonEnum.frigate_restart,
            float(latest),
            now,
            detail=f"Frigate was not recording for {format_duration(away)}",
        )

    recorder.flush()
