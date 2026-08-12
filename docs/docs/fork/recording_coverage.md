---
id: recording_coverage
title: Recording Coverage and Gaps
---

Frigate discards recording segments in several situations, and a camera whose
stream goes down produces nothing to discard in the first place. Historically
the only trace of any of this was a line in the log, so the usual way to find
out that footage was missing was to scrub onto the hole.

The **Coverage** tab under System reports this directly. Every cell is one hour
of one camera, shaded by how much of that hour is absent from the recordings
database, and every loss Frigate causes or observes is written to a
`RecordingGaps` row that names the cause. This page explains how to read the
grid and what each cause actually points at.

## Reading the grid

Each camera card shows a day by hour heatmap, a headline, and an hour of day
profile.

- **Coverage percentage.** Reported only for cameras with continuous retention
  (`record.continuous.days` greater than 0). For those cameras every second is
  expected, so the ratio is meaningful.
- **Event only cameras.** With continuous retention off, an empty hour means
  nothing happened rather than something broke. There is no denominator, so
  those cameras get a "when was footage kept" view and no percentage.
- **Outside retention.** Hatched cells are hours the grid cannot judge: beyond
  the rolling continuous retention window, before the camera's earliest kept
  footage, or still in the future.
- **By hour of day.** The bottom row averages each hour slot across the whole
  range. A dip in one column means losses recur at the same time every day,
  which usually points at a scheduled job on the host rather than at a camera.

:::tip

An incident and a pattern look completely different here. A single outage is a
dark block on one row. A nightly backup competing for disk is a faint vertical
stripe across every row, easy to miss in the grid but obvious in the hour of
day profile.

:::

## What the causes mean

### Recording mover fell behind (`cache_overflow`)

Segments are written first to the RAM cache at `/tmp/cache` and moved to disk
afterwards. When more than six already processed segments are waiting, Frigate
discards the oldest to avoid exhausting the cache and crashing.

This is a throughput problem, and the question is which resource ran out:

- **Storage cannot keep up.** The most common cause. Slow disks, a saturated or
  unreliable network share, or a mount using the `sync` option instead of
  `async`. High bitrate record streams multiplied across several cameras add up
  quickly.
- **CPU saturation.** Moving a segment runs an ffmpeg stream copy to add
  `faststart` metadata. It does not re-encode, but under a heavily loaded CPU
  it still cannot be scheduled fast enough.
- **Memory pressure.** If the host is swapping, every I/O operation slows down
  dramatically. Swap activity is a frequent hidden cause of this warning.
- **`/tmp/cache` too small.** If it is mounted as a small `tmpfs`, a brief
  backlog fills it much sooner.

To tell storage from CPU, enable `frigate.record.maintainer` debug logging and
read the copy durations: consistently over about a second points at storage,
consistently under it points at CPU or contention. The full procedure is in
[Unable to keep up with recording segments](/troubleshooting/recordings#i-see-the-message-warning--unable-to-keep-up-with-recording-segments-in-cache-for-camera-keeping-the-5-most-recent-segments-out-of-6-and-discarding-the-rest).

### Detect stream stalled (`detect_stalled`)

Segments accumulate in the cache waiting to be analyzed. When more than six
pile up **unprocessed**, the detect pipeline has stopped advancing and Frigate
discards the oldest.

:::warning

This cause is a symptom. Whatever stopped the detect pipeline is logged before
the discards begin, so read the logs from startup through the first occurrence.

:::

Common roots:

- **Detector too slow for the load.** Model too large, input size 640x640 where
  320x320 would do, detect resolution set to the full main stream, or detect
  fps above the recommended 5.
- **Detector hung.** GPU resets or driver hangs (check `dmesg` on the host),
  TPU dropouts, or GPU/TPU passthrough in a VM, which is a known source of
  stalls that Frigate cannot work around.
- **Segments arriving far too fast.** A camera using a "Smart Codec" or "+"
  mode corrupts timestamps, which splits segments into roughly one second
  pieces and fills the cache about ten times faster than expected.
- **Resources starved by other features.** Enrichments such as `genai` or face
  recognition competing for the same CPU or GPU.

Full walkthrough: [Too many unprocessed recording segments](/troubleshooting/recordings#i-see-the-message-warning--too-many-unprocessed-recording-segments-in-cache-for-camera-this-likely-indicates-an-issue-with-the-detect-stream).

### Segment had no video (`invalid_video`)

The segment reached disk cache but probing found no usable video stream. The
container exists and the file is intact, so this is not a storage fault: the
camera sent something that was not video.

- The camera kept the connection open but stopped sending video frames, often
  during a firmware fault or a mode change such as day to night switching.
- Codec changed mid-stream, so the segment holds frames the container header
  does not describe.
- The restream is pointing at an audio only track, or a go2rtc stream name was
  copied between cameras without updating the reference.
- Heavy packet loss over RTSP UDP, especially over Wi-Fi or a marginal PoE run.

### Segment was corrupt (`corrupt_segment`)

The segment probed to an impossible duration: zero or negative, or longer than
the ten minute ceiling. Frigate cannot place it on a timeline, so it is
discarded.

- **Corrupt timestamps from the camera.** The dominant cause, and again usually
  "Smart Codec"/H.264+ style modes that change encoding parameters mid-stream.
- **Camera clock jumps.** An NTP correction mid-segment can move timestamps far
  enough to produce a nonsensical duration.
- **Truncated writes.** ffmpeg killed part way through, commonly by the OOM
  killer under memory pressure, or a network share that dropped mid-write.

Rather than probing by hand, open the camera's **Camera Probe Info** dialog on
the System page and check the keyframe analysis, which flags the sparse or
variable keyframes these modes produce.

### Could not be written to disk (`remux_failed`)

The segment was valid, but the ffmpeg copy into the recordings directory
returned an error. The data existed and the filesystem refused it.

- Volume full, either genuinely (`df -h`) or out of inodes (`df -i`).
- Recordings landing on a different, smaller filesystem than intended because
  of an incorrect bind mount.
- A network share that dropped, returned stale handles, or mishandled locking.
- Permissions, or a filesystem remounted read only after an error.

:::note

A failed remux can leave a partial file at the destination path. Because the
move is skipped when a file already exists at that path, later attempts for the
same segment fall through without recovering it, and the cached copy is not
cleaned up. If you see a single long `remux_failed` range that keeps growing,
check for leftover partial files as well as the underlying cause.

:::

### Could not be stored (`move_failed`)

An exception was raised while storing the segment. This is the generic wrapper
around the same failure surface as above, and the real error is on the
following log line.

The two most common are `[Errno 28] No space left on device` and
`[Errno 17] File exists`, the latter being a hallmark of an unreliable NFS or
SMB mount. Both are host level problems rather than Frigate configuration, and
are covered in
[Error occurred when attempting to maintain recording cache](/troubleshooting/recordings#i-see-the-message-error--error-occurred-when-attempting-to-maintain-recording-cache).

### Deleted early for storage space (`storage_pressure`)

Frigate estimates how much space an hour of recording needs, and when free
space falls below that it deletes the oldest footage to stay ahead. If clearing
the oldest hour is not enough, it goes on to delete footage that retention
asked it to keep.

This cause means Frigate worked as designed, and that **your retention exceeds
what the disk can hold**. It is the one cause you fix by changing
configuration rather than by fixing a fault:

- Retention set longer than the volume supports at your actual bitrates.
  Estimated bandwidth is per camera, so adding cameras or raising resolution
  shortens how far back you can keep footage.
- Something other than Frigate consuming the same volume.
- A host level fill threshold (Unraid, for example) blocking writes before
  Frigate's own cleanup gets the chance to run. Leave more headroom, or reduce
  retention so purging happens sooner.

Review the estimates on the System page's Storage tab, then either lower
retention, lower the record stream bitrate, or add capacity.

### Camera stream disconnected (`stream_disconnected`)

No segment reached the cache, and the ffmpeg process writing recordings exited
during that stretch. The `detail` on the row carries its exit code and last
error output, which is usually the whole diagnosis:

| ffmpeg said                                   | It means                                                       |
| --------------------------------------------- | -------------------------------------------------------------- |
| `Connection timed out`, `Network unreachable` | The camera or the network path went away                       |
| `401 Unauthorized`, `403 Forbidden`           | Credentials rejected, often after a password rotation          |
| `Invalid data found when processing input`    | The camera sent something ffmpeg could not parse               |
| `Connection refused`                          | Nothing is listening, so the camera rebooted or go2rtc is down |
| `Immediate exit requested`                    | Frigate asked it to stop, so look for a restart instead        |

Root causes behind those:

- Camera offline, rebooting, or applying a firmware update.
- Network path down: a PoE switch port, a Wi-Fi dropout, a DHCP lease change
  giving the camera a new address, or a VLAN change.
- The camera refusing a new RTSP session because it hit its client limit, which
  often shows up after adding a second consumer such as a recorder or an app.
- go2rtc restream not running, when the record stream is sourced through it.

### Camera stopped sending video (`stream_stalled`)

No segment reached the cache, but the recording process stayed up the whole
time. The connection was still open and the camera simply stopped delivering
usable frames, so nothing was there to write.

- Camera CPU overloaded by too many simultaneous streams, so it stops serving
  the substream reliably while keeping the socket open.
- A camera that silently pauses its stream during its own night mode switch,
  IR cut filter change, or motion driven exposure change.
- An upstream device holding the TCP connection open after the camera behind
  it has gone, common with some PoE switches and Wi-Fi extenders.
- Severe host contention, where ffmpeg is running but starved of CPU.

### Frigate was not running (`frigate_restart`)

Booked once at startup, covering the stretch between the newest kept segment
and the moment Frigate came back. Nothing inside a single run can observe this,
which is why an update, a container restart, a crash, or a host reboot would
otherwise look like every camera failing at once.

- Ordinary restarts after a config change or a version upgrade.
- The container being OOM killed, which shows as a gap with no clean shutdown
  in the log before it.
- Host reboots, including unattended upgrades and power loss.

If these appear far more often than you restart deliberately, check the
container's restart count and the host's memory pressure.

### How absence is distinguished from bad segments

Segments that did arrive but were unusable are recorded as `invalid_video` or
`corrupt_segment` instead, so they never double count as absence.

Absence is measured by counting segments rather than by watching for a quiet
cache. A recording maintainer that is running late still moves every segment it
was given, so lateness must not be mistaken for a camera that stopped
producing: only a segment that was never written leaves a hole in the sequence.
That is what makes short dropouts visible. An earlier version of this feature
only noticed absence after roughly two minutes of silence, which meant the
common case, a camera that drops its connection for thirty to ninety seconds
and reconnects, was never recorded at all.

A gap runs from where the previous segment actually ended to where the next one
started. That distinction matters more than it sounds: a stream copy can only
cut on a keyframe, so a segment routinely outruns the configured segment length
and a camera set to ten second segments may write thirteen. Measuring from the
configured length instead of the real end would report that overshoot as
missing footage, inflating every gap by a few seconds and, on a camera with a
long keyframe interval, inventing gaps outright.

Because the boundaries are real rather than nominal, losses well under one
segment are reported. Segment filenames are stamped to the whole second, so
boundaries either side of a cut can disagree by about a second with nothing
wrong; anything within that is ignored.

An outage that is still running is booked before it ends, so a camera that
never comes back is still reported. Each booking starts where the last one
ended, so the same stretch is not counted twice when footage resumes.

## Matching a cause to a resource

When several cameras degrade together, the cause is usually the host. When one
camera degrades alone, it is usually that camera or its network path.

| Symptom in the grid                                     | Most likely constraint                                   |
| ------------------------------------------------------- | -------------------------------------------------------- |
| Every camera loses a little, continuously               | Disk throughput, or CPU if copy times are fast           |
| Every camera loses time at the same hour each day       | A scheduled job on the host, such as a backup or a scrub |
| One camera only, scattered short losses                 | That camera's stream or network path                     |
| One camera only, long solid blocks                      | Camera offline, or its detect pipeline stalled           |
| Losses begin after adding a camera or raising a bitrate | Aggregate throughput or retention headroom               |
| Oldest days shrink faster than retention says           | Storage capacity, reported as `storage_pressure`         |
| Every camera loses the same stretch, once               | Frigate restarted, reported as `frigate_restart`         |

When the cause is `stream_disconnected`, read the row's detail before reaching
for any of this: ffmpeg usually names the problem itself.

For diagnosing the underlying resource, see
[Troubleshooting CPU usage](/troubleshooting/cpu) and
[Troubleshooting memory usage](/troubleshooting/memory).

## How gaps are recorded

- **One row per incident, not per segment.** Losses arrive one segment at a
  time. Consecutive losses that share a camera and a cause extend a single
  range instead of writing a new row, so a camera down for six hours is one row
  rather than thousands. The `segments` column counts how many individual
  losses were merged.
- **Retention discards are not recorded.** A camera retaining on motion drops
  most of its segments by design. Those are the system working correctly, and
  recording them would be thousands of rows per camera per day burying the real
  failures.
- **Gaps expire with the footage they describe.** Each row is deleted once it
  falls outside the longest retention configured for its camera, since a gap
  outlives nothing.
- **Each row carries its evidence.** The `detail` column holds what was
  observed at the time, such as the ffmpeg error before a disconnect or the
  size of the backlog when the mover fell behind. A cause names the suspect;
  the detail is what you act on. It is trimmed to fit, keeping the end, because
  the last thing said before a failure is the useful part. Camera credentials
  are stripped before anything is stored.
- **An unattributed hole is possible.** Footage can be missing without a gap
  row, for example if it was lost before this feature existed or removed
  outside Frigate. Those hours show as missing with the cause given as not
  recorded, which is deliberate: the grid never guesses a cause. A camera whose
  causes are all unrecorded is the expected state right after installing this,
  since a cause is only known from the moment it happens and nothing is
  backfilled.

Gaps are available over the API at `GET /api/recordings/gaps`, accepting
`cameras`, `after`, and `before`. Each row carries `camera`, `start_time`,
`end_time`, `reason`, `segments`, and `detail`.
