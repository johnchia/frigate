# Frigate NVR (fork)

A fork of [blakeblackshear/frigate](https://github.com/blakeblackshear/frigate).

## New features

- **Recording coverage.** Adds a Coverage tab under System with a per camera
  heatmap, one cell per hour, shaded by how much of that hour is missing from
  the recordings database, plus an hour of day profile for losses that repeat
  on a schedule. A coverage percentage is reported only where continuous
  retention makes one meaningful; event only cameras get a "when was footage
  kept" view instead, because for them an empty hour is the normal case.
- **Recorded gap causes.** Frigate discards recording segments in several
  places (mover backlog, stalled detect stream, invalid or corrupt segments,
  failed remux, storage pressure) and a stream that goes down leaves no trace
  at all. All of those now write a `RecordingGaps` row naming the cause, with
  consecutive losses coalesced into one range so an outage is a single row
  rather than one per segment. The coverage grid reads them back, so a gap says
  why it happened instead of only that it did.
- **Diagnosable stream dropouts.** Absence is counted from the segment sequence
  rather than from a two minute staleness timer, so the common case of a camera
  dropping its connection for under a minute is recorded instead of vanishing.
  Boundaries come from each segment's real end rather than its configured
  length, since a stream copy only cuts on keyframes and the resulting
  overshoot would otherwise be reported as missing footage.
  Each gap is classified by evidence gathered as it happened: whether the
  recording process exited (`stream_disconnected`, carrying ffmpeg's own exit
  code and error, so `401 Unauthorized` and `Connection timed out` are told
  apart), stayed up producing nothing (`stream_stalled`), or whether Frigate
  itself was down (`frigate_restart`, so a host reboot is not blamed on every
  camera at once). Every cause now carries a `detail` string, which is what
  makes a row worth reading.
- **Motion tuner threshold preview.** Draws a patch over the camera image while
  a motion slider is held, sized by `contour_area` and strobing by `threshold`,
  so both can be judged against the scene instead of computed by hand. Neither
  value is in units the image shows: contour area is measured on the downscaled
  motion frame, and threshold is a luma delta against the running background.

## Minor improvements

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
