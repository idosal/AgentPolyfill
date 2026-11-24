//! Cells only: texts that share a visual line put on one row before the
//! renderer places them (it puts each at its own centre's row). A heatmap's
//! month label, centred against two lines of text, and that row's numbers,
//! centred in their cells, sit a few pixels apart; where a row boundary
//! falls between them, the label was drawn a line above its numbers.
//!
//! Two texts are on one line when their boxes overlap by at least half the
//! smaller one's height and they don't overlap across (texts side by side). A
//! box taller than TALL cells (a big figure, a rotated axis title) is a line
//! of its own and never moves. A line whose texts fall on two rows moves to
//! the row most of them are on. Another line in the way (a text of it on that
//! row, overlapping a mover across) goes down a row whole, if the row is free
//! and it stays on the picture; if not, nothing moves. Lines are taken from
//! the bottom up, so the one below has made room first. Nothing moves more
//! than a row, so nothing drifts, and a page with no such line is left
//! exactly as it was. `MCP_APPS_CLI_GROUP=0` turns it off.

use std::collections::HashMap;

use mcp_apps_render::{Image, TextLine};

/// Two boxes are one line when they overlap by this much of the smaller's height.
const SAME_LINE: f64 = 0.5;
/// A box this many cells tall or more is a line of its own.
const TALL: f64 = 1.5;

fn bounds(t: &TextLine, cell_h: f64) -> (f64, f64) {
    match (t.top, t.bottom) {
        (Some(top), Some(bottom)) if bottom > top => (top, bottom),
        _ => (t.cy - cell_h / 2.0, t.cy + cell_h / 2.0),
    }
}

/// Where a text runs across, in pixels: its measured right edge, else a cell a character.
fn span(t: &TextLine, cell_w: f64) -> (f64, f64) {
    let right = t.right.or(t.max_x).unwrap_or(t.x + t.t.chars().count() as f64 * cell_w);
    (t.x, right.max(t.x + cell_w))
}

fn row(cy: f64, cell_h: f64) -> i64 { (cy / cell_h).floor() as i64 }

/// Where a moved text's glyphs were: painted over with the commonest colour
/// just around its box, or the renderer, which leaves alone only the pixels
/// under a text, draws them as blocks a row from the text.
fn erase(image: &mut Image, (left, right): (f64, f64), (top, bottom): (f64, f64)) {
    let (w, h) = (image.width as isize, image.height as isize);
    let (x0, x1) = ((left.floor() as isize).clamp(0, w), (right.ceil() as isize).clamp(0, w));
    let (y0, y1) = ((top.floor() as isize).clamp(0, h), (bottom.ceil() as isize).clamp(0, h));
    if x0 >= x1 || y0 >= y1 { return; }
    let pixel = |image: &Image, x: isize, y: isize| -> Option<[u8; 4]> {
        if x < 0 || y < 0 || x >= w || y >= h { return None; }
        let i = ((y * w + x) * 4) as usize;
        image.data.get(i..i + 4).map(|c| [c[0], c[1], c[2], c[3]])
    };
    let mut seen: HashMap<[u8; 4], usize> = HashMap::new();
    for x in x0 - 1..=x1 {
        for y in [y0 - 1, y1] { if let Some(c) = pixel(image, x, y) { *seen.entry(c).or_default() += 1; } }
    }
    for y in y0..y1 {
        for x in [x0 - 1, x1] { if let Some(c) = pixel(image, x, y) { *seen.entry(c).or_default() += 1; } }
    }
    let Some((&colour, _)) = seen.iter().max_by_key(|(c, n)| (**n, **c)) else { return };
    for y in y0..y1 {
        for x in x0..x1 {
            let i = ((y * w + x) * 4) as usize;
            image.data[i..i + 4].copy_from_slice(&colour);
        }
    }
}

/// The texts' centres moved so each visual line is on one row (their old
/// glyphs painted over in `image`); how many moved.
/// A text drawn on another row than the page has it: columns `left..=right`
/// of row `row`, `rows` below where it is on the page (see `group_moves`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Moved { pub left: i64, pub right: i64, pub row: i64, pub rows: i64 }

/// The texts moved, counted (see `group_moves`).
#[cfg(test)]
pub fn group(image: &mut Image, texts: &mut [TextLine], cell_w: f64, cell_h: f64) -> usize {
    group_moves(image, texts, cell_w, cell_h).len()
}

/// Texts that share a visual line onto one row; each it moved, where it is
/// now and by how many rows, so input on it can be sent where it is on the page.
pub fn group_moves(image: &mut Image, texts: &mut [TextLine], cell_w: f64, cell_h: f64) -> Vec<Moved> {
    if cell_h <= 0.0 || cell_w <= 0.0 || texts.len() < 2 { return Vec::new(); }
    let last_row = (image.height as f64 / cell_h).floor() as i64 - 1;
    let spans: Vec<(f64, f64)> = texts.iter().map(|t| span(t, cell_w)).collect();
    let across = |a: usize, b: usize| spans[a].0 < spans[b].1 && spans[b].0 < spans[a].1;
    let mut order: Vec<usize> = (0..texts.len()).collect();
    order.sort_by(|&a, &b| texts[a].cy.total_cmp(&texts[b].cy));
    // Lines, top to bottom: each its members, judged against its tallest
    // member's box (not chained member to member, which would drift down).
    let mut lines: Vec<Vec<usize>> = Vec::new();
    let mut anchor: Vec<(f64, f64)> = Vec::new();
    let mut line_of = vec![0usize; texts.len()];
    for &i in &order {
        let (top, bottom) = bounds(&texts[i], cell_h);
        let tall = bottom - top >= TALL * cell_h;
        let found = if tall { None } else {
            (0..lines.len()).rev().take(8).find(|&l| {
                let (at, ab) = anchor[l];
                if ab - at >= TALL * cell_h { return false; }
                let overlap = bottom.min(ab) - top.max(at);
                overlap > 0.0 && overlap >= SAME_LINE * (bottom - top).min(ab - at) && !lines[l].iter().any(|&m| across(m, i))
            })
        };
        match found {
            Some(l) => {
                lines[l].push(i);
                line_of[i] = l;
                if bottom - top > anchor[l].1 - anchor[l].0 { anchor[l] = (top, bottom); }
            }
            None => { line_of[i] = lines.len(); lines.push(vec![i]); anchor.push((top, bottom)); }
        }
    }
    let rows: Vec<i64> = texts.iter().map(|t| row(t.cy, cell_h)).collect();
    let mut placed = rows.clone();
    // From the bottom up: a line moved down frees the row the line above it
    // needs for its own text in the way (a heatmap's months, one after another).
    for (l, members) in lines.iter().enumerate().rev() {
        let mut member_rows: Vec<i64> = members.iter().map(|&i| placed[i]).collect();
        member_rows.sort_unstable();
        if member_rows.first() == member_rows.last() { continue; }
        // The row most of them are on (the lower one on a tie).
        let target = *member_rows.iter().max_by_key(|&&r| (member_rows.iter().filter(|&&x| x == r).count(), r)).unwrap();
        let movers: Vec<usize> = members.iter().copied().filter(|&i| placed[i] != target).collect();
        if movers.iter().any(|&i| (placed[i] - target).abs() > 1) { continue; }
        // The other lines in the way: each goes down a row whole, or nothing moves.
        let mut pushed: Vec<usize> = (0..texts.len())
            .filter(|&j| line_of[j] != l && placed[j] == target && movers.iter().any(|&i| across(i, j)))
            .map(|j| line_of[j])
            .collect();
        pushed.sort_unstable();
        pushed.dedup();
        let fits = pushed.iter().flat_map(|&p| lines[p].iter().copied()).all(|j| {
            placed[j] == target
                && target + 1 - rows[j] <= 1
                && target < last_row
                && (0..texts.len()).all(|k| line_of[k] == l || pushed.contains(&line_of[k]) || placed[k] != target + 1 || !across(j, k))
        });
        if !fits { continue; }
        for &p in &pushed { for &j in &lines[p] { placed[j] = target + 1; } }
        for &i in &movers { placed[i] = target; }
    }
    let mut moved = Vec::new();
    for (i, t) in texts.iter_mut().enumerate() {
        if placed[i] == rows[i] { continue; }
        moved.push(Moved {
            left: (spans[i].0 / cell_w).floor() as i64,
            right: ((spans[i].1 / cell_w).ceil() as i64 - 1).max((spans[i].0 / cell_w).floor() as i64),
            row: placed[i],
            rows: placed[i] - rows[i],
        });
        erase(image, spans[i], bounds(t, cell_h));
        // Its centre to the middle of the new row, its box with it.
        let to = placed[i] as f64 * cell_h + cell_h / 2.0;
        let by = to - t.cy;
        t.cy = to;
        t.top = t.top.map(|v| v + by);
        t.bottom = t.bottom.map(|v| v + by);
    }
    moved
}

/// How many rows below its place on the page the text drawn at this cell
/// is (a moved one), if any.
pub fn shift_at(moved: &[Moved], col: i64, row: i64) -> Option<i64> {
    moved.iter().find(|m| m.row == row && (m.left..=m.right).contains(&col)).map(|m| m.rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> Image { Image { width: 400, height: 400, data: vec![255; 400 * 400 * 4] } }

    fn text(t: &str, x: f64, cy: f64, h: f64) -> TextLine {
        serde_json::from_value(serde_json::json!({"t": t, "x": x, "cy": cy, "top": cy - h / 2.0, "bottom": cy + h / 2.0})).unwrap()
    }

    fn rows_of(texts: &[TextLine]) -> Vec<i64> { texts.iter().map(|t| row(t.cy, 16.0)).collect() }

    #[test]
    fn a_label_joins_its_numbers_row() {
        // The cohort heatmap's "Apr 2026" row, as Chrome laid it out.
        let mut texts = vec![
            text("Apr 2026", 0.0, 202.5, 16.0),
            text("100", 133.8, 209.0, 13.0),
            text("84", 182.5, 209.0, 13.0),
            text("4,526", 0.0, 219.0, 16.0),
        ];
        assert!(group(&mut blank(), &mut texts, 8.0, 16.0) > 0);
        let rows = rows_of(&texts);
        assert_eq!(rows[0], rows[1]);
        assert_eq!(rows[1], rows[2]);
        // The count under the label, in the label's new row's way, goes a row down.
        assert_eq!(rows[3], rows[0] + 1);
    }

    #[test]
    fn lines_already_on_one_row_are_left_alone() {
        let mut texts = vec![text("Dec 2025", 0.0, 66.5, 16.0), text("100", 133.8, 73.0, 13.0), text("1,085", 0.0, 84.0, 16.0)];
        let before: Vec<f64> = texts.iter().map(|t| t.cy).collect();
        assert_eq!(group(&mut blank(), &mut texts, 8.0, 16.0), 0);
        assert_eq!(texts.iter().map(|t| t.cy).collect::<Vec<_>>(), before);
    }

    #[test]
    fn nothing_moves_where_the_row_below_is_taken() {
        let mut texts = vec![
            text("Apr 2026", 0.0, 202.5, 16.0),
            text("100", 133.8, 209.0, 13.0),
            text("4,526", 0.0, 219.0, 16.0),
            text("May 2026", 0.0, 230.0, 10.0),
        ];
        let before: Vec<f64> = texts.iter().map(|t| t.cy).collect();
        group(&mut blank(), &mut texts, 8.0, 16.0);
        assert_eq!(texts[0].cy, before[0]);
        assert_eq!(texts[2].cy, before[2]);
    }

    #[test]
    fn rows_of_months_one_after_another_all_join_their_numbers() {
        let mut texts = Vec::new();
        for (k, month) in ["Apr", "May", "Jun"].iter().enumerate() {
            let base = 202.5 + 34.0 * k as f64;
            texts.push(text(month, 0.0, base, 16.0));
            texts.push(text("100", 133.8, base + 6.5, 13.0));
            texts.push(text("4,526", 0.0, base + 16.5, 16.0));
        }
        group(&mut blank(), &mut texts, 8.0, 16.0);
        let rows = rows_of(&texts);
        for k in 0..3 {
            assert_eq!(rows[3 * k], rows[3 * k + 1], "month {k}");
            assert_eq!(rows[3 * k + 2], rows[3 * k] + 1, "month {k}");
        }
    }

    #[test]
    fn a_paragraph_does_not_drift() {
        let mut texts: Vec<TextLine> = (0..20).map(|k| text("some words", 0.0, 7.0 + 14.0 * k as f64, 14.0)).collect();
        assert_eq!(group(&mut blank(), &mut texts, 8.0, 16.0), 0);
    }

    #[test]
    fn a_big_figure_beside_a_two_line_caption_is_left_alone() {
        // A KPI tile: a 48 px number, its caption on two lines beside it.
        let mut texts = vec![text("1,234", 0.0, 40.0, 48.0), text("orders", 120.0, 30.0, 14.0), text("this week", 120.0, 48.0, 14.0)];
        let before: Vec<f64> = texts.iter().map(|t| t.cy).collect();
        assert_eq!(group(&mut blank(), &mut texts, 8.0, 16.0), 0);
        assert_eq!(texts.iter().map(|t| t.cy).collect::<Vec<_>>(), before);
    }

    #[test]
    fn texts_one_above_the_other_are_not_one_line() {
        // Two stacked texts in one column, boxes overlapping by more than half.
        let mut texts = vec![text("first", 0.0, 30.0, 16.0), text("second", 0.0, 36.0, 16.0)];
        let before: Vec<f64> = texts.iter().map(|t| t.cy).collect();
        assert_eq!(group(&mut blank(), &mut texts, 8.0, 16.0), 0);
        assert_eq!(texts.iter().map(|t| t.cy).collect::<Vec<_>>(), before);
    }

    #[test]
    fn a_line_in_the_way_moves_whole_or_not_at_all() {
        // The label's line pushes the count's line, which has a second text
        // further right: both of it go down, together.
        let mut texts = vec![
            text("Apr 2026", 0.0, 202.5, 16.0),
            text("100", 133.8, 209.0, 13.0),
            text("4,526", 0.0, 219.0, 16.0),
            text("note", 300.0, 220.0, 16.0),
        ];
        group(&mut blank(), &mut texts, 8.0, 16.0);
        let rows = rows_of(&texts);
        assert_eq!(rows[2], rows[3], "the count's line stays one line");
    }

    #[test]
    fn nothing_is_pushed_off_the_picture() {
        // On the last row, the text in the way has nowhere to go: nothing moves.
        let mut image = Image { width: 400, height: 224, data: vec![255; 400 * 224 * 4] };
        let mut texts = vec![text("Apr 2026", 0.0, 202.5, 16.0), text("100", 133.8, 209.0, 13.0), text("4,526", 0.0, 219.0, 16.0)];
        let before: Vec<f64> = texts.iter().map(|t| t.cy).collect();
        group(&mut image, &mut texts, 8.0, 16.0);
        assert_eq!(texts[0].cy, before[0]);
    }

    #[test]
    fn a_moved_text_is_painted_over_with_its_background() {
        // A dark page; the label's glyph pixels in white.
        let mut image = Image { width: 400, height: 400, data: vec![20; 400 * 400 * 4] };
        for y in 196..208 { for x in 2..60 { let i = (y * 400 + x) * 4; image.data[i..i + 4].copy_from_slice(&[255, 255, 255, 255]); } }
        let mut texts = vec![text("Apr 2026", 0.0, 202.5, 16.0), text("100", 133.8, 209.0, 13.0), text("4,526", 0.0, 219.0, 16.0)];
        group(&mut image, &mut texts, 8.0, 16.0);
        let i = (200 * 400 + 30) * 4;
        assert_eq!(&image.data[i..i + 3], &[20, 20, 20]);
    }

    #[test]
    fn a_moved_text_says_where_it_went_so_a_click_finds_it() {
        // The heatmap's label, half a row above its numbers: drawn on their row.
        let mut texts = vec![text("Apr 2026", 0.0, 202.5, 16.0), text("100", 133.8, 209.0, 13.0), text("84", 182.5, 209.0, 13.0)];
        let moved = group_moves(&mut blank(), &mut texts, 8.0, 16.0);
        assert_eq!(moved.len(), 1);
        assert_eq!((moved[0].left, moved[0].row, moved[0].rows), (0, row(209.0, 16.0), 1));
        // A click on its new cells is one row off the page; elsewhere, none.
        assert_eq!(shift_at(&moved, moved[0].left, moved[0].row), Some(moved[0].rows));
        assert_eq!(shift_at(&moved, moved[0].right + 1, moved[0].row), None);
        assert_eq!(shift_at(&moved, moved[0].left, moved[0].row + 1), None);
    }
}
