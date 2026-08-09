# Frigate NVR (fork)

A fork of [blakeblackshear/frigate](https://github.com/blakeblackshear/frigate).

## Changes on this branch

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
