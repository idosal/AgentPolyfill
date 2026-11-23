//! Cells only: a screenshot's long horizontal edges moved onto the cell grid
//! before the renderer fits it (mod/helper/snap.mjs is the same for Node's
//! helper). A table or heatmap whose row height isn't a whole number of cells
//! otherwise drifts against them: rows of partial blocks where an edge falls
//! mid-cell, and a label a line off from its row. Each long edge moves to the
//! nearest cell boundary, at most half a cell, and the rows between stretch
//! or shrink to fit; a gap thinner than a third of a cell closes, so the
//! colour change itself lands on the boundary. Edges inside a line of text
//! or a photo stay where they are. Text and photo positions move with it.
//! Only for a picture whose long edges include a run of rows at one height
//! (a table, a heatmap: what drifts against the cells): elsewhere (a clock's
//! button, a dashboard's panels) moving an edge gains little and moves its
//! content a row. Line grouping (lines.rs) keeps a row's texts together
//! after it, and a click is mapped back through both (input.rs).
//! `MCP_APPS_CLI_SNAP=0` turns it off; `=all` snaps every picture.

use mcp_apps_render::{Image, Photo, TextLine};

/// A pixel boundary counts as an edge where this share of the columns
/// changes colour across it, by more than EDGE_STEP (|dr|+|dg|+|db|).
const EDGE_SHARE: f64 = 0.3;
const EDGE_STEP: i32 = 48;

pub fn on() -> bool {
    std::env::var("MCP_APPS_CLI_SNAP").map_or(true, |v| v != "0")
}

/// Every picture snapped, rows at one height or not (`MCP_APPS_CLI_SNAP=all`).
fn every_picture() -> bool {
    std::env::var("MCP_APPS_CLI_SNAP").is_ok_and(|v| v == "all")
}

/// The fewest rows at one height in a run that makes a picture a table.
const TABLE_ROWS: usize = 4;

/// Whether the edges include a run of TABLE_ROWS rows at one height (within
/// 1.5 px), each at least a cell high: a thin gap's two edges count as one.
fn rows_at_one_height(edges: &[usize], cell: f64) -> bool {
    let mut marks: Vec<f64> = Vec::new();
    let mut i = 0;
    while i < edges.len() {
        let b = edges[i] as f64;
        match edges.get(i + 1) {
            Some(&n) if n as f64 - b <= cell / 3.0 => { marks.push((b + n as f64) / 2.0); i += 2; }
            _ => { marks.push(b); i += 1; }
        }
    }
    let (mut run, mut best, mut pitch) = (0usize, 0usize, 0.0f64);
    for w in marks.windows(2) {
        let gap = w[1] - w[0];
        if gap < cell * 0.9 { run = 0; continue; }
        if run > 0 && (gap - pitch).abs() <= 1.5 { run += 1; } else { run = 1; pitch = gap; }
        best = best.max(run);
    }
    best + 1 >= TABLE_ROWS
}

/// Source and target rows, increasing: rows between two anchors map linearly.
#[derive(Clone, Debug, Default)]
pub struct Snap { anchors: Vec<(f64, f64)> }

impl Snap {
    /// Where source row `y` lands.
    pub fn map(&self, y: f64) -> f64 {
        let a = &self.anchors;
        for w in a.windows(2) {
            let ((s0, t0), (s1, t1)) = (w[0], w[1]);
            if y <= s1 {
                return if s1 > s0 { t0 + (y.max(s0) - s0) * (t1 - t0) / (s1 - s0) } else { t0 };
            }
        }
        y
    }

    /// Where the picture's row `t` came from: `map` undone, so a click on
    /// what's drawn there goes where it is on the page.
    pub fn unmap(&self, t: f64) -> f64 {
        let a = &self.anchors;
        for w in a.windows(2) {
            let ((s0, t0), (s1, t1)) = (w[0], w[1]);
            if t <= t1 {
                return if t1 > t0 { s0 + (t.max(t0) - t0) * (s1 - s0) / (t1 - t0) } else { s0 };
            }
        }
        t
    }
}

/// The anchors for `image`, or None where nothing moves.
pub fn plan(image: &Image, cell_h: usize, texts: &[TextLine], photos: &[Photo]) -> Option<Snap> {
    let (w, h) = (image.width, image.height);
    if cell_h < 4 || w < 16 || h < cell_h * 2 || image.data.len() < w * h * 4 { return None; }
    let step = if w > 800 { 2 } else { 1 };
    let samples = w.div_ceil(step) as f64;
    // The share of columns that change colour across each boundary b (rows b-1 | b).
    let mut share = vec![0.0; h + 1];
    for b in 1..h {
        let (above, below) = (&image.data[(b - 1) * w * 4..b * w * 4], &image.data[b * w * 4..(b + 1) * w * 4]);
        let mut n = 0usize;
        for x in (0..w).step_by(step) {
            let i = x * 4;
            let d = (i32::from(above[i]) - i32::from(below[i])).abs() + (i32::from(above[i + 1]) - i32::from(below[i + 1])).abs()
                + (i32::from(above[i + 2]) - i32::from(below[i + 2])).abs();
            if d > EDGE_STEP { n += 1; }
        }
        share[b] = n as f64 / samples;
    }
    // Not inside a line of text, nor a photo as wide as a third of the view.
    let inside = |b: f64| {
        texts.iter().any(|t| matches!((t.top, t.bottom), (Some(top), Some(bottom)) if b > top + 1.0 && b < bottom - 1.0))
            || photos.iter().any(|p| p.w >= w as f64 / 3.0 && b > p.y && b < p.y + p.h)
    };
    let mut edges: Vec<usize> = (1..h)
        .filter(|&b| share[b] >= EDGE_SHARE && share[b] >= share[b - 1] && share[b] > share[b + 1] && !inside(b as f64))
        .collect();
    if edges.is_empty() { return None; }
    edges.sort_unstable();
    let cell = cell_h as f64;
    if !every_picture() && !rows_at_one_height(&edges, cell) { return None; }
    let snap_to = |y: f64| (y / cell).round() * cell;
    let mut anchors: Vec<(f64, f64)> = vec![(0.0, 0.0)];
    let mut i = 0;
    while i < edges.len() {
        let b = edges[i] as f64;
        // A thin gap: both its edges to one boundary, so it closes.
        if let Some(&next) = edges.get(i + 1) {
            let n = next as f64;
            if n - b <= cell / 3.0 {
                let t = snap_to((b + n) / 2.0);
                push(&mut anchors, b, t, cell, true);
                push(&mut anchors, n, t, cell, true);
                i += 2;
                continue;
            }
        }
        push(&mut anchors, b, snap_to(b), cell, false);
        i += 1;
    }
    let end = h as f64;
    while anchors.last().is_some_and(|&(s, t)| s >= end || t > end) { anchors.pop(); }
    anchors.push((end, end));
    if anchors.iter().all(|&(s, t)| (s - t).abs() < 0.5) { return None; }
    Some(Snap { anchors })
}

/// Adds an anchor if it keeps the map increasing and no segment stretches
/// past twice (or shrinks under half) its height; a thin gap's may close.
fn push(anchors: &mut Vec<(f64, f64)>, s: f64, t: f64, cell: f64, closing: bool) {
    if (s - t).abs() > cell / 2.0 + 0.5 { return; }
    let &(ls, lt) = anchors.last().unwrap();
    if s <= ls { return; }
    if t < lt || (t == lt && !closing) { return; }
    let ratio = (t - lt) / (s - ls);
    if !closing && !(0.5..=2.0).contains(&ratio) { return; }
    anchors.push((s, t));
}

/// The picture remapped (nearest row: no blended colours), its texts and photos moved with it.
pub fn apply(snap: &Snap, image: &mut Image, texts: &mut [TextLine], photos: &mut [Photo]) {
    let (w, h) = (image.width, image.height);
    let row = w * 4;
    let mut out = vec![0u8; image.data.len()];
    let a = &snap.anchors;
    let mut k = 0;
    for y in 0..h {
        let centre = y as f64 + 0.5;
        while k + 2 < a.len() && centre >= a[k + 1].1 { k += 1; }
        let ((s0, t0), (s1, t1)) = (a[k], a[k + 1]);
        let source = if t1 > t0 { s0 + (centre - t0) * (s1 - s0) / (t1 - t0) } else { s0 };
        let sy = (source.floor() as isize).clamp(0, h as isize - 1) as usize;
        out[y * row..(y + 1) * row].copy_from_slice(&image.data[sy * row..(sy + 1) * row]);
    }
    image.data = out;
    for t in texts.iter_mut() {
        t.cy = snap.map(t.cy);
        t.top = t.top.map(|v| snap.map(v));
        t.bottom = t.bottom.map(|v| snap.map(v));
    }
    for p in photos.iter_mut() {
        let (top, bottom) = (snap.map(p.y), snap.map(p.y + p.h));
        p.y = top;
        p.h = (bottom - top).max(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bands of colour `pitch` pixels tall with a 2 px white gap under each.
    fn bands(w: usize, h: usize, pitch: usize) -> Image {
        let mut data = vec![255u8; w * h * 4];
        for y in 0..h {
            let in_gap = y % pitch >= pitch - 2;
            let shade = if in_gap { 255 } else if (y / pitch) % 2 == 0 { 40 } else { 120 };
            for x in 0..w { let i = (y * w + x) * 4; data[i] = shade; data[i + 1] = shade; data[i + 2] = 200; }
        }
        Image { width: w, height: h, data }
    }

    /// How many cells have more than one colour in them.
    fn mixed_cells(image: &Image, cell_h: usize) -> usize {
        let w = image.width;
        (0..image.height / cell_h)
            .filter(|r| {
                let first = &image.data[r * cell_h * w * 4..r * cell_h * w * 4 + 3];
                (0..cell_h).any(|dy| &image.data[(r * cell_h + dy) * w * 4..(r * cell_h + dy) * w * 4 + 3] != first)
            })
            .count()
    }

    #[test]
    fn rows_of_a_heatmap_land_on_cells() {
        let (w, cell) = (200, 16);
        let mut image = bands(w, cell * 20, 37);
        let before = mixed_cells(&image, cell);
        let snap = plan(&image, cell, &[], &[]).expect("edges to move");
        apply(&snap, &mut image, &mut [], &mut []);
        let after = mixed_cells(&image, cell);
        assert!(after * 4 <= before, "mixed cells {before} -> {after}");
    }

    #[test]
    fn text_moves_with_its_row_and_its_inside_is_left_alone() {
        let cell = 16;
        let image = bands(200, cell * 10, 37);
        let snap = plan(&image, cell, &[], &[]).unwrap();
        // A label in the middle of the second band stays in that band.
        let mid = 37.0 + 17.5;
        let moved = snap.map(mid);
        assert!(moved > snap.map(37.0) && moved < snap.map(72.0));
    }

    #[test]
    fn a_plain_picture_is_not_touched() {
        let image = Image { width: 100, height: 64, data: vec![200; 100 * 64 * 4] };
        assert!(plan(&image, 16, &[], &[]).is_none());
    }

    #[test]
    fn anchors_never_go_backwards() {
        // Noise: every boundary an edge.
        let (w, h) = (64, 160);
        let data = (0..w * h * 4).map(|i| if (i / (w * 4)) % 2 == 0 { 0 } else { 255 }).collect();
        let image = Image { width: w, height: h, data };
        if let Some(snap) = plan(&image, 16, &[], &[]) {
            for pair in snap.anchors.windows(2) { assert!(pair[1].0 > pair[0].0 && pair[1].1 >= pair[0].1); }
        }
    }

    #[test]
    fn a_click_maps_back_through_the_snap() {
        let snap = Snap { anchors: vec![(0.0, 0.0), (37.0, 32.0), (85.0, 80.0), (400.0, 400.0)] };
        for y in [0.0, 10.5, 37.0, 50.0, 85.0, 200.0, 399.0] {
            assert!((snap.unmap(snap.map(y)) - y).abs() < 1e-9, "{y}");
        }
        // A row drawn at 40 came from 45 on the page.
        assert!((snap.unmap(40.0) - 45.0).abs() < 1e-9);
    }

    #[test]
    fn only_a_picture_with_rows_at_one_height_is_snapped() {
        let cell = 16;
        // A heatmap's rows, 37 px each: snapped.
        assert!(rows_at_one_height(&[37, 74, 111, 148, 185], cell as f64));
        // Two panels and a button: not.
        assert!(!rows_at_one_height(&[20, 61, 130, 300], cell as f64));
        let mut image = Image { width: 200, height: 160, data: vec![255; 200 * 160 * 4] };
        for y in 45..160 { for x in 0..200 { let p = (y * 200 + x) * 4; image.data[p..p + 3].copy_from_slice(&[40, 40, 40]); } }
        assert!(plan(&image, cell, &[], &[]).is_none(), "one edge, no rows: left alone");
    }
}
