# Frigate NVR (fork)

A fork of [blakeblackshear/frigate](https://github.com/blakeblackshear/frigate).
Changes in this fork:

- **Detection region budget.** Bounds how many object detection regions each
  camera may run per second, and spends whatever capacity it has on the most
  valuable regions first, so that a camera in a motion storm degrades on its own
  instead of slowing down every other camera. Regions covering already tracked
  objects are always prioritized over new motion, so what degrades under pressure
  is how quickly new objects are discovered rather than how reliably existing
  ones are followed. Disabled by default, and reports what it would have done
  while off. See [Region budget](docs/docs/frigate/region_budget.md).
