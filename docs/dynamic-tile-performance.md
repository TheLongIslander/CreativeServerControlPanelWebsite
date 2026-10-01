# Dynamic Tile performance investigation

Investigated and implemented September 30, 2026. The initial findings below describe the original renderer; the implementation section records the changes made afterward.

The reported issue is pointer movement over Dynamic tiles on a plugged-in MacBook Pro M5 Max, using its built-in ProMotion display and Safari 27.0 (22625.1.29.11.27). The user does not observe the problem on the Mac used for this investigation. The affected laptop's actual browser callback cadence, visible tile count, and rendering trace have not been captured. Being plugged in does not establish its power-mode setting.

## Implemented changes

- Safari uses [serverTileHalo.js](../public/serverTileHalo.js) for a cached colored halo and a Canvas2D foreground. The foreground combines retained sharp artwork with a small, animated soft mask. The SVG remains the loading/failure fallback and is hidden only when both canvases are ready. Chrome retains the existing full SVG renderer. Renderer selection checks Safari's UA/vendor and excludes Chromium and other named browsers.
- The static halo uses at most one pixel per CSS pixel, with a maximum 768px backing dimension and 40px overflow padding. Artwork is loaded with normal same-origin image credentials, decoded once per source while active, drawn at its existing cover/contain fit, embedded into a standalone SVG, and filtered once into the cached canvas. There is no live blur on the halo canvas.
- The foreground artwork cache uses device pixel ratio capped at 2 and a maximum 1536px backing dimension. It rebuilds only when its inputs change. Each scheduled contour update redraws a fixed 167×255 mask using Canvas2D shadow blur and an alpha adjustment, then composites the cached artwork with `destination-in`. This keeps the artwork sharp while limiting repeated feather work to a small mask; it does not require Canvas2D `filter` support. Controls and text panels remain in the DOM.
- Cache inputs include dimensions, artwork, initial, stable contour, and computed fallback colors/font. An 80ms debounce collapses initial sizing and resize bursts. Final tile-order reconciliation refreshes parity-dependent colors. Generation checks and aborts prevent obsolete images from replacing newer artwork or reviving removed tiles. Hidden/offscreen/Still/Classic states suspend pending work; reduced motion still permits the static halo. Failure preserves the existing SVG effect rather than leaving the artwork broken.
- The scheduler now preserves deadline phase with bounded pending credit, prioritizes interacting/settling tiles, reserves ambient capacity under overload, and shares each class fairly. It still paints at most one outline per callback. Pauses, offscreen transitions, and gaps above 100ms reset deadlines rather than accumulate work.

Three-tile simulations now reach **30/15/15 outline updates/sec** at both 60 and 120Hz, including ±0.6ms timestamp jitter. Four visible tiles with one active at 60Hz receive **30/10/10/10**, explicitly spending the remaining capacity on ambient motion. A 60Hz jittered stream can still produce individual ~50ms active gaps; the scheduler improves average pacing rather than guaranteeing every interval is exactly 33ms.

Repeated warmed-up measurements of the initial cached-halo implementation, before the later size and foreground changes, using the same local fixture as the original investigation:

| Browser | Before: mean callback interval | After: mean callback interval | After p95 |
| --- | --- | --- | --- |
| Chrome 154 | 16.67 / 16.67ms | 16.66 / 16.67ms | 17.2 / 17.3ms |
| Playwright WebKit 26.6 | 57.17 / 57.27ms | 17.87 / 18.34ms | 25 / 26ms |

All three WebKit tiles selected `cached-halo`; Chrome created no halo canvases. Neither browser reported JavaScript errors. These are callback timings on the current Mac, not presented-frame measurements or a native Safari 27/M5 Max guarantee. The soft halo keeps a stable contour while the feathered foreground edge continues to deform.

Initial cached-halo validation: the full `node --test` suite passed **529 tests**. The 13 cache tests were rerun after correcting normalized fallback-gradient coordinates. Real Chrome/WebKit fixture checks covered nonempty halo pixels, cover/contain artwork, fallback initials and parity changes, light/dark layouts, narrow responsive layout, Still mode, reduced motion, failed thumbnails, removed tiles, and diagnostic restoration. Screenshots were visually reviewed. This test count predates the enlarged tiles and canvas foreground. No production backend or server lifecycle operation was invoked.

The source-based scheduler diagnostic now exercises the updated implementation, so its output differs from the historical table below. The console probe's `no-glow` mode handles both SVG glow and cached canvas. Its `no-feather` mode temporarily displays the SVG foreground without feathering while retaining the cached halo. The probe reports the foreground renderer, canvas count and backing resolution; restoring a mode removes its temporary styles.

Final canvas-foreground validation: the full `node --test` suite passed **534 tests**. Isolated Chrome/WebKit browser checks passed at desktop widths 1440, 1300, 1200 and 1194px and mobile widths 320, 375 and 430px. They verified 80px column/64px row gaps, matching contour bounds and control geometry, no sideways scrolling, cover/contain artwork, fallback initials, mode switches and pointer animation. WebKit foreground canvases contained both opaque artwork and soft edge pixels, retained DPR 2 resolution (916×1240 backing pixels at 458×620 CSS pixels on desktop), and stayed within the 1536px cap. Probe checks confirmed three visible canvas auras, unchanged foreground bitmap pixels during `freeze-contour`, and complete restoration after `no-feather`, `no-glow` and disposal. Desktop and mobile screenshots were visually reviewed.

### Dynamic/Still size parity

The contour reserves a 46px inset on each side of its 334×510 drawing space, leaving a nominal 242×418 visible body. Dynamic artwork now expands by 334/242 horizontally and 510/418 vertically, centered behind the existing tile. The nominal contour edges therefore match the Still tile's footprint at every responsive size. The SVG, foreground canvas, cached halo and static fallback share those bounds. Controls and link hitboxes retain their size and geometry relative to each tile; pointer coordinates use the inverse transform, and fallback initials keep their original position within the tile. Dynamic rows use 80px horizontal and 64px vertical gaps, with the desktop main area widened to a maximum 1162px so the three enlarged tiles have room to breathe.

The additional artwork area changes image cropping slightly and lets the blur extend beyond the tile. Horizontal overflow is clipped at the viewport only in Dynamic overview mode, keeping vertical scrolling and the inter-tile glow. Geometry updates happen on resize; the halo backing-store cap and the one-contour-update-per-callback scheduler remain in place.

At the enlarged dimensions, retaining the live SVG feather regressed local WebKit callback intervals to roughly 68–70ms despite the cached halo. The small Canvas2D mask addresses this remaining size-sensitive filter cost. Final repeated measurements with the enlarged tiles and 80px horizontal gaps:

| Browser | Mean callback interval, two runs | p95 interval, two runs |
| --- | --- | --- |
| Chrome 154 | 17.56 / 16.67ms | 17.5 / 17.1ms |
| Playwright WebKit 26.6 | 16.67 / 16.67ms | 17 / 18ms |

Chrome's first run included one isolated 200ms callback gap; the second had none above 25ms. Neither WebKit run had a gap above 25ms. All three WebKit foregrounds used 916×1240 backing pixels, with 538×700 cached halos; Chrome retained SVG and created no canvases. Both engines reported no JavaScript errors. These remain local callback measurements, not native Safari 27/M5 Max presentation measurements. A CSS blur inside the SVG mask appeared fast because WebKit did not apply the intended blur there, producing hard edges, so it was rejected as an equivalent optimization.

## Findings

Two separate mechanisms deserve attention:

1. **The live SVG filter graph is the leading rendering bottleneck.** Each changing contour feeds a feathered mask, then a second, larger colored-glow filter. Local WebKit isolation experiments strongly implicate the outer glow. These experiments use Playwright WebKit, not the affected laptop's Safari build, so they identify a promising target rather than prove the laptop's exact execution path.
2. **The scheduler demonstrably under-delivers its intended interaction rate.** It is sensitive to callback frequency, floating-point boundaries, and timing jitter. This can magnify a Safari/Chrome difference on ProMotion even when neither browser has slow JavaScript.

### The expensive rendering dependency

In [serverTileAura.js](../public/serverTileAura.js), lines 161–196 build this dependency:

```text
80-segment contour; path d changes
  → feather: Gaussian blur σ11 + alpha adjustment
  → alpha mask applied to artwork
  → glow: Gaussian blur σ14 + saturation + alpha adjustment
  → merge glow with original masked artwork
  → transformed tile, with translucent controls over it
```

The `d` write at line 100 changes pixels in the input to both filters. Moving an otherwise static bitmap can often reuse its rendered content; changing this mask invalidates the filtered result. Moving/scaling/skewing that subtree can add further rendering work depending on the engine's layer and filter implementation. Source inspection cannot establish whether a particular pass runs on CPU or GPU.

The nominal feather surface is 334×510 CSS pixels; the glow region is 414×590, adjusted to actual tile size. At DPR 2 those nominal areas correspond to approximately 0.68 million and 0.98 million device pixels per surface, before engine-specific allocation, caching, and raster scaling. These are area estimates, not measured allocations.

Additional effects in [servers.css](../public/servers.css):

- Info panel: `backdrop-filter: blur(22px) saturate(140%)`, line 131.
- Power button: nested `backdrop-filter: blur(12px) saturate(150%)`, line 171, plus brightness/saturation and shadows.
- Whole visual: pointer-driven translation, skew, and scale, lines 267–271.
- Info panel: separate transform, highlight, and animated shadow, lines 281–295.

Backdrop filtering is a plausible multiplier, but removing it alone did **not** materially fix the local WebKit control. Do not prioritize a broad removal of glass styling ahead of the outer glow.

The full-tile radial highlight is disabled when the live aura is present (line 232); it is not an active full-tile paint cost in the normal Dynamic path. The special contained artwork uses `mix-blend-mode: lighten` (`serverTileAura.js:167`); test that separately only if the corresponding tile behaves worse.

### Local rendering isolation results

Measured on the current Mac (Mac13,1, 32 GiB RAM, macOS 27.0 build 26A428), using Chrome 154.0.8037.59 and Playwright 1.63.0's headed WebKit 26.6 build 2359. **Playwright WebKit is not Safari 27, and this is not the affected M5 Max.** Browser-specific compositing, flags, and presentation behavior may differ.

The fixture serves the real overview HTML/CSS/JavaScript with three mock servers and local artwork. Conditions: 1440×1000 viewport, DPR 2, three visible 334×510 tiles, deterministic contour seeds, decoded images, 2.2 seconds of pointer warmup followed by 3.6 seconds of measurement. An in-page synthetic mouse pointer traces an ellipse around the first tile once per callback; this exercises the JavaScript lighting/edge path but does not replicate all native mouse hit-testing or CSS `:hover` behavior. Both repeat orders were tested: full → no-glow → no-feather → no-backdrop, then reversed. Only one browser was running the fixture at a time.

| Mode | Chrome mean callback interval, two runs | WebKit mean callback interval, two runs | WebKit p95 interval |
| --- | --- | --- | --- |
| Full Dynamic | 16.67 / 16.67 ms | 57.17 / 57.27 ms | 76 / 76 ms |
| Remove only outer glow | 16.67 / 16.67 ms | 17.75 / 17.59 ms | 25 / 25 ms |
| Remove only feather blur | 16.67 / 16.66 ms | 27.81 / 28.17 ms | 38 / 38 ms |
| Remove info/button backdrop blur | 16.67 / 16.67 ms | 58.06 / 58.79 ms | 77 / 79 ms |

The outer-glow ablation shortened average WebKit callback intervals by about 69%. This is strong local evidence that the nested SVG filter dependency is expensive; it is not a predicted percentage improvement for the laptop or for a future cached-halo implementation. The synchronous application rAF callbacks had a p95 around 1 ms in WebKit, versus tens of milliseconds between callbacks. Deferred style, painting, compositing, and browser scheduling are outside that JavaScript callback measurement; no CPU/GPU attribution is claimed.

An initial short-warmup run had large Chrome outliers, so the table uses the repeated, image-decoded, pointer-warmed controls above. Native browser screenshots confirmed that both fixtures rendered the intended tiles; WebKit's glass-panel appearance differed, reinforcing that it is only a proxy. The temporary fixture runner and full local data are in `/tmp/dynamic-tile-investigation/bench.cjs`, `results.json`, and `initial-results.json`; the portable laptop probe below is the appropriate way to validate the user's actual environment.

### Confirmed scheduling problem

[serverTileAura.js](../public/serverTileAura.js), lines 81–102, targets 15 outline updates/s for ambient tiles and 30 for interacting or settling tiles, but:

- It selects only **one tile total per display callback**.
- Eligibility uses an exact `overdue >= 1` comparison.
- After a paint it sets `sincePaint = 0`, losing any elapsed remainder.

Run the source-based simulation:

```sh
node scripts/diagnostics/dynamic-tile-scheduler.cjs
```

This executes the production aura code in the existing mocked DOM harness. It measures ten synthetic seconds after two seconds of warmup, with one held edge. It does not render pixels or measure either browser.

For three visible tiles, one interacting:

| Simulated callback cadence | Interacting outline updates/s | Ambient outline updates/s, each |
| --- | ---: | ---: |
| Exact 60 Hz | 20.2 | 11.4 / 11.5 |
| 60 Hz, timestamp jitter ±0.6 ms | 22.5 | 11.8 / 11.7 |
| Exact 120 Hz | 26.7 | 13.3 / 13.3 |
| 120 Hz, timestamp jitter ±0.6 ms | 26.2 | 13.6 / 13.5 |
| Intended target | 30 | 15 / 15 |

Exact numbers depend on timestamp phase and rounding; the under-delivery and discarded remainder are the relevant findings. In the exact 60 Hz case, the active edge usually updates every 50 ms instead of the intended 33.3 ms. The hovering card transform follows a separate pointer loop and must not be confused with the outline rate.

The aggregate capacity also matters. One active tile plus two idle tiles requests 60 outline updates/s; one active plus three idle requests 75. A one-update-per-callback policy cannot fulfill 75 updates/s with 60 callbacks/s.

Experimental epsilon/remainder changes in a temporary copy demonstrate the source of lost cadence, but a one-line subtraction is not a complete fix: it can accumulate overdue work when demand exceeds capacity. Modulo-based dropping of debt can also reduce active-tile priority. Use an explicit scheduler design with overload behavior.

### Costs that are secondary or already addressed

[appearance.js](../public/appearance.js) already coalesces pointer events into one callback (lines 547–566) and batches parent/nested/control geometry reads before writes (527–542). The aura also coalesces input, pauses offscreen/hidden/reduced-motion work, and uses stationary hitboxes. Those are existing optimizations.

Remaining secondary candidates:

- Ten CSS custom-property writes per affected surface, plus a class write (443–453); up to three surfaces over a power control.
- A body-wide mutation observer receives those style changes and normalizes them to ignore its own updates (597–652).
- The aura reads all visible tile bounds on a dirty pointer sample (47–64).
- The independent aura and lighting callbacks can interleave one module's writes with the other module's geometry reads. A shared read/compute/write phase would help only if traces show expensive forced updates.

These pointer-lighting costs also occur in Still mode. Server polling runs every ten seconds and reuses tile nodes and artwork URLs; it is not the leading explanation for continuous pointer-only stutter.

## Recommended changes, in order

### 1. Keep the animated edge; decouple the colored halo

Prototype a Safari rendering profile that keeps the existing dynamic feathered foreground mask, while drawing the outer halo from a cached, stable contour. Rebuild the halo on artwork or size changes, and move it with transform/opacity. Ensure its source is independent of the changing path: placing the same live mask in a second SVG group does not break the invalidation dependency.

A pre-rendered low-resolution halo bitmap, or a separately cached static filtered layer, can remove the large colored blur chain from every contour update. A bitmap gives more explicit control over repeated filtering, while requiring cache invalidation for artwork, size, and relevant appearance changes. Verify that the static halo remains visually plausible around the deforming edge. If needed, refresh the halo at a much lower rate than the interactive foreground.

Retain Chrome's current full renderer while validating this profile on the affected laptop. Choose the alternate renderer once per session/profile; do not switch quality repeatedly during pointer movement. A CSS feature query for masks or `-webkit-backdrop-filter` is not a Safari performance detector.

If caching the halo is insufficient, evaluate a lower-resolution offscreen rendering surface, with sharp text and controls kept in DOM. A Canvas/WebGL rewrite is a larger second-stage option, not the first intervention. Reducing SVG `viewBox` dimensions alone does not guarantee a lower raster resolution.

### 2. Repair pacing with a bounded active-tile budget

Use phase-aware deadlines or retained fractional time, with tolerance for numerical boundaries. Give the interacting tile a reserved update budget and lower ambient activity when visible demand exceeds the measured callback/rendering budget. Skip obsolete updates after stalls or visibility changes; do not perform a burst of catch-up paints.

Preserve the current Chrome rendering quality and nominal rates initially. Increasing the global paint cap before reducing filter cost can make the slow case worse. Validate average outline rate **and** p95 update gaps at 60/120 Hz, with jitter, multiple interacting/settling tiles, and overloaded tile counts.

### 3. Apply small measured simplifications

Remove the nested button backdrop blur first if a laptop trace shows material cost: its opaque pigment background makes this a low-visibility candidate. Only reduce the info panel's blur or increase its opacity if the A/B test justifies the appearance change.

Cache unchanged lighting values, avoid redundant class writes, and reduce observer work if scripting/style time is significant. Preserve inherited custom-property behavior between the stationary tile and its visual child; blanket `inherits: false` registration would break it.

Treat `will-change: transform` or selective layer promotion as measured experiments. They cannot prevent filter invalidation when `d` changes and may increase memory use. `contain: paint` can clip the intentional aura overflow or popup. Neither is a blanket fix.

## Measuring on the affected MacBook

Paste [dynamic-tile-probe.js](../scripts/diagnostics/dynamic-tile-probe.js) into the overview page's DevTools console. It only changes that document temporarily; it does not send requests or save appearance preferences.

```js
DynamicTileProbe.setMode('full');
await DynamicTileProbe.measure({ durationMs: 10000 });
// Move the real pointer around the same tile during each measurement.
DynamicTileProbe.setMode('no-glow');
await DynamicTileProbe.measure({ durationMs: 10000 });
DynamicTileProbe.restore();
// When finished:
DynamicTileProbe.dispose();
```

Repeat full/no-glow/full three times, then compare `freeze-contour`, `no-feather`, `no-backdrop`, and `no-transform` independently. Let each mode settle before measuring. Keep viewport, zoom, visible tiles, artwork, and pointer path comparable. Keep the page foreground; discard runs interrupted by tab/window changes. Do not run screen recording while determining ProMotion cadence.

The probe reports callback intervals and per-tile `d` mutations. **Neither is a direct measurement of presented frames or GPU time.** Use Safari Web Inspector's Rendering Frames timeline and Chrome's Performance panel for paint/layout/compositing attribution; compare with profiling closed as well, since tooling adds overhead.

With Safari's canvas foreground, `no-feather` is a visual control, not a pure CPU-cost isolation: it shows the unfeathered SVG, but the hidden foreground canvas still updates its mask. `freeze-contour` prevents both path changes and corresponding foreground pixel updates.

Compare both browsers on ProMotion first. Then temporarily select the same fixed display refresh rate as an isolation experiment. If the difference shrinks at equal callback cadence, pacing contributes; if removing only the outer glow fixes Safari at either cadence, rendering dominates. A plugged-in high-end machine with no other apps can still hit a browser scheduling or filter-path limitation.

Success criteria: the active edge approaches the chosen rate without long gaps, pointer response meets the observed display callback budget (about 16.7 ms at 60 Hz or 8.3 ms at 120 Hz), no visible glow clipping/flicker, and Chrome's current frame timing and appearance do not regress. Check light/dark mode, responsive sizes, contained artwork, reduced motion, and hidden/offscreen suspension.

## Validation and limitations

During the initial investigation, the existing contour, aura, and pointer-lighting suites passed 55 tests; implementation validation is recorded above. These tests validate logic; their mocked DOM does not measure browser rasterization. The initial scheduler diagnostic reproduced all 24 baseline scenarios. The probe passed a JavaScript syntax check and a browser smoke check covering filter/style restoration, zero contour writes during freeze, resumed writes after restoration, measurement cancellation, and disposal. Native Safari automation on the current Mac was unavailable because Allow Remote Automation is disabled; no browser setting was changed. The affected M5 Max was not accessible for profiling.

## Primary references

- [WebKit: Announcing MotionMark 1.3](https://webkit.org/blog/14908/motionmark-1-3/) explains why browser callback frequency must be measured when comparing high-refresh displays. This does not establish a specific Safari 27 frame cap.
- [WebKit: Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/) explains the additional rendering passes involved in backdrop filtering.
- [WebKit contributors: Layer Based SVG Engine update](https://wpewebkit.org/blog/status-of-lbse-in-webkit.html) describes SVG resource invalidation, mask buffers, and filter work. It provides architectural context, not proof of the current Safari 27 CPU/GPU path.
