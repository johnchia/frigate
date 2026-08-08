---
id: region_budget
title: Region budget
---

The region budget bounds how much object detection work a single camera can
generate, so that one busy scene cannot slow down every other camera.

It is disabled by default. When disabled it still measures and reports what it
would have done, which lets you size it against your own cameras before it
changes anything.

## Why it exists

All cameras share a single detection queue. Every detector pulls from that queue,
which balances load well, but nothing limits how much any one camera puts on it.

The number of regions a camera submits per frame depends entirely on its scene.
Motion detection returns every contour above the configured area threshold, with
no upper bound on how many. Wind in a treeline, heavy rain, snow, or headlights
sweeping across a street can each produce dozens of motion areas, and every one of
them becomes a separate inference request.

When that happens, inference latency rises for all cameras at once. The frame
queues fill, and Frigate begins dropping whole frames to keep up. Those drops are
indiscriminate: a dropped frame may well be the one holding the object you care
about, and losing it breaks that object's track.

The region budget replaces that with something predictable. Each camera gets a
cap, and the capacity it does have is spent on the most valuable regions first.

## How it works

### Regions are ranked before they are run

Whenever detection capacity is short, whatever is submitted first is what
survives. Frigate orders regions by how much is lost if they are skipped:

1. **Regions covering objects already being tracked.** Skipping one of these
   breaks the object's track, so Frigate loses its identity and its zone history,
   and emits it as a brand new object when it reappears. These are always funded
   first.
2. **Regions covering new motion.** Skipping one of these only delays discovering
   something, which is a far cheaper loss.
3. **The startup scan.** Purely speculative, so it goes last.

The guiding rule is that under pressure Frigate should degrade how quickly it
_discovers_ new things, and never how reliably it _follows_ what it has already
found.

### New motion regions are ranked by history

Frigate already keeps a per camera grid recording where confirmed objects have
appeared in the past. It uses this to size regions appropriately for each part of
the frame, since an object near the horizon is much smaller than one in the
foreground.

The budget reuses that same grid for priority. A region sitting where objects have
historically appeared, such as a driveway or a footpath, outranks one over a patch
of sky or a wall. Region size is also taken into account, so on a new camera with
no history yet the ranking falls back to preferring larger regions.

### A share is reserved for unexplored areas

Ranking purely by history would be self reinforcing. An area that never gets
looked at never accumulates the detections that would raise its priority, so a
newly installed gate in a previously quiet corner of the frame could stay ignored
indefinitely.

To prevent that, a small share of each camera's budget (10% by default) is
reserved for the lowest ranked motion regions. This keeps the rest of the frame
sampled, and it is what allows the grid to learn about genuinely new activity.

### The cap is metered per camera

Each camera meters its own regions per second locally, with no coordination
overhead on the per frame path. Unused capacity accumulates for up to one second,
so a brief burst of activity can draw on a quiet moment just before it, but a
camera that has been idle for an hour cannot bank an hour of budget and spend it
all at once.

## Configuration

The budget can be set globally, per camera, or both. Camera level settings
override the global ones.

```yaml
# applies to every camera
detect:
  region_budget:
    enabled: true
    max_per_second: 12
```

```yaml
cameras:
  front_door:
    detect:
      region_budget:
        enabled: true
        max_per_second: 20
  side_yard:
    detect:
      region_budget:
        enabled: true
        max_per_second: 4
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Whether the cap is actually applied. When false, the budget is still calculated and reported, but every region runs. |
| `max_per_second` | unset | Maximum detection regions per second. Leave unset to have Frigate derive it. Must be a positive whole number. |
| `min_per_second` | `2` | Floor applied to the derived value so a camera is never starved completely. |
| `explore_fraction` | `0.1` | Share of the budget reserved for regions with little detection history. |

### Letting Frigate derive the budget

If `max_per_second` is left unset, Frigate calculates it from how fast your
detectors are actually running:

```
budget per camera = (combined detector throughput x 0.85) / enabled cameras
```

Detector throughput is measured continuously, so this adapts to a model change, a
detector swap, or an accelerator that slows down when it gets hot. Frigate waits
60 seconds after startup before deriving anything, so that the measurements are
real rather than initial estimates, then recalculates every 5 minutes.

The 15% that is held back is deliberate headroom. Driving detectors to full
saturation is what causes the latency spikes this feature exists to avoid.

Note that the division is across **all** enabled cameras, including any that have
the budget turned off, because those cameras still consume detector capacity.

This adapts to how much capacity you have, not to who needs it. Every camera
receives the same share regardless of how busy its scene is, and a quiet camera's
unused portion is not transferred to a busy one. In exchange you get a firm,
predictable ceiling on total detection load.

### Setting it yourself

Set `max_per_second` explicitly when you want a camera held to a known rate. Be
aware of two consequences:

- Frigate decides which cameras it manages automatically once, at startup. A
  camera with an explicit value is treated as yours and is never recalculated, so
  it will not adapt if you later change detectors or add cameras. Remove the
  setting and restart to hand it back to automatic control.
- `min_per_second` only applies to derived values. It does not raise a limit you
  set yourself, so `max_per_second: 1` really does mean one region per second.

### Applying changes

Edit `config.yml` and restart Frigate. Most `detect` settings apply at runtime,
but Frigate determines which cameras it manages automatically at startup, so a
restart is the reliable way to change this particular setting.

## Monitoring

Go to **System > Cameras**. Each camera shows a small badge next to its connection
quality indicator with its current budget, for example `12/s`. Hovering it shows
how many regions have been requested, how many were allowed, how many were
skipped, and whether the cap is being enforced or only observed.

The badge does not appear until a budget exists, so expect nothing for the first
minute after startup while measurement is still in progress.

The same values are available from `/api/stats` for each camera:

| Field | Description |
| --- | --- |
| `regions_requested` | Total regions the camera has asked to run |
| `regions_admitted` | Total the budget allowed |
| `regions_shed` | The difference between the two |
| `region_budget` | Current limit in regions per second, or null if not yet derived |
| `region_budget_enforced` | Whether the cap is actually being applied |

## Recommended rollout

1. **Start with `enabled: false`**, which is the default. Leave it for a few days
   across a range of conditions, including bad weather and nighttime, when scenes
   are busiest.
2. **Look at `regions_shed`.** With enforcement off this is the number of regions
   a live budget _would_ have skipped. If it stays at or near zero, you have
   capacity to spare and the budget will rarely engage. If it is large on one
   camera in particular, that camera is the one crowding out the others.
3. **Adjust if needed.** Raise `max_per_second` on the cameras that matter most,
   or lower it on ones producing large amounts of low value motion. Improving
   motion masks on a noisy camera is often the better fix, and the shed counts are
   a good way to find which camera needs it.
4. **Set `enabled: true`** once the numbers look reasonable.

Because enforcement is skipped entirely until a budget has been derived, turning
it on cannot starve a camera while Frigate is still starting up.

## Troubleshooting

**Nothing is being capped even though I set `max_per_second`.**
Setting a limit does not turn enforcement on. `enabled` defaults to `false`, so
the budget is calculated and reported while every region still runs. Set both.

**The badge never appears.**
It is hidden until a budget exists. Wait a minute after startup. If it still does
not appear, confirm that at least one detector is configured and that detection is
enabled for the camera.

**My camera stopped detecting things it used to find.**
Check `regions_shed` for that camera. If it is climbing quickly, the cap is too low
for the scene. Raise `max_per_second`, or leave it unset to let Frigate derive one.
Objects already being tracked are always prioritized over new ones, so this
normally shows up as slower discovery of new objects rather than as losing objects
mid track.

**Detection got slower after adding cameras.**
The derived budget is divided across all enabled cameras, so each camera's share
drops as you add more. This is intended, and it reflects that the detectors
genuinely have less to give each camera. Adding detector capacity, or raising the
limit on the cameras that matter most, are the ways to address it.
