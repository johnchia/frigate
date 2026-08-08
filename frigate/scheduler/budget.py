"""Derives and enforces a per camera budget for detection regions.

Every camera shares one detection queue, so a camera whose scene generates an
unbounded number of motion regions raises inference latency for all of them. The
budget bounds how much detection work a single camera can generate, letting a
camera in a motion storm degrade on its own.

Two pieces live here:

- RegionBucket runs inside each camera process and meters regions per second.
- RegionBudgetPublisher runs in the main process, derives a budget from the
  measured speed of the configured detectors, and publishes it to the cameras
  over the existing camera config update channel.
"""

import logging
import threading
import time
from multiprocessing.synchronize import Event as MpEvent
from typing import Any

from frigate.config import FrigateConfig
from frigate.config.camera.updater import (
    CameraConfigUpdateEnum,
    CameraConfigUpdatePublisher,
    CameraConfigUpdateTopic,
)

logger = logging.getLogger(__name__)

# leave headroom rather than driving the detectors to saturation
UTILIZATION_TARGET = 0.85

# let the detectors record real inference times before deriving anything
WARMUP_SECONDS = 60

# how often the derived budget is recalculated
REFRESH_SECONDS = 300

# republish only once the budget has moved enough to be worth the message
MIN_CHANGE = 1


class RegionBucket:
    """Token bucket metering how many detection regions a camera may run.

    Lives in the camera process and is spent locally, so metering costs no
    interprocess round trip on the per frame path.
    """

    def __init__(self, rate: float = 0.0) -> None:
        self.rate = rate
        self.tokens = rate
        self.updated = time.monotonic()

    def set_rate(self, rate: float) -> None:
        """Apply a new rate, without carrying a stale balance across the change."""
        if rate == self.rate:
            return

        self.rate = rate
        self.tokens = min(self.tokens, rate)

    def allowance(self, now: float | None = None) -> int:
        """Whole regions available right now, refilling for elapsed time.

        Burst is capped at one second of capacity so that a quiet camera cannot
        bank budget and then spend it all at once.
        """
        if self.rate <= 0:
            return 0

        now = time.monotonic() if now is None else now
        elapsed = max(0.0, now - self.updated)
        self.updated = now
        self.tokens = min(self.rate, self.tokens + elapsed * self.rate)

        return int(self.tokens)

    def consume(self, count: int) -> None:
        self.tokens = max(0.0, self.tokens - count)


def derive_budget(
    inference_speeds: list[float],
    camera_count: int,
    min_per_second: int,
) -> int | None:
    """Regions per second each camera may run, from measured detector speed.

    This is a plain division over measured inference speed, not a feedback loop:
    it never reads queue latency, so it cannot oscillate.

    Args:
        inference_speeds: Mean seconds per inference for each detector
        camera_count: Number of enabled cameras sharing those detectors
        min_per_second: Floor so that a camera is never starved completely

    Returns:
        The derived budget, or None if no detector has reported a speed yet
    """
    usable = [speed for speed in inference_speeds if speed > 0]

    if not usable or camera_count <= 0:
        return None

    # a detector averaging `speed` seconds per inference sustains 1/speed per second
    capacity = sum(1.0 / speed for speed in usable)

    return max(min_per_second, int(capacity * UTILIZATION_TARGET / camera_count))


class RegionBudgetPublisher(threading.Thread):
    """Recalculates the derived region budget and publishes it to the cameras."""

    def __init__(
        self,
        config: FrigateConfig,
        config_updater: CameraConfigUpdatePublisher,
        detectors: dict[str, Any],
        stop_event: MpEvent,
    ) -> None:
        super().__init__(name="region_budget", daemon=True)
        self.config = config
        self.config_updater = config_updater
        self.detectors = detectors
        self.stop_event = stop_event

        # cameras that left max_per_second unset are the ones this thread owns;
        # an explicitly configured value is the operator's and is never replaced
        self.auto_cameras = {
            name
            for name, camera in config.cameras.items()
            if camera.detect.region_budget.max_per_second is None
        }

    def run(self) -> None:
        if self.stop_event.wait(WARMUP_SECONDS):
            return

        while True:
            try:
                self._refresh()
            except Exception:
                logger.exception("Failed to refresh the detection region budget")

            if self.stop_event.wait(REFRESH_SECONDS):
                break

    def _refresh(self) -> None:
        enabled = [
            name
            for name, camera in self.config.cameras.items()
            if camera.enabled_in_config
        ]

        if not enabled:
            return

        speeds = [
            detector.avg_inference_speed.value for detector in self.detectors.values()
        ]

        for name in enabled:
            if name not in self.auto_cameras:
                continue

            camera = self.config.cameras[name]
            budget = camera.detect.region_budget
            derived = derive_budget(speeds, len(enabled), budget.min_per_second)

            if derived is None:
                continue

            current = budget.max_per_second

            if current is not None and abs(current - derived) < MIN_CHANGE:
                continue

            budget.max_per_second = derived
            logger.debug("Derived region budget for %s: %s/s", name, derived)

            self.config_updater.publish_update(
                CameraConfigUpdateTopic(CameraConfigUpdateEnum.detect, name),
                camera.detect,
            )
