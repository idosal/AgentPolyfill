# mcp-apps-pictures

Rust port of `mod/helper/png.mjs`, `quantize.mjs` and `strips.mjs`. This crate
contains the encoders only; the caller owns view lifetimes and worker scheduling.
No changes to the helper, render crate, workspace manifest or lockfile are needed.

## API

```rust
use mcp_apps_pictures::{
    decode_png, quantize, crc32, encode_strips,
    EncoderOptions, StripJob, StripState,
};

fn encode(png: &[u8]) -> mcp_apps_pictures::Result<()> {
    let image = decode_png(png)?; // Image { width, height, data: Vec<u8> (RGBA) }
    let quantized = quantize(&image.data, image.width, 0, image.height, None)?;
    // None limit = unlimited; Ok(None) = max_colours exceeded.
    // Quantized { palette: Vec<[u8; 3]>, indices: Vec<u8>, psnr: f64, colours }.
    let _checksum = crc32(png);

    // Keep this state across calls, one per view. Drop it when the view closes.
    let mut state = StripState::new(EncoderOptions::from_env());
    let result = encode_strips(&mut state, StripJob {
        png, rows: 48, top: 0, all: false, stamp: 1, version: 1,
    })?;
    // result.strips: [{ i, rows, png: String (standard padded base64) }]
    // result.strip_count; serde serializes this as "stripCount", like JS.
    assert!(quantized.is_some());
    assert_eq!(result.strip_count, 8);
    Ok(())
}
```

`EncoderOptions::default()` enables palettes explicitly. `from_env()` disables
them only for `MCP_APPS_CLI_PALETTE=0`. `StripState::default()` snapshots that
environment setting once at first use, matching the JavaScript module's fixed
process policy. Use explicit options for independent configurations in one process.
Options remain fixed while a state retains cached encodings.

`MCP_APPS_CLI_STRIPS=0` is a dispatch decision in the helper: send a whole image
instead of calling this encoder. It does not alter `encode_strips`, just as in JS.

## Behavior and parity

- PNG decoding: eight-bit, non-interlaced grayscale, grayscale-alpha, RGB and
  RGBA; all five filters; multiple IDAT chunks. Grayscale/RGB `tRNS` is ignored,
  as in the original decoder. Indexed, 16-bit and interlaced input screenshots
  are outside that decoder's supported formats. Strip output can be indexed;
  tests use a separate general PNG decoder to inspect it.
- Quantization: first-occurrence color order, stable sorting, weighted box
  selection, the original median cut boundary, rounded means, perceptual
  nearest-color weights `3:4:2`, first-match ties, distinct-color limits and
  RGB PSNR. Exact results have positive-infinite PSNR. Alpha is ignored.
- Strips: six terminal rows per band, rounded pixel boundaries, partial final
  bands, byte comparison of RGBA input, and layout invalidation on
  `width × height / rows / top`. Zero terminal rows produce zero strips.
  `all` on a new version recompresses every band. Same version and band count
  skip decoding and layout comparison: `all` only rewraps cached compressed
  bytes with the current stamp; otherwise the result has no strips.
- Palettes: at most 16,384 distinct colors and at least 42 dB; otherwise RGBA.
  Palette mode intentionally discards alpha, including fully transparent
  colors. Full-color mode retains it. Alpha-only changes still invalidate a
  band's cached source pixels.
- PNG wrapping: identical IHDR, optional PLTE, `tEXt` containing
  `mcp-apps-cli\0<stamp>`, and IEND, in the same order with matching CRCs.
  All scanline filters are zero. Zlib compression uses level 6.

For supported inputs there are no observed output differences except compressed
IDAT bytes and their dependent length/CRC, which may differ between `flate2` and
Node's zlib. The decoded pixels, palette and other chunks match. Rust returns
structured errors for out-of-range RGBA requests, arithmetic overflow and
zero-height strips; `png` also rejects malformed files that the minimal JS
decoder may tolerate. Failed jobs leave the previous state intact. The helper's
integer `rows`/`top` and nonnegative `version`/`stamp` map to `usize`/`i64`/`u64`;
use JavaScript-safe integer values when comparing implementations.

## Verification

From `helper-rs/`, keep build artifacts inside this crate and prevent downloads
or lockfile edits:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="$PWD/crates/pictures/target"
cargo test --locked -p mcp-apps-pictures
cargo build --release --locked -p mcp-apps-pictures
```

All 14 Rust tests pass in debug and release builds. The test suite includes the
assertions from both JavaScript test files, a thread-owned per-view state/drop
test, and an allocation check that re-stamping
retains cached IDAT and pixel buffers. The checked-in oracle fixtures cover:

- 23 synthetic PNGs: flat UI with antialiasing, gradients, deterministic
  photo-like noise, 256/257-color boundaries, equal-range ties, skewed color
  weights, transparency, grayscale/RGB variants and every PNG filter.
- 16 quantizer cases: exact palette/indices/color count and PSNR within `1e-9`,
  including infinity, empty bands, subranges and early exits.
- 16 stateful strip sequences (78 steps, 124 emitted PNGs), both palette settings:
  changes in selected bands, unchanged captures, `all`, stamp changes, layout and band-count
  changes, half-pixel rounding, independent views, dropping a view, zero rows,
  invalid PNG errors and recovery. Each PNG is compared by chunk order,
  exact non-IDAT bytes, decompressed scanlines, palette, indices and RGBA.
- The actual 2192×1152 Chrome screenshot used for the benchmark, checked
  against Node's decoded RGBA checksum and all eight encoded bands.
- CRC-32 reference vectors and invalid-input/cache recovery assertions.

Regenerate the oracle fixtures without Rust or external packages:

```sh
node crates/pictures/tests/make-fixtures.mjs
```

The generator imports the original JS, explicitly loads both palette policies,
and records source SHA-256 hashes in `tests/fixtures/manifest.json`. Binary PNG,
RGBA and index fixtures avoid JSON expansion. Infinity is represented by the
string `"Infinity"`. Fixture generation is deterministic and leaves the
checked-in Chrome screenshot unchanged. To refresh that screenshot separately:

```sh
node crates/pictures/tests/capture-benchmark.mjs
node crates/pictures/tests/make-fixtures.mjs
```

Capture uses the helper's installed `playwright-core` and installed Chrome on an
offline local dashboard. No URLs or external assets are loaded. Browser temp
files are confined to this crate's ignored `target/` directory. Chrome/font
versions can change the screenshot; its metadata and hash are saved beside it.

## Timings

Measured on one machine, with Rust 1.100.0 release with the workspace
optimization profile, and Node 22.23.1. Both runners used the
same **2192×1152 Chrome screenshot**, 149,292 PNG bytes, 48 terminal rows
(eight bands), palette enabled. The screenshot contains flat cards, antialiased
text, gradient bars and a table; it is a local benchmark page, not a production
app. Chrome 157.0.8103.79, device scale factor 1.

Each operation has five warmups and 30 timed iterations. Results below are
medians; raw samples and min/max are in `benchmarks/rust.json` and
`benchmarks/node.json`. Runners were executed sequentially. File reading,
browser startup/capture and process startup are excluded.

| Operation | Rust release | Node | Node / Rust |
| --- | ---: | ---: | ---: |
| Decode PNG to RGBA | 8.46 ms | 40.63 ms | 4.80× |
| Fresh decode + encode all eight strips + base64 | 40.04 ms | 85.24 ms | 2.13× |
| New version, unchanged pixels (decode + compare) | 8.67 ms | 39.09 ms | 4.51× |
| Same version, re-stamp all cached strips + base64 | 0.239 ms | 0.520 ms | 2.17× |

Fresh encoding includes decoding; it is not an encode-only measurement. These
are local microbenchmarks of one screenshot, not a promise about end-to-end
terminal latency or photo workloads. Base64 output totals were 107,744 bytes
for Rust and 108,620 for Node because compression differs.

Reproduce from `helper-rs/` with the environment settings above:

```sh
cargo build --release --locked -p mcp-apps-pictures --example benchmark
crates/pictures/target/release/examples/benchmark 30
node crates/pictures/tests/benchmark.mjs 30
```
