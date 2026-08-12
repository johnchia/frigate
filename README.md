# Frigate NVR (fork)

A fork of [blakeblackshear/frigate](https://github.com/blakeblackshear/frigate).

## Changes on this branch

- **Recording coverage grid.** Adds a per camera heatmap to System >
  Storage, one cell per hour, shaded by how much of that hour is missing
  from the recordings database, plus an hour of day profile for losses that
  repeat on a schedule. Frigate drops segments in several places (mover
  backlog, stalled detect stream, corrupt or unremuxable segments, storage
  pressure) and reports it only in the logs, so gaps were previously found
  by scrubbing onto them. A percentage is reported only where continuous
  retention makes one meaningful.
- **Motion tuner threshold preview.** Draws a patch over the camera image while
  a motion slider is held, sized by `contour_area` and strobing by `threshold`,
  so both can be judged against the scene instead of computed by hand. Neither
  value is in units the image shows: contour area is measured on the downscaled
  motion frame, and threshold is a luma delta against the running background.
- **Region grid clear coverage.** Tests for upstream's fix that keeps a cleared
  region grid cleared across a rebuild, which upstream shipped without any.
- **Devcontainer bytecode.** Sets `PYTHONDONTWRITEBYTECODE` on the devcontainer
  service so the container stops writing root owned `__pycache__` into the bind
  mounted working tree, where it cannot be cleaned up without `sudo`.

## Developed on branches, not merged here

- **Detection region budget**
  ([`region-budget`](https://github.com/johnchia/frigate/tree/region-budget)).
  Bounds how many object detection regions each camera may run per second, and
  spends whatever capacity it has on the most valuable regions first, so that a
  camera in a motion storm degrades on its own instead of slowing down every
  other camera. Regions covering already tracked objects are always prioritized
  over new motion, so what degrades under pressure is how quickly new objects
  are discovered rather than how reliably existing ones are followed. Disabled
  by default, and reports what it would have done while off.
  [Documentation](https://github.com/johnchia/frigate/blob/region-budget/docs/docs/frigate/region_budget.md).
