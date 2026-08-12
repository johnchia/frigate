"""Types for recording maintenance."""

from enum import Enum


class RecordingGapReasonEnum(str, Enum):
    """Why a stretch of recording is missing.

    Every member is an unexpected loss. Segments discarded because a camera's
    retention mode did not ask to keep them are the normal case, not a gap, and
    are never recorded here: at a ten second segment length that would be
    thousands of rows per camera per day and would bury the real failures.
    """

    # the mover fell behind and discarded the cache backlog
    cache_overflow = "cache_overflow"
    # segments piled up unprocessed, which points at the detect stream
    detect_stalled = "detect_stalled"
    # the segment held no usable video stream
    invalid_video = "invalid_video"
    # the segment probed to an impossible duration
    corrupt_segment = "corrupt_segment"
    # remuxing the segment into the recordings directory failed
    remux_failed = "remux_failed"
    # storing the segment raised, so the cached copy was dropped
    move_failed = "move_failed"
    # storage ran short and footage was deleted before its retention expired
    storage_pressure = "storage_pressure"
    # no segment was produced at all, so the stream itself was down
    stream_absent = "stream_absent"
