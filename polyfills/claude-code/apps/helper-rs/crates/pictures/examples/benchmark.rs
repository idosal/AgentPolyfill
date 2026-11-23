//! Run with `cargo run --release -p mcp-apps-pictures --example benchmark`.
use std::{hint::black_box, time::Instant};

use mcp_apps_pictures::{EncoderOptions, StripJob, StripState, decode_png, encode_strips};

fn measure(mut f: impl FnMut(), warmup: usize, iterations: usize) -> serde_json::Value {
    for _ in 0..warmup { f(); }
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let start = Instant::now();
        f();
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    let median = if iterations.is_multiple_of(2) {
        (samples[iterations / 2 - 1] + samples[iterations / 2]) / 2.0
    } else { samples[iterations / 2] };
    serde_json::json!({ "medianMs": median, "minMs": samples[0], "maxMs": samples[iterations - 1], "samplesMs": samples })
}

fn main() {
    let iterations = std::env::args().nth(1).map(|n| n.parse::<usize>().unwrap()).unwrap_or(20);
    assert!(iterations > 0);
    let warmup = 5;
    let png = include_bytes!("../tests/fixtures/benchmark.png");
    let job = StripJob { png, rows: 48, top: 0, all: false, stamp: 1, version: 1 };
    let state = || StripState::new(EncoderOptions::default());
    let decode = measure(|| { black_box(decode_png(black_box(png)).unwrap()); }, warmup, iterations);
    let fresh = measure(|| { black_box(encode_strips(&mut state(), black_box(job)).unwrap()); }, warmup, iterations);
    let mut cached = state();
    let first = encode_strips(&mut cached, job).unwrap();
    let mut version = 1;
    let unchanged = measure(|| {
        version += 1;
        black_box(encode_strips(&mut cached, StripJob { version, stamp: version, ..job }).unwrap());
    }, warmup, iterations);
    let mut stamp = version;
    let restamp = measure(|| {
        stamp += 1;
        black_box(encode_strips(&mut cached, StripJob { png: b"unused", version, stamp, all: true, ..job }).unwrap());
    }, warmup, iterations);
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "runtime": "Rust release", "width": 2192, "height": 1152, "rows": 48,
        "palette": true, "warmup": warmup, "iterations": iterations,
        "pngBytes": png.len(), "stripCount": first.strip_count,
        "base64Bytes": first.strips.iter().map(|s| s.png.len()).sum::<usize>(),
        "decode": decode, "fresh": fresh, "unchanged": unchanged, "restamp": restamp,
    })).unwrap());
}
