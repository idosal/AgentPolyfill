use std::collections::HashMap;

use crate::{Result, rgba_range};

/// Palette and nearest-color mapping for a band. Alpha is intentionally ignored.
#[derive(Clone, Debug, PartialEq)]
pub struct Quantized {
    pub palette: Vec<[u8; 3]>,
    pub indices: Vec<u8>,
    /// Unweighted RGB peak signal-to-noise ratio, or infinity for an exact result.
    pub psnr: f64,
    /// Number of distinct input RGB colors (before quantization).
    pub colours: usize,
}

/// Quantize `height` rows beginning at `y0`, with JavaScript-identical ordering,
/// weighted median cuts and nearest-color tie breaks.
///
/// `None` for `max_colours` means no limit. `Ok(None)` means the band exceeded
/// that limit; the caller can fall back to full color without running median cut.
pub fn quantize(
    rgba: &[u8], width: usize, y0: usize, height: usize, max_colours: Option<usize>,
) -> Result<Option<Quantized>> {
    let band = &rgba[rgba_range(rgba, width, y0, height)?];
    let pixels = band.len() / 4;
    let mut ids = Vec::with_capacity(pixels);
    let mut seen = HashMap::new();
    let mut keys = Vec::new();
    let mut counts = Vec::new();
    for p in band.chunks_exact(4) {
        let key = (u32::from(p[0]) << 16) | (u32::from(p[1]) << 8) | u32::from(p[2]);
        let id = if let Some(&id) = seen.get(&key) {
            id
        } else {
            if max_colours.is_some_and(|max| keys.len() >= max) { return Ok(None); }
            let id = keys.len();
            seen.insert(key, id);
            keys.push(key);
            counts.push(0usize);
            id
        };
        counts[id] += 1;
        ids.push(id);
    }
    let colours = keys.len();
    let mut to_palette = vec![0u8; colours];
    let palette = if colours <= 256 {
        for (c, index) in to_palette.iter_mut().enumerate() { *index = c as u8; }
        keys.iter().map(|&k| rgb(k)).collect::<Vec<_>>()
    } else {
        let palette = median_cut(&keys, &counts);
        for (c, &key) in keys.iter().enumerate() {
            let [r, g, b] = rgb(key).map(i32::from);
            let mut best = 0;
            let mut best_d = i32::MAX;
            for (q, e) in palette.iter().enumerate() {
                let dr = r - i32::from(e[0]);
                let dg = g - i32::from(e[1]);
                let db = b - i32::from(e[2]);
                let d = 3 * dr * dr + 4 * dg * dg + 2 * db * db;
                if d < best_d { best_d = d; best = q; }
            }
            to_palette[c] = best as u8;
        }
        palette
    };
    let indices = ids.iter().map(|&id| to_palette[id]).collect();
    let mut error = 0.0;
    if colours > 256 {
        for (c, &key) in keys.iter().enumerate() {
            let p = rgb(key);
            let e = palette[to_palette[c] as usize];
            let dr = f64::from(p[0]) - f64::from(e[0]);
            let dg = f64::from(p[1]) - f64::from(e[1]);
            let db = f64::from(p[2]) - f64::from(e[2]);
            let n = counts[c] as f64;
            error += n * (dr * dr) + n * (dg * dg) + n * (db * db);
        }
    }
    let psnr = if error == 0.0 { f64::INFINITY }
        else { 10.0 * ((255.0 * 255.0 * pixels as f64 * 3.0) / error).log10() };
    Ok(Some(Quantized { palette, indices, psnr, colours }))
}

fn rgb(key: u32) -> [u8; 3] { [(key >> 16) as u8, (key >> 8) as u8, key as u8] }

struct ColorBox {
    members: Vec<usize>,
    n: usize,
    axis: usize,
    score: f64,
}

impl ColorBox {
    fn new(members: Vec<usize>, keys: &[u32], counts: &[usize]) -> Self {
        let mut n = 0;
        let mut lo = [255; 3];
        let mut hi = [0; 3];
        for &m in &members {
            n += counts[m];
            for (c, v) in rgb(keys[m]).into_iter().enumerate() {
                lo[c] = lo[c].min(v);
                hi[c] = hi[c].max(v);
            }
        }
        let mut axis = 0;
        for c in 1..3 { if hi[c] - lo[c] > hi[axis] - lo[axis] { axis = c; } }
        let score = if members.len() > 1 { f64::from(hi[axis] - lo[axis]) * (n as f64).sqrt() } else { 0.0 };
        Self { members, n, axis, score }
    }
}

fn median_cut(keys: &[u32], counts: &[usize]) -> Vec<[u8; 3]> {
    let mut boxes = vec![ColorBox::new((0..keys.len()).collect(), keys, counts)];
    while boxes.len() < 256 {
        let mut at = 0;
        for i in 1..boxes.len() { if boxes[i].score > boxes[at].score { at = i; } }
        if boxes[at].score == 0.0 { break; }
        let mut chosen = boxes.remove(at);
        // JS Array.sort is stable. Equal-channel colors retain their encounter order.
        chosen.members.sort_by_key(|&m| rgb(keys[m])[chosen.axis]);
        let mut acc = 0;
        let mut cut = 1;
        for (i, &m) in chosen.members.iter().enumerate() {
            acc += counts[m];
            if acc as f64 >= chosen.n as f64 / 2.0 {
                // Deliberately i, not i + 1: this is the JavaScript split rule.
                cut = i.max(1).min(chosen.members.len() - 1);
                break;
            }
        }
        let right = chosen.members.split_off(cut);
        boxes.insert(at, ColorBox::new(chosen.members, keys, counts));
        boxes.insert(at + 1, ColorBox::new(right, keys, counts));
    }
    boxes.into_iter().map(|b| {
        let mut sums = [0.0; 3];
        for m in b.members {
            for (c, v) in rgb(keys[m]).into_iter().enumerate() {
                sums[c] += f64::from(v) * counts[m] as f64;
            }
        }
        sums.map(|sum| (sum / b.n as f64).round() as u8)
    }).collect()
}
