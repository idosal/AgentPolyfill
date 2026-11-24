//! Pixel and page-text to terminal cells, ported from `mod/helper/render.mjs`.
//!
//! Keep [`Memory`] and [`Painter`] per view, and a [`Session`] per helper.
//! See the crate README for the wire format, parity tests, and benchmark.

mod color;
mod fit;
mod palette;
mod unicode_marks;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use color::*;
use fit::*;
use palette::*;

/// An unpremultiplied RGBA screenshot. Alpha is ignored, as in JavaScript.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// A laid-out line from the page script (coordinates are page pixels).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub x: f64,
    pub cy: f64,
    pub t: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub dim: bool,
    pub top: Option<f64>,
    pub bottom: Option<f64>,
    pub right: Option<f64>,
    pub max_x: Option<f64>,
    pub caret: Option<f64>,
    #[serde(default)]
    pub inverse: bool,
    pub source: Option<String>,
}

/// A photo/video/WebGL rectangle, or a 2D canvas to classify by density.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Photo {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub canvas2d: bool,
}

/// Rendering options with the page script's JSON names.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub cols: usize,
    pub rows: usize,
    pub cell_width: usize,
    pub cell_height: usize,
    pub page_background: i32,
    pub photos: Vec<Photo>,
    pub half_blocks: bool,
    pub sextants: bool,
    pub truecolor: bool,
    pub lines: bool,
    /// Milliseconds, used by the session's pair budget. None uses wall time.
    pub now: Option<f64>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            cols: 0,
            rows: 0,
            cell_width: 8,
            cell_height: 16,
            page_background: 0,
            photos: vec![],
            half_blocks: true,
            sextants: false,
            truecolor: false,
            lines: false,
            now: None,
        }
    }
}

/// A styled run: text, foreground hex (or empty), background hex, style bits.
/// Bits are bold=1, inverse=2, dim=4, exactly as in JavaScript.
pub type Run = (String, String, String, u8);

/// Both encodings are retained when `Options::lines` is true, as in JS.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Frame {
    pub cols: usize,
    pub rows: usize,
    pub cells: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<Vec<Run>>>,
}

/// Per-view glyph and UI history. Reset to default on scrolling.
#[derive(Clone, Debug, Default)]
pub struct Memory {
    key: Option<(usize, usize, usize, usize, i32)>,
    glyphs: Vec<i16>,
    ui: Option<Still>,
}

#[derive(Clone, Debug)]
struct Still {
    pixels: Vec<u8>,
    ch: Vec<u16>,
    fg: Vec<i32>,
    bg: Vec<i32>,
}

/// Per-view palette, canvas classification, and ordered painter pair slots.
#[derive(Clone, Debug, Default)]
pub struct Painter {
    palette: Option<Palette>,
    dense_canvases: HashMap<(i64, i64, i64, i64), bool>,
    held: Vec<(i32, u64)>,
    paint: u64,
}

/// One session-wide admission bucket, shared by every view in a helper.
/// Passing it explicitly keeps rendering deterministic and avoids global locks.
#[derive(Clone, Debug)]
pub struct Session {
    tokens: f64,
    at: Option<f64>,
}
impl Default for Session {
    fn default() -> Self { Self { tokens: 4096.0, at: None } }
}

#[derive(Clone, Debug)]
struct Cell {
    ch: char,
    fg: i32,
    bg: i32,
    flags: u8,
    photo: Option<(f64, i32)>,
    alt: Option<Box<Cell>>,
}
impl Cell {
    fn new(ch: char, fg: i32, bg: i32) -> Self {
        Self { ch, fg, bg, flags: 0, photo: None, alt: None }
    }
    fn flat(bg: i32) -> Self { Self::new(' ', -1, bg) }
}

pub use color::{CssColor, parse_css_color};

/// Classify a 2D canvas, remembering the 25%/15% density hysteresis if given
/// a painter. Ties in the modal colour retain first-pixel insertion order.
pub fn canvas_is_photo(img: &Image, rect: &Photo,
    painter: Option<&mut Painter>) -> bool {
    let x0 = js_round(rect.x).max(0.0) as i64;
    let y0 = js_round(rect.y).max(0.0) as i64;
    let x1 = js_round(rect.x + rect.w).min(img.width as f64) as i64;
    let y1 = js_round(rect.y + rect.h).min(img.height as f64) as i64;
    if x1 - x0 < 8 || y1 - y0 < 8 { return false; }
    let mut counts = HashMap::<usize, usize>::new();
    let mut order = Vec::new();
    let mut samples = 0;
    for y in (y0..y1).step_by(2) {
        for x in (x0..x1).step_by(2) {
            let i = (y as usize * img.width + x as usize) * 4;
            let k =
                ((img.data[i] as usize >> 3) << 10) |
                        ((img.data[i + 1] as usize >> 3) << 5) |
                    (img.data[i + 2] as usize >> 3);
            let n = counts.entry(k).or_insert_with(|| { order.push(k); 0 });
            *n += 1;
            samples += 1;
        }
    }
    let (mut mode, mut most) = (0, 0);
    for k in order { if counts[&k] > most { mode = k; most = counts[&k]; } }
    let br = (((mode >> 10) & 31) * 8 + 4) as i32;
    let bg = (((mode >> 5) & 31) * 8 + 4) as i32;
    let bb = ((mode & 31) * 8 + 4) as i32;
    let mut differ = 0;
    for y in (y0..y1).step_by(2) {
        for x in (x0..x1).step_by(2) {
            let i = (y as usize * img.width + x as usize) * 4;
            if (img.data[i] as i32 - br).abs() +
                            (img.data[i + 1] as i32 - bg).abs() +
                        (img.data[i + 2] as i32 - bb).abs() > 36 {
                differ += 1;
            }
        }
    }
    let key = (x0, y0, x1 - x0, y1 - y0);
    let was =
        painter.as_ref().and_then(|p|
                        p.dense_canvases.get(&key)).copied().unwrap_or(false);
    let dense =
        differ as f64 / samples as f64 >= if was { 0.15 } else { 0.25 };
    if let Some(p) = painter { p.dense_canvases.insert(key, dense); }
    dense
}

fn ui_cell(mut fit: Fit, c: &Candidates, page: i32) -> Cell {
    let alt = fit.alt.take();
    let cand = (fit.index >= 0).then(|| &c.list()[fit.index as usize]);
    let mut glyph = fit.glyph.unwrap_or_else(|| cand.map_or(' ', |c| c.ch));
    let mut fg = terminal(fit.fg, page);
    let mut bg = terminal(fit.bg, page);
    if glyph == '▇' || glyph == '▉' {
        glyph = if glyph == '▇' { '▔' } else { '▕' };
        std::mem::swap(&mut fg, &mut bg);
    }
    if fg == -1 && bg != -1 {
        if let Some(comp) = cand.and_then(|c| c.complement) {
            glyph = comp;
            std::mem::swap(&mut fg, &mut bg);
        } else { fg = quant(fit.fg); }
    }
    let mut cell =
        if glyph == ' ' || fg == bg ||
                (fg >= 0 && bg >= 0 && near(fg, bg, 10)) {
            Cell::flat(terminal(fit.mean, page))
        } else { Cell::new(glyph, fg, bg) };
    if let Some(alt) = alt {
        cell.alt =
            Some(Box::new(alt.map_or_else(||
                            Cell::flat(terminal(fit.bg, page)),
                        |f| ui_cell(*f, c, page))));
    }
    cell
}

#[allow(clippy::too_many_arguments)]
fn ui_fit(img: &Image, x: usize, y: usize, at: usize, c: &Candidates,
    s: &mut Gather, u: &mut Ui, page: i32, still: Option<&mut Still>)
    -> Cell {
    let Some(still) =
        still else {
            return ui_cell(u.fit(img, x, y, c, -1, 0,
                            c.ch as
                                i64).unwrap_or_else(|| fit_cell(s, img, x, y, c, false)), c,
                    page);
        };
    let base = at * c.cw * c.ch * 3;
    let limit =
        if still.ch[at] != 0 { 3.5 * (c.cw * c.ch * 3) as f64 } else { -1.0 };
    let (mut moved, mut pixels) = (0, 0);
    for yy in 0..c.ch {
        if moved as f64 > limit || pixels >= 4 { break; }
        for xx in 0..c.cw {
            let i =
                ((y + yy).min(img.height - 1) * img.width +
                            (x + xx).min(img.width - 1)) * 4;
            let o = base + (yy * c.cw + xx) * 3;
            let delta =
                (img.data[i] as i32 - still.pixels[o] as i32).abs() +
                        (img.data[i + 1] as i32 - still.pixels[o + 1] as i32).abs()
                    +
                    (img.data[i + 2] as i32 - still.pixels[o + 2] as i32).abs();
            moved += delta;
            if delta >= 30 { pixels += 1; }
        }
    }
    if moved as f64 <= limit && pixels < 4 {
        return Cell::new(char::from_u32(still.ch[at] as u32).unwrap(),
                still.fg[at], still.bg[at]);
    }
    u.prev = still.ch[at];
    let cell =
        ui_cell(u.fit(img, x, y, c, -1, 0,
                    c.ch as
                        i64).unwrap_or_else(|| fit_cell(s, img, x, y, c, false)), c,
            page);
    u.prev = 0;
    for yy in 0..c.ch {
        for xx in 0..c.cw {
            let i =
                ((y + yy).min(img.height - 1) * img.width +
                            (x + xx).min(img.width - 1)) * 4;
            let o = base + (yy * c.cw + xx) * 3;
            still.pixels[o..o + 3].copy_from_slice(&img.data[i..i + 3]);
        }
    }
    still.ch[at] = cell.ch as u16;
    still.fg[at] = cell.fg;
    still.bg[at] = cell.bg;
    cell
}

/// Compose a frame in exactly the JS pass order. `memory` and `painter` may
/// be omitted for a fresh view; `session` is shared between views.
///
/// Images must have nonzero dimensions and at least width*height*4 bytes;
/// cell dimensions must be positive. Page/helper cells are normally 8x16.
/// Supplying `opts.now` makes the pair budget fully reproducible.
pub fn compose_frame(img: &Image, texts: &[TextLine], opts: &Options,
    mut memory: Option<&mut Memory>, painter: Option<&mut Painter>,
    session: &mut Session) -> Frame {
    assert!(img.width>0&&img.height>0&&img.data.len()>=img.width*img.height*4,"invalid RGBA image");
    let (cols, rows, cw, ch, page) =
        (opts.cols, opts.rows, opts.cell_width, opts.cell_height,
            opts.page_background);
    assert!(cw>0&&ch>0,"cell dimensions must be positive");
    // Classification only persists when the caller supplied a painter.
    let mut painter = painter;
    let photos: Vec<&Photo> =
        opts.photos.iter().filter(|p|
                    !p.canvas2d ||
                        canvas_is_photo(img, p, painter.as_deref_mut())).collect();
    let mut local_painter = Painter::default();
    let painter = painter.unwrap_or(&mut local_painter);
    let key = (cols, rows, cw, ch, page);
    let mut previous = Vec::new();
    if let Some(m) = memory.as_deref_mut() {
        if m.key == Some(key) && !m.glyphs.is_empty() {
            previous = std::mem::take(&mut m.glyphs);
        } else { m.ui = None; }
        m.key = Some(key);
        m.glyphs = vec![-2;cols*rows];
        if m.ui.is_none() {
            m.ui =
                Some(Still {
                        pixels: vec![0;cols*rows*cw*ch*3],
                        ch: vec![0;cols*rows],
                        fg: vec![0;cols*rows],
                        bg: vec![0;cols*rows],
                    });
        }
    }
    let is_photo =
        |c: usize, r: usize, flat: bool|
            {
                let x = (c as f64 + 0.5) * cw as f64;
                let y = (r as f64 + 0.5) * ch as f64;
                photos.iter().any(|p|
                        (!flat || p.canvas2d) && x >= p.x && x < p.x + p.w &&
                                y >= p.y && y < p.y + p.h)
            };
    let candidates = Candidates::new(cw, ch);
    let mut s = Gather::new(&candidates);
    let mut u = Ui::new(&candidates);
    let parts = candidates.partitions(opts.sextants);
    if !photos.is_empty() && !opts.truecolor {
        let pal = painter.palette.get_or_insert_with(Palette::default);
        for h in &mut pal.hist { *h = (*h as f64 * 0.85) as f32; }
        if pal.centers.is_empty() {
            for r in 0..rows {
                for c in 0..cols {
                    if !is_photo(c, r, false) { continue; }
                    s.gather(img, c * cw, r * ch, &candidates, PHOTO_WEIGHTS);
                    let mut best = parts[0];
                    let mut best_j = f64::NEG_INFINITY;
                    for &k in &parts {
                        let j = s.fit(&candidates.all[k]);
                        if j > best_j { best_j = j; best = k; }
                    }
                    s.fit(&candidates.all[best]);
                    pal.learn(&s, Some(candidates.all[best].nf));
                }
            }
            pal.update(8);
        } else if pal.frames % 10 == 0 { pal.update(2); }
        pal.frames += 1;
    }
    let mut cells = Vec::with_capacity(cols * rows);
    for r in 0..rows {
        for c in 0..cols {
            let (x, y, at) = (c * cw, r * ch, r * cols + c);
            if !opts.half_blocks {
                cells.push(Cell::flat(terminal(average(img, x, y, cw, ch),
                            page)));
                continue;
            }
            let photo = !photos.is_empty() && is_photo(c, r, false);
            let prev =
                if !previous.is_empty() && !is_photo(c, r, true) {
                    previous[at]
                } else { -2 };
            if photo && opts.truecolor {
                let fit = fit_cell(&mut s, img, x, y, &candidates, true);
                let mut index = fit.index;
                if prev >= 0 && prev != index {
                    s.gather(img, x, y, &candidates, PHOTO_WEIGHTS);
                    let keep = s.fit(&candidates.list()[prev as usize]);
                    let best =
                        if index >= 0 {
                            s.fit(&candidates.list()[index as usize])
                        } else { 0.0 };
                    if index < 0 || keep >= 0.8 * best { index = prev; }
                }
                if let Some(m) = memory.as_deref_mut() {
                    m.glyphs[at] = index;
                }
                if index < 0 { cells.push(Cell::flat(fit.mean)); continue; }
                s.gather(img, x, y, &candidates, PHOTO_WEIGHTS);
                let cand = &candidates.list()[index as usize];
                s.fit(cand);
                let (fg, bg) = s.colors(cand.nf);
                cells.push(Cell::new(cand.ch, fg, bg));
                continue;
            }
            if photo {
                let pal = painter.palette.as_mut().unwrap();
                let fit =
                    fit_photo(&mut s, img, x, y, &candidates, prev, pal,
                        &parts);
                if let Some(m) = memory.as_deref_mut() {
                    m.glyphs[at] = fit.index;
                }
                if fit.index < 0 {
                    cells.push(Cell::flat(pal.color(fit.flat)));
                    continue;
                }
                let mut glyph = candidates.all[fit.index as usize].ch;
                let (mut fg, mut bg) = (fit.fg, fit.bg);
                if pal.centers[fg] > pal.centers[bg] {
                    glyph =
                        candidates.all[fit.index as usize].complement.unwrap();
                    std::mem::swap(&mut fg, &mut bg);
                }
                let mut cell = Cell::new(glyph, pal.color(fg), pal.color(bg));
                cell.photo = Some((fit.gain, pal.color(fit.flat)));
                cells.push(cell);
                continue;
            }
            let still = memory.as_deref_mut().and_then(|m| m.ui.as_mut());
            cells.push(ui_fit(img, x, y, at, &candidates, &mut s, &mut u,
                    page, still));
        }
    }
    // Join short runs of out-of-step thin lines.
    let level =
        |c: &Cell|
            match c.ch { '▔' => 0, '━' => 1, '▁' => 2, _ => -1, };
    for r in 0..rows {
        for c in 1..cols.saturating_sub(1) {
            let before = cells[r * cols + c - 1].clone();
            let lv = level(&before);
            if lv < 0 { continue; }
            for run in 1..=2 {
                if c + run >= cols { break; }
                let after = &cells[r * cols + c + run];
                if level(after) != lv || after.fg != before.fg ||
                        after.bg != before.bg {
                    continue;
                }
                let odd =
                    (0..run).all(|k|
                            {
                                let cell = &cells[r * cols + c + k];
                                level(cell) >= 0 && level(cell) != lv &&
                                        cell.fg == before.fg && cell.bg == before.bg
                            });
                if odd {
                    for k in 0..run { cells[r * cols + c + k].ch = before.ch; }
                }
                break;
            }
        }
    }
    // Isolated Braille is a corner, not a line. Restore its block alternative.
    let braille = |c: &Cell| ('⠁'..='⣿').contains(&c.ch);
    let mut lone = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let cell = &cells[r * cols + c];
            if cell.photo.is_some() || !braille(cell) { continue; }
            let mut joined = false;
            for dr in -1..=1 {
                for dc in -1..=1 {
                    let rr = r as i64 + dr;
                    let cc = c as i64 + dc;
                    if (dr != 0 || dc != 0) && rr >= 0 && rr < rows as i64 &&
                                cc >= 0 && cc < cols as i64 {
                        let other = &cells[rr as usize * cols + cc as usize];
                        if braille(other) && other.fg == cell.fg { joined = true; }
                    }
                }
            }
            if !joined { lone.push(r * cols + c); }
        }
    }
    for at in lone {
        let back =
            cells[at].alt.take().map(|c|
                        *c).unwrap_or_else(|| Cell::flat(cells[at].bg));
        if let Some(still) = memory.as_deref_mut().and_then(|m| m.ui.as_mut())
            {
            still.ch[at] = back.ch as u16;
            still.fg[at] = back.fg;
            still.bg[at] = back.bg;
        }
        cells[at] = back;
    }
    // Clear all glyph boxes before placing any text.
    let box_of =
        |line: &TextLine| -> Option<(i64, i64, i64, i64)>
            {
                let top = line.top?;
                let right = line.right?;
                let bottom = line.bottom?;
                Some(((top / ch as f64).floor().max(0.0) as i64,
                        ((bottom - 1.0) / ch as f64).floor().min(rows as f64 - 1.0)
                            as i64, (line.x / cw as f64).floor().max(0.0) as i64,
                        (right / cw as f64).ceil().min(cols as f64) as i64))
            };
    let mut covering = vec![0u8;cols*rows];
    for line in texts {
        if let Some((r0, r1, c0, c1)) = box_of(line) {
            for r in r0..=r1 {
                for c in c0..c1 {
                    let i = r as usize * cols + c as usize;
                    covering[i] = (covering[i] + 1).min(2);
                }
            }
        }
    }
    for line in texts {
        if let Some((r0, r1, c0, c1)) = box_of(line) {
            let ink = parse_css_color(line.color.as_deref()).rgb;
            for r in r0..=r1 {
                for c in c0..c1 {
                    let at = r as usize * cols + c as usize;
                    let fit =
                        if covering[at] > 1 {
                            None
                        } else {
                            u.fit(img, c as usize * cw, r as usize * ch, &candidates,
                                ink, line.top.unwrap().floor() as i64 - r * ch as i64,
                                line.bottom.unwrap().ceil() as i64 - r * ch as i64)
                        };
                    cells[at] =
                        fit.map_or_else(||
                                Cell::flat(terminal(dominant(img, c as usize * cw,
                                            r as usize * ch, cw, ch), page)),
                            |f| ui_cell(f, &candidates, page));
                }
            }
        }
    }
    // Rounded horizontal bar ends take their run's shape.
    let bars =
        |ch|
            matches!(ch,'▀'|'▄'|'▔'|'━'|'▁'|'▂'|'▃'|'▅'|'▆'|'▇');
    let corners =
        |ch| matches!(ch,'▘'|'▝'|'▖'|'▗'|'▛'|'▜'|'▙'|'▟');
    let same =
        |a: &Cell, b: &Cell|
            (a.fg == b.fg && a.bg == b.bg) || (a.fg == b.bg && a.bg == b.fg);
    for r in 0..rows {
        let mut c = 0;
        while c < cols {
            let cell = cells[r * cols + c].clone();
            if !bars(cell.ch) || cell.photo.is_some() { c += 1; continue; }
            let mut end = c;
            while end + 1 < cols {
                let next = &cells[r * cols + end + 1];
                if next.ch != cell.ch || next.fg != cell.fg ||
                        next.bg != cell.bg {
                    break;
                }
                end += 1;
            }
            if end - c >= 1 {
                for (cap, beyond) in
                    [(end as i64 + 1, end as i64 + 2),
                            (c as i64 - 1, c as i64 - 2)] {
                    if cap < 0 || cap >= cols as i64 { continue; }
                    let tail = &cells[r * cols + cap as usize];
                    if tail.ch == cell.ch || !same(tail, &cell) ||
                            !(bars(tail.ch) || corners(tail.ch)) {
                        continue;
                    }
                    if beyond >= 0 && beyond < cols as i64 {
                        let past = &cells[r * cols + beyond as usize];
                        if same(past, &cell) && (bars(past.ch) || corners(past.ch))
                            {
                            continue;
                        }
                    }
                    let tail = &mut cells[r * cols + cap as usize];
                    tail.ch = cell.ch;
                    tail.fg = cell.fg;
                    tail.bg = cell.bg;
                }
            }
            c = end + 1;
        }
    }
    let mut is_text = vec![false;cols*rows];
    let is_free =
        |marked: &[bool], row: i64, from: i64, to: i64| -> bool
            {
                if row < 0 || row >= rows as i64 { return false; }
                (from.max(0)..to.min(cols as
                                    i64)).all(|c| !marked[row as usize * cols + c as usize])
            };
    for line in texts {
        let exact = line.cy / ch as f64;
        let home = exact.floor() as i64;
        if home < 0 || home >= rows as i64 { continue; }
        let mut col = js_round(line.x / cw as f64) as i64;
        let limit =
            (cols as
                        i64).min(line.max_x.map_or(cols as i64,
                    |x| (x / cw as f64).floor() as i64));
        let mut chars: Vec<char> = line.t.chars().collect();
        if line.caret.is_some_and(|c| c >= chars.len() as f64) {
            chars.push(' ');
        }
        let end = limit.min(col + chars.len() as i64);
        let near =
            if exact - (home as f64) < 0.5 { home - 1 } else { home + 1 };
        let far = if near == home - 1 { home + 1 } else { home - 1 };
        let mut row = home;
        if !is_free(&is_text, home, col, end) {
            let mut shifted = col;
            while shifted - col <= 6 &&
                    !is_free(&is_text, home, shifted - 1,
                            shifted + chars.len() as i64) {
                shifted += 1;
            }
            let clipped = col + chars.len() as i64 > limit;
            if shifted - col <= 6 &&
                    (shifted + chars.len() as i64 <= limit ||
                            (clipped && shifted < limit)) {
                col = shifted;
            } else {
                row =
                    [near,
                                        far].into_iter().find(|&r|
                                is_free(&is_text, r, col, end)).unwrap_or(home);
            }
        }
        let placed_end = limit.min(col + chars.len() as i64);
        for c in col.max(0)..placed_end {
            is_text[row as usize * cols + c as usize] = true;
        }
        for (i, glyph) in chars.into_iter().enumerate() {
            if col >= limit { break; }
            if col >= 0 {
                let bg_pixel =
                    dominant(img, col as usize * cw, row as usize * ch, cw, ch);
                let bg = terminal(bg_pixel, page);
                let fg =
                    quant(blend(parse_css_color(line.color.as_deref()),
                            bg_pixel));
                let cell = &mut cells[row as usize * cols + col as usize];
                cell.ch = single_width(glyph);
                cell.fg = fg;
                cell.bg = bg;
                cell.flags =
                    u8::from(line.bold) | if line.dim { 4 } else { 0 } |
                        if line.caret == Some(i as f64) || line.inverse {
                            2
                        } else { 0 };
            }
            col += 1;
        }
    }
    if !photos.is_empty() && !opts.truecolor {
        let now =
            opts.now.unwrap_or_else(||
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
                        as f64);
        admit_pairs(&mut cells, painter, session, now);
    }
    Frame {
        cols,
        rows,
        cells: pack_raster(&cells),
        lines: opts.lines.then(|| to_runs(&cells, cols, rows)),
    }
}

fn pair_key(fg: i32, bg: i32) -> i32 {
    let key =
        |c: i32|
            if c < 0 {
                4096
            } else {
                lattice_of(((c >> 16) & 255) as f64, ((c >> 8) & 255) as f64,
                        (c & 255) as f64) as i32
            };
    key(fg) * 8192 + key(bg)
}
fn admit_pairs(cells: &mut [Cell], painter: &mut Painter,
    bucket: &mut Session, now: f64) {
    painter.paint += 1;
    let paint = painter.paint;
    let at = bucket.at.get_or_insert(now);
    bucket.tokens =
        (bucket.tokens + ((now - *at).max(0.0) * 160.0) / 1000.0).min(4096.0);
    *at = now;
    let key_of =
        |cell: &Cell|
            pair_key(if cell.ch == ' ' { -1 } else { cell.fg }, cell.bg);
    let mut used = HashSet::new();
    let admit =
        |k: i32, held: &mut Vec<(i32, u64)>, used: &HashSet<i32>,
            bucket: &mut Session|
            {
                if held.len() >= 1024 {
                    let mut oldest = None;
                    let mut oldest_paint = u64::MAX;
                    for (i, &(key, last)) in held.iter().enumerate() {
                        if last < paint && last < oldest_paint &&
                                !used.contains(&key) {
                            oldest = Some(i);
                            oldest_paint = last;
                        }
                    }
                    if let Some(i) = oldest { held.remove(i); }
                }
                bucket.tokens -= 1.0;
                held.push((k, paint));
            };
    let mut wants = Vec::new();
    for (i, cell) in cells.iter().enumerate() {
        let k = key_of(cell);
        if let Some(e) = painter.held.iter_mut().find(|e| e.0 == k) {
            used.insert(k);
            e.1 = paint;
            continue;
        }
        if used.contains(&k) { painter.held.push((k, paint)); continue; }
        if cell.photo.is_some() { wants.push(i); continue; }
        admit(k, &mut painter.held, &used, bucket);
        used.insert(k);
    }
    let mut allowance =
        if painter.held.len() < 1024 {
            ((1024 - painter.held.len()) as
                        f64).min(bucket.tokens.floor() - 64.0)
        } else { 24.0_f64.min((bucket.tokens - 1100.0).floor()) };
    // Stable sort: equal gains preserve row-major order.
    wants.sort_by(|&a, &b|
            cells[b].photo.unwrap().0.partial_cmp(&cells[a].photo.unwrap().0).unwrap_or(std::cmp::Ordering::Equal));
    for i in wants {
        let k = key_of(&cells[i]);
        if let Some(e) = painter.held.iter_mut().find(|e| e.0 == k) {
            used.insert(k);
            e.1 = paint;
            continue;
        }
        if used.contains(&k) { painter.held.push((k, paint)); continue; }
        if allowance > 0.0 {
            admit(k, &mut painter.held, &used, bucket);
            used.insert(k);
            allowance -= 1.0;
            continue;
        }
        cells[i] = Cell::flat(cells[i].photo.unwrap().1);
        let flat = key_of(&cells[i]);
        if !painter.held.iter().any(|e| e.0 == flat) && !used.contains(&flat)
            {
            admit(flat, &mut painter.held, &used, bucket);
        }
        used.insert(flat);
        if let Some(e) = painter.held.iter_mut().find(|e| e.0 == flat) {
            e.1 = paint;
        } else { painter.held.push((flat, paint)); }
    }
}
fn pack_raster(cells: &[Cell]) -> String {
    let mut bytes = Vec::with_capacity(cells.len() * 12);
    for cell in cells {
        let (mut fg, mut bg) = (cell.fg, cell.bg);
        if cell.flags & 4 != 0 && fg >= 0 {
            fg = mix(fg, if bg >= 0 { bg } else { 0x202020 });
        }
        if cell.flags & 2 != 0 {
            (fg, bg) =
                (if bg >= 0 { bg } else { 0x161616 },
                    if fg >= 0 { fg } else { 0xe6e6e6 });
        }
        for w in
            [cell.ch as u32, if fg >= 0 { fg as u32 } else { 0x01000000 },
                    if bg >= 0 { bg as u32 } else { 0x01000000 }] {
            bytes.extend_from_slice(&w.to_le_bytes());
        }
    }
    STANDARD.encode(bytes)
}
fn to_runs(cells: &[Cell], cols: usize, rows: usize) -> Vec<Vec<Run>> {
    let mut lines = Vec::with_capacity(rows);
    for r in 0..rows {
        let mut runs: Vec<Run> = Vec::new();
        let mut previous = None;
        for cell in &cells[r * cols..(r + 1) * cols] {
            let fg =
                if cell.ch == ' ' && cell.flags & 2 == 0 {
                    -1
                } else { cell.fg };
            let style = (fg, cell.bg, cell.flags);
            if previous == Some(style) {
                runs.last_mut().unwrap().0.push(cell.ch);
            } else {
                runs.push((cell.ch.to_string(), hex(fg), hex(cell.bg),
                        cell.flags));
                previous = Some(style);
            }
        }
        lines.push(runs);
    }
    lines
}
