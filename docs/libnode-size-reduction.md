# `libnode.so` size-reduction options

Reference on where the ~50 MB per-ABI size of
[`nodejs-mobile`](https://github.com/nodejs-mobile/nodejs-mobile)'s
`libnode.so` comes from, what the project already does, and what levers
remain. Companion docs:
[build-architecture-plan.md](./build-architecture-plan.md),
[runtime-alternatives.md](./runtime-alternatives.md).

All claims below are traceable to nodejs-mobile sources (linked inline).
Percentage estimates for size reductions are ranges from public Node /
V8 benchmarks; actuals will vary. Treat the numbers as directional, not
precise.

---

## 1. Current state

### Configure invocation

[`android_configure.py`](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/android_configure.py)
runs literally:

```
./configure --dest-cpu=<arch> --dest-os=android \
            --openssl-no-asm --with-intl=none \
            --cross-compiling --shared
```

iOS uses
[`tools/ios_framework_prepare.sh`](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/tools/ios_framework_prepare.sh)
with equivalent flags.

The CI build
([`.github/workflows/build-mobile.yml`](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/.github/workflows/build-mobile.yml))
passes `LDFLAGS='-Wl,-z,max-page-size=16384'` for Android 16 KB page
alignment. No other size-related flags.

### What that gets us

- **`--with-intl=none`** — ICU stripped. This is the largest single
  saving on a stock Node build (full ICU + data is 8–12 MB). Already
  done.
- **`--openssl-no-asm`** — smaller OpenSSL (no per-arch assembly
  kernels). Slightly slower crypto, smaller binary.
- **`--shared`** — emits `libnode.so` rather than a `node` executable.
- LTO is supported via the `enable_lto` gypi flag (see
  [`common.gypi`](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/common.gypi))
  but is **opt-in and not enabled in the nodejs-mobile CI build.**
- Debug symbols stripped in Release config (standard).

### Released size

From
[nodejs-mobile releases](https://github.com/nodejs-mobile/nodejs-mobile/releases):

| Version | Platform | Zip size (all ABIs) | Per-ABI uncompressed (approx) |
|---------|----------|---------------------|-------------------------------|
| v18.20.4 | Android  | 57 MB               | ~50 MB                        |
| v18.20.4 | iOS      | 51 MB               | ~50 MB                        |
| v18.17.3 | Android  | 55 MB               | ~48 MB                        |

### What gets linked in

From
[`ios_framework_prepare.sh`](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/tools/ios_framework_prepare.sh)
the per-arch static-lib list that ends up in `libnode.so` /
`NodeMobile.framework`:

- Runtime: `libnode.a`, `libuv.a`
- V8: `libv8_base_without_compiler.a`, `libv8_compiler.a`,
  `libv8_initializers.a`, `libv8_libbase.a`, `libv8_libplatform.a`,
  `libv8_snapshot.a`, `libv8_zlib.a`
- Crypto / TLS: `libopenssl.a`
- HTTP / protocol: `libllhttp.a`, `libnghttp2.a`, `libnghttp3.a`,
  `libngtcp2.a`, `libada.a`
- Networking: `libcares.a` (async DNS)
- Compression: `libzlib.a`, `libbrotli.a`
- Utilities: `libbase64.a` (+ per-arch SIMD variants), `libsimdutf.a`,
  `libhistogram.a`, `libuvwasi.a`

Notably present and unused by our stack (`fastify` HTTP/1 + UDS + hypercore):
**nghttp2, nghttp3, ngtcp2, uvwasi, brotli, cares**. Each is reachable
by normal Node code paths but not by ours.

---

## 2. Available levers

Ordered by impact-per-effort. All estimates are directional.

### Tier 1 — safe configure flags (no patching)

| Change | Impact | Cost | Notes |
|--------|--------|------|-------|
| `--enable-lto` | ~3–8% | Trivial — one flag | Clang LTO (`-flto`). Longer CI build time but no code changes. Also enables cross-TU dead-code and ICF-like optimisations. |
| `--without-inspector` | 1–3 MB | Trivial | Drops V8 inspector + CDP. We're not remote-debugging the embedded Node. |
| `--without-npm` | ~1 MB | Trivial | npm CLI is embedded in the node build; ships with the shared lib. Not reachable from our bundle but still present. |
| `--without-dtrace --without-etw` | <0.5 MB | Trivial | Platform tracing. Off on mobile anyway. |
| `-ffunction-sections -fdata-sections -Wl,--gc-sections` | 2–5% | Trivial — LDFLAGS/CFLAGS | Dead-code elim at link time. Verify with `readelf` whether Android NDK already enables these. |
| `-Wl,--icf=all` | 3–7% on C++ | Trivial — LLD only | Identical code folding. Clang/LLD emits merged code for functions with identical bodies. Huge wins on template-heavy C++ like V8. |

**Tier 1 combined:** realistic **10–15% reduction**. ~50 MB → ~42–45 MB.
Days of CI tuning, no code patches, no ongoing maintenance.

### Tier 2 — V8 subsystem flags (requires `GYP_DEFINES` or `common.gypi` tweak)

| Change | Impact | Cost | Notes |
|--------|--------|------|-------|
| `v8_enable_webassembly=0` | **~4–6 MB** | Medium — patch `common.gypi` or pass via `GYP_DEFINES` | Backend doesn't run WASM. This is the **largest single lever not already pulled.** |
| `v8_enable_i18n_support=0` | ~0.5 MB | Trivial | `--with-intl=none` handles most of this at the Node layer; the V8-layer flag closes the remaining slice. |
| `v8_enable_pointer_compression=1` | ~5–10% of V8 code | Medium — check current state | Usually on by default on 64-bit; verify. |
| `v8_use_external_startup_data=1` | neutral (splits, doesn't shrink) | - | Splits snapshot data into a separate file. Same total size; not recommended unless you have a specific reason. |

**Tier 2 delta (mainly WASM disable):** another **4–6 MB**. Combined with
Tier 1: ~50 MB → **~36–40 MB**.

### Tier 3 — remove Node dependencies we don't use

Requires patching Node's gyp files or the node_main wiring. Committed as
patches on top of nodejs-mobile; rebased on each upstream bump.

| Change | Impact | Cost | Notes |
|--------|--------|------|-------|
| Drop `nghttp2` + `nghttp3` + `ngtcp2` | 3–5 MB | High — gyp surgery; disables `node:http2` and QUIC | Safe if backend runs HTTP/1.1 only. Fastify can — **but verify no transitive dep requires HTTP/2.** |
| Drop `uvwasi` | 0.5–1 MB | Medium | Disables `node:wasi`. Not used. |
| Drop `brotli` | 1–2 MB | Medium | Disables `zlib.brotliCompress/Decompress`. Audit for any transitive use. |
| Drop `cares` | 1–2 MB | Medium-High | Replacing `dns.resolve*` with `dns.lookup` (libc resolver) loses async DNS features. Low risk for UDS-based backend since we don't do real DNS. |
| Drop `simdutf` | ~0.5 MB | Low | Performance-sensitive UTF-8 decoding. Removing makes string handling slower. Probably not worth it. |

**Tier 3 delta:** 5–10 MB if the full patch set is viable. Combined
with Tiers 1 and 2: **~27–33 MB per ABI plausible**.

### Tier 4 — aggressive, generally not recommended

- **`-Os` vs `-O3`**: trades ~10–20% speed for ~10% more size
  reduction. Not worth it for a crypto/hypercore workload.
- **Custom V8 build profile** (d8-minimal style) — drops V8 debug
  helpers. Few MB saved. Maintenance-heavy; rebases painfully across V8
  versions.
- **UPX compression** of the final `.so`: adds startup cost and
  defeats mmap-from-APK
  ([build-architecture-plan.md §3](./build-architecture-plan.md)).
  **Don't.**
- **Skip 16 KB page alignment** — saves a tiny amount but breaks
  Android 15+ on 16 KB-page devices. Not an option.

---

## 3. Node version growth

No public nodejs-mobile branch with Node 20/22/24 exists as of April
2026; v18.20.4 is current. Approximate size deltas from public Node
release binaries:

| Hop | Size growth | Why |
|-----|-------------|-----|
| 18 → 20 | +12–18% | V8 10.x → 11.x, new web platform APIs, additional built-ins |
| 20 → 22 | +8–12% | V8 12.x, QUIC support shipped, incremental features |
| 22 → 24 | +5–8% | V8 13.x, smaller incremental |

**If nodejs-mobile eventually bumps to Node 24 on the current config:**
expect **~50 MB → ~65–70 MB** per ABI.

**Tier 1 + 2 + 3 reductions more than offset a full Node 18→24 jump.** A
Node 24 build with the size-flags stack plausibly ends up *smaller*
than today's out-of-the-box 18.20.4.

---

## 4. Recommended action

Asymmetric effort ordering — Tier 1 is nearly free, Tier 3 is a
commitment to maintain patches forever.

1. **Short-term (1 day of CI fiddling).** Fork nodejs-mobile's build
   config with all Tier 1 flags + `v8_enable_webassembly=0`. Natural
   home is a patch layer in
   [`digidem/nodejs-mobile-bare-prebuilds`](https://github.com/digidem/nodejs-mobile-bare-prebuilds)
   — either inject flags in the reusable workflow or maintain a thin
   nodejs-mobile fork.  
   **Expected result:** ~42 → ~36 MB per ABI. ~28–35% reduction vs
   out-of-box.
2. **Medium-term (if size is still a distribution blocker).** Add
   Tier 3 patches (drop http2/http3/brotli/cares). Commit to rebasing
   patches on each nodejs-mobile bump. **Expected result:** ~27–33 MB
   per ABI.
3. **Long-term.** The only way to break below ~25 MB per ABI is
   switching runtime. Bare's V8 variant is roughly 30% smaller than
   nodejs-mobile; Bare's JSC variant on iOS is dramatically smaller
   because JSC is system-provided. See
   [runtime-alternatives.md](./runtime-alternatives.md).

---

## 5. What to watch

- **nodejs-mobile's Node 20/22 port (if it materialises).** Size
  delta will tell us whether our Tier 1+2+3 patch set survives or needs
  revising.
- **Upstream V8 `v8_enable_shared_ro_heap` and related flags** — may
  open new size reductions in future V8 releases.
- **`pnpm` builds and Corepack** — Node 22 removed some corepack
  wiring; check whether future nodejs-mobile inherits.
- **Android 16 KB page alignment corner cases.** The LDFLAG is set;
  verify with `readelf -l | grep LOAD` after each build that `.so`
  load segments are 0x4000-aligned.

---

## 6. Primary sources

- [nodejs-mobile/nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)
- [android_configure.py](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/android_configure.py)
- [common.gypi](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/common.gypi)
- [tools/android_build.sh](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/tools/android_build.sh)
- [tools/ios_framework_prepare.sh](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/tools/ios_framework_prepare.sh)
- [.github/workflows/build-mobile.yml](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/.github/workflows/build-mobile.yml)
- [nodejs-mobile releases](https://github.com/nodejs-mobile/nodejs-mobile/releases)
- [Node.js BUILDING.md](https://github.com/nodejs/node/blob/main/BUILDING.md) — upstream configure flags reference
