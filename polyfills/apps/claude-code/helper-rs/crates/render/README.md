# mcp-apps-render

A Rust port of `mod/helper/render.mjs`. The cell-fitting algorithm, ordered
post-processing passes, palette learning, temporal state, and pair admission
rules are preserved. There are no intentional rendering deviations.

## API

```rust
use mcp_apps_render::{compose_frame, Image, Memory, Options, Painter, Session};

let image = Image {
    width: 8,
    height: 16,
    data: vec![255; 8 * 16 * 4], // unpremultiplied RGBA; alpha is ignored
};
let options = Options {
    cols: 1,
    rows: 1,
    lines: true,
    now: Some(0.0), // milliseconds; omit to use wall time, as in JS
    ..Options::default()
};
let mut session = Session::default(); // one per helper, shared across views
let mut memory = Memory::default();   // one per view; reset on scrolling
let mut painter = Painter::default(); // one per view, kept across scrolling
let frame = compose_frame(
    &image, &[], &options, Some(&mut memory), Some(&mut painter), &mut session,
);
assert_eq!((frame.cols, frame.rows), (1, 1));
```

`TextLine`, `Photo`, and `Options` implement serde deserialization using the
page's field names, including `cy`, `t`, `maxX`, `canvas2d`, `cellWidth`,
`cellHeight`, `pageBackground`, and `halfBlocks`. Unknown page fields are ignored.
Use serde_json's `float_roundtrip` feature when decoding JSON to preserve exact
floating-point inputs; the fixture reader enables it.

`Frame.cells` always contains the JavaScript-compatible base64 string of
little-endian u32 triples `[code point, fg, bg]`. Default colour is `0x01000000`.
When `options.lines` is true, `Frame.lines` additionally contains rows of tuples
`[text, fg, bg, flags]`, with `#rrggbb` colours or the empty string for default.
Flags are bold=1, inverse=2, dim=4. The helper can forward `lines` as `styled`.

`canvas_is_photo(&Image, &Photo, Option<&mut Painter>)` implements the same
canvas density classification and hysteresis. `parse_css_color(Option<&str>)`
returns `CssColor { rgb, alpha }` with the same accepted forms and fallback.

A session is explicit rather than a process global so multiple callers and
tests can keep independent sessions. Share the same `Session` between views to
reproduce the JavaScript helper's shared token bucket. Omitting memory/painter
reproduces omission of those objects in JS. Images must contain nonzero
width/height and at least `width * height * 4` bytes; cell sizes are positive
integers (the helper normally uses 8×16, or 16×32 at 2×).

Implementation: `fit.rs` contains glyph candidates, free-colour fits, UI masks,
and Braille; `palette.rs` contains Oklab and photo palettes; `lib.rs` composes
frames, places text, maintains state, and encodes output; `color.rs` contains
colour and character handling. Float32 stores, JavaScript rounding and integer
wrapping, first-insertion tie breaks, stable sorts, and little-endian encoding
are explicit. The Unicode mark/format table matches Node 22.23.1 / Unicode 17.

## Exact parity

The fixtures aren't checked in (18 MB). `make-fixtures.mjs` makes them from
`render.mjs`'s own tests, byte-identical each run, and the parity test says
so if they're missing. From `helper-rs/` (no network needed):

```sh
export PATH="$HOME/.cargo/bin:$PATH"
node crates/render/tests/make-fixtures.mjs
cargo test --offline --locked -p mcp-apps-render
cargo test --offline --locked --release -p mcp-apps-render
cargo build --offline --locked --release -p mcp-apps-render
```

The fixture generator imports the original JS renderer and both test helpers.
It executes the original `render`, `sextants`, `truecolor`, and `palette` test
bodies with a recording wrapper, retaining every call's input, exact output,
call order, and memory/painter object identity. Each test file gets a fresh JS
module/session; missing timestamps are supplied deterministically. Existing JS
assertions also run. No changes are made to the JavaScript source or tests.

The Rust integration tests replay **320 frames**, comparing the entire base64
raster and every styled run exactly, without tolerances, plus CSS colour and
canvas classification results. The fixture set is below 20 MB; lossless PNGs
are deduplicated by image contents. Coverage includes:

- UI lines, edge snapping, tile gaps, stacked colours, gradients, Braille,
  isolated-dot suppression, rounded bar ends, ink removal, overlapping text,
  legend collisions, row placement, clipping, caret, bold/dim/inverse and Unicode.
- Sextants on/off, all 64 masks at even and odd cell heights, truecolor on/off,
  styled runs on/off, half-blocks on/off, odd sizes and clipped image edges.
- UI noise and drift, glyph hysteresis, resize/background memory invalidation,
  dense/sparse canvas transitions and moving tooltips, photo palettes, and
  truecolor animation with persistent state.
- The original 120-frame palette sequence and 40-frame sextant sequence,
  including the original painter model's no-starvation assertions; multiple
  views sharing an exhausted token bucket, palette updates and ordered eviction.
- Deterministic mixed-pattern cases and the 100×30-cell benchmark scene.

The generated Unicode table can be refreshed separately with
`node crates/render/tests/make-fixtures.mjs --unicode`.

## Time per frame

Measured 2026-11-18 on an Apple M1 Max (arm64), Rust 1.100.0 release and Node
22.23.1. The input is a deterministic ray-traced 3D scene of shaded spheres over
a checker plane: **100×30 cells, 1600×960 RGBA pixels, 16×32 pixels/cell (2×)**.
Both implementations use the same PNG, options, timestamps, and persistent
state. Both emit raster **and** styled runs. PNG decoding, scene generation,
process startup and file I/O are excluded.

Each mode has one cold frame, 20 warm-up frames and 200 measured frames. The
same scene is repeated; palette relearning still runs every tenth frame. These
numbers measure renderer computation, not Chrome screenshot capture or an
end-to-end animated app.

| Mode | Rust mean | Node mean | Rust median / p95 | Node median / p95 | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Palette, sextants off | 7.15 ms | 15.78 ms | 7.04 / 7.82 ms | 15.62 / 16.88 ms | 2.21× |
| Palette, sextants on | 8.11 ms | 19.12 ms | 8.02 / 8.75 ms | 18.91 / 20.46 ms | 2.36× |
| Truecolor, sextants off | 8.39 ms | 18.63 ms | 8.37 / 8.56 ms | 18.61 / 19.36 ms | 2.22× |
| Truecolor, sextants on | 8.42 ms | 18.61 ms | 8.39 / 8.59 ms | 18.57 / 19.29 ms | 2.21× |

As in JS, sextants only affect palette photo fits; truecolor uses the original
block candidates regardless of this flag. First-frame times in the same order:
Rust 17.80 / 17.13 / 8.85 / 8.54 ms; Node 115.87 / 127.08 / 28.99 / 29.13 ms.

Reproduce sequentially to avoid CPU competition:

```sh
cargo run --offline --locked --release -p mcp-apps-render --example benchmark
node crates/render/tests/benchmark.mjs
```

Raw observations are in `tests/benchmark-rust.jsonl` and
`tests/benchmark-node.jsonl`. No dependencies were added; serde_json is a
dev-dependency, alongside png. The library uses only serde and base64.
