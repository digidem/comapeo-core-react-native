# Benchmarking the backend's footprint

The `:ComapeoCore` process is the one that gets killed first when Android is
short of memory: it runs in the background with `oom_score_adj 200` for life,
and the kernel's `oom_score` scales with footprint, so every megabyte off the
backend makes it a less attractive victim than the foreground UI. That makes
"what does this change cost in memory" a question worth being able to answer
cheaply and repeatedly.

There are two ways to answer it, and they share one implementation.

| | Where | What it answers |
|---|---|---|
| [`scripts/benchmark-boot.sh`](../scripts/benchmark-boot.sh) | one device you control | "Is build B lighter than build A?" — an A/B you run before merging |
| [Sentry gauges](#the-fleet-view-sentry-gauges) | every install with diagnostics on | "Did it hold up on real devices?" — after shipping |

Both read the same numbers from
[`backend/lib/memory-snapshot.js`](../backend/lib/memory-snapshot.js).

## What gets measured, and why those numbers

`memorySnapshot()` returns three things.

**Peak RSS (`VmHWM`).** The high-water mark of resident memory since the
process started. This is the headline number: it is what the low-memory killer
effectively scores the process on, and because it is monotonic, one late read
still captures the boot peak — no high-rate sampling needed to find it.

**Current RSS, split into anonymous / file-backed / swapped.** The split
matters because only anonymous memory moves when you change how much the
backend allocates. File-backed pages are dominated by the ~46 MB of
`libnode.so` mapped straight out of the APK, and they will not shift no matter
what you do to the JavaScript. A change that looks like a 5% win on total RSS
is often a 10% win on the part you actually influenced.

**V8 heap statistics.** `used_heap_size` is the live object graph;
`total_physical_size` is the heap memory actually committed and touched. Report
both: a V8 build flag can shrink the first while barely denting the process, or
commit far more than it uses. `total_physical_size` is the one that tracks
anonymous RSS. `heap_size_limit` is there as a control — if it moved, the
comparison is not measuring what you think it is.

The process-level numbers come from `/proc/self/status`, which exists only on
Android. On iOS node runs in-process, so the same fields would describe the UI
too; the reader returns `null` there and only the V8 numbers are reported. The
platform gate is the filesystem, not a flag that could drift.

## Running an A/B locally

The harness is built for comparing two builds, not for producing absolute
figures. Emulator numbers do not transfer to a physical device — V8 sizes its
heap from physical RAM, among other things — but the *difference* between two
builds measured the same way usually does.

The simple case, when you have two APKs:

```sh
./scripts/benchmark-boot.sh --ab /tmp/before.apk /tmp/after.apk \
    --rounds 3 --per-round 5
```

That runs 15 cold boots of each, alternating which build goes first every
round, and prints a comparison at the end. If you only have one thing to
measure, run it twice and compare the files:

```sh
./scripts/benchmark-boot.sh --label before --iterations 10
# …change something, rebuild…
./scripts/benchmark-boot.sh --label after --iterations 10
node scripts/benchmark-report.mjs benchmark-results/before.json \
                                  benchmark-results/after.json
```

With no `--apk` or `--ab` it builds `apps/integration` in Release first.
Benchmark against Release, never debug: `startForeground` alone is about ten
times slower in a debug build.

Useful flags: `--device <serial>` (required when more than one is attached),
`--iterations`, `--rounds` / `--per-round`, `--duration` (seconds to watch each
boot, default 20), `--abi`, `--skip-build`, `--out`.

Output lands in `benchmark-results/` (gitignored): one JSON per label plus the
raw per-boot logcat captures under a per-invocation `raw/<timestamp>/`
directory — the second invocation of a before/after comparison does not
overwrite the first's captures, which are worth keeping when a run looks
strange.

### Reading the output

```
metric                   baseline  candidate     delta       %        p
-----------------------------------------------------------------------
Peak RSS (MB)               274.4      261.0     -13.4    -4.9   <0.001
Anonymous RSS (MB)          103.3       92.5     -10.8   -10.5    0.029
V8 live heap (MB)            25.4       15.8      -9.6   -37.8   <0.001

per-round medians (peak RSS, MB):
round      baseline  candidate
1             274.2      261.2
2             274.4      261.0
3             275.1      261.1
```

Medians, not means: boot measurements are skewed by the occasional scheduling
stall, and one stalled boot drags a mean around. The p-values are two-sided
Mann–Whitney U over the individual boots — they say whether *these* boots
differ, not whether the effect holds on hardware you did not test.

**The per-round table is the one to check first.** A development machine is
usually doing other things, and host load drifts over the twenty-odd minutes a
full run takes. If the two builds separate the same way in every round, the
difference is the build. If the rounds disagree, you measured the machine.

### Things that will bite you

- **Steady-state RSS is bimodal.** By the time the sample is taken, a ~24 MB
  block has either been released back or not, and which happens varies boot to
  boot. Peak RSS does not have this problem, which is another reason to lead
  with it. If you need the settled number, take enough boots to see both modes
  in each build and compare them mode-for-mode.
- **The compile cache is only wiped when adb runs as root.** The wipe exists
  so that swapping APKs doesn't leave one build paying for a
  `NODE_COMPILE_CACHE` the other wrote, but app cache directories are
  private, so it only works after `adb root` (emulators, userdebug builds).
  With root, measured boots are cold-cache — the worst case, and the one that
  matters for a process that may be killed at startup. Without it the harness
  prints a warning and the boots are warm-cache; the memory numbers are still
  valid, but treat the timing comparison with suspicion, especially right
  after swapping APKs.
- **The first boot after each install is discarded** — it faults the freshly
  written APK in.
- **`VmSize` is not a footprint.** A V8 build with pointer compression reserves
  a 4 GB cage per isolate, which never becomes resident. The harness does not
  report it for exactly this reason.

### Without root

The harness works unmodified on a production device: the boot timings come
from the module's `[comapeo.*]` lifecycle crumbs in logcat, and peak RSS, RSS
and the heap breakdown come from the backend's own `[comapeo.memory] boot`
log line, which reads `/proc/self` and needs no privilege. The only thing
root buys is the compile-cache wipe above.

## The fleet view: Sentry gauges

The same snapshot feeds four gauges, emitted once about three seconds after
`ready` and then every 60 seconds:

| Metric | Unit | Platforms |
|---|---|---|
| `comapeo.backend.heap_used_bytes` | byte | both |
| `comapeo.backend.heap_physical_bytes` | byte | both |
| `comapeo.backend.rss_bytes` | byte | Android |
| `comapeo.backend.rss_peak_bytes` | byte | Android |

All four carry `device_class`, `os_major`, `runtime` and `sample`.

`sample` is `boot` or `interval`, naming which of the two call sites emitted
the gauge. Without it the boot samples and the 60-second series are one
population, so a release that changes how long processes live — or how often
the boot sample lands at all — moves the percentiles on its own and reads as a
footprint change. Filter to one before comparing two builds.

`runtime` is `process.versions.mobile`, the nodejs-mobile revision — the
dimension you group by to compare two runtime builds in the field, and the
reason a staged rollout can answer "did the new libnode help" without a
bespoke experiment. It is one value per shipped build, so it costs nothing in
cardinality and is no more identifying than the app version already on every
event. The same value is the `nodejs_mobile` tag on Sentry events (both read
`runtimeVersion()` in `memory-snapshot.js`), so events and metrics join on it.

`device_class` and `os_major` are there because memory is the metric whose
whole point is the cheap device. `heap_used_bytes` originally shipped without
them, and the consequence is concrete: after three months and ~16k samples,
its Android tail (p50 70 MB, p99 287 MB, max 518 MB — the ceiling is about
542 MB) cannot be attributed to a device class at all, which is the only
question worth asking of it.

It only separates builds that carry different revisions, though. A libnode
built from an unmerged branch reports whatever tag it was based on, so two such
builds are indistinguishable by this attribute — locally that does not matter
(the harness knows which APK it installed), but anything shipped to devices for
comparison needs its own revision. Bump the nodejs-mobile tag before a staged
rollout you intend to measure.

The extra boot-time sample exists because a process killed before the first
60-second tick is precisely the case worth knowing about; without it, the
fleet data would be silently biased towards processes that survived. That case
is common: 88 of the FGS exits reported from production in the last 90 days
sit in the `<10s` uptime bucket. It fires 3s after `ready` — `ready` lands
~1.8s in and `VmHWM` stops climbing at ~2s, so 3s captures the boot peak and
still reports inside the window a short-lived process survives.

### Cost

One `memorySnapshot()` call measured **~28 µs** on an arm64 emulator (500
iterations, Release build): a 1.3 KB `/proc/self/status` read plus
`v8.getHeapStatistics()`, neither of which triggers a GC or a syscall storm.
Two calls in the first minute, then one a minute — about 0.3 ms of CPU across a
ten-minute session. The `/proc` read and the parse are also skipped entirely on
iOS, where the file does not exist.

### Which consent tier, and why

**All four sit at the diagnostic tier**, alongside `heap_used_bytes`, which has
been diagnostic since it was added.

The rule this repo applies is that anything whose value or frequency reveals
what, when, or how much a user does belongs behind the application-usage
opt-in; process resource health does not. These gauges are on the health side:

- They describe the backend's own footprint. They name nothing the user did —
  no method names, no project or peer counts, no sync volumes, all of which
  stay usage-gated where they already are.
- The headline number is a boot measurement, and the boot peak is
  overwhelmingly a property of the build and the device rather than of the
  data: compiling the 3 MB bundle, initialising V8, and the two Argon2
  derivations dominate it, and it is essentially unchanged with no client
  attached.
- The cadence is fixed and coarse, and deliberately not tied to activity. A
  gauge sampled *after each sync* would be usage-shape data no matter what it
  measured; one sampled every 60 seconds regardless is not.
- The inference risk that does exist — heap size drifting upward with dataset
  size over a long session — is identical to `heap_used_bytes`, which is
  already collected at this tier. Adding RSS alongside it changes the units,
  not the class of information.

Two things stay out on purpose:

- **Free device memory** (`os.freemem()`). It is already available as the
  `node_resources` event context and is **usage-tier**, because read-at-capture
  frequency is itself usage-shape data. Do not promote it to a diagnostic-tier
  metric to sit next to these; that would quietly reclassify it.
- **Anything device-identifying as an attribute.** Total RAM, core count, ABI,
  OS version and app version are already on every event, and the bucketed
  `device_class` / `os_major` tags are already on the duration metrics. Slice
  by those; do not re-send them.

If this reasoning is ever revisited, the thing to re-examine is the 60-second
series, not the boot sample — the boot sample is the part that is clearly about
the build.

## Adding a metric

`docs/sentry-integration.md` §8 has the full rules. The short version for
anything in this area: go through the `metrics.js` wrappers (they inject
`platform` and run the forbidden-attribute filter), name it
`comapeo.<area>.<thing>_<unit>` with an explicit unit, keep attributes
low-cardinality and non-identifying, decide the tier explicitly, and guard the
*work* behind `metrics.isEnabled()` if computing the number is expensive —
these gauges are cheap enough that they do not need it, but a storage walk
does.
