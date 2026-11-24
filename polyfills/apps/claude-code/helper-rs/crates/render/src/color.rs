use serde::{Deserialize, Serialize};
use crate::Image;

pub(crate) fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f < 0.5 { f } else { f + 1.0 }
}
pub(crate) fn int32(x: f64) -> i32 {
    if !x.is_finite() || x == 0.0 {
        0
    } else { x.trunc().rem_euclid(4294967296.0) as u32 as i32 }
}
pub(crate) fn pack(r: f64, g: f64, b: f64) -> i32 {
    int32(js_round(r)).wrapping_shl(16) | int32(js_round(g)).wrapping_shl(8) |
        int32(js_round(b))
}
pub(crate) fn quantize(c: i32) -> i32 {
    let q = |v: i32| (js_round(v as f64 / 17.0) * 17.0).min(255.0) as i32;
    (q((c >> 16) & 255) << 16) | (q((c >> 8) & 255) << 8) | q(c & 255)
}
pub(crate) fn quant(c: i32) -> i32 { if c < 0 { c } else { quantize(c) } }
pub(crate) fn near(a: i32, b: i32, tol: i32) -> bool {
    if a < 0 || b < 0 { return a == b; }
    [16, 8,
                    0].into_iter().all(|s|
            (((a >> s) & 255) - ((b >> s) & 255)).abs() <= tol)
}
pub(crate) fn terminal(c: i32, page: i32) -> i32 {
    if near(c, page, 10) { -1 } else { quant(c) }
}
pub(crate) fn hex(c: i32) -> String {
    if c < 0 { String::new() } else { format!("#{c:06x}") }
}
pub(crate) fn mix(a: i32, b: i32) -> i32 {
    let m = |s| ((((a >> s) & 255) + ((b >> s) & 255)) >> 1) << s;
    m(16) | m(8) | m(0)
}

/// Computed CSS colour, including alpha for blending text with its pixels.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
pub struct CssColor {
    pub rgb: i32,
    pub alpha: f64,
}
impl Default for CssColor {
    fn default() -> Self { Self { rgb: 0xffffff, alpha: 1.0 } }
}

// The exact ECMAScript \s set (not Rust's Unicode White_Space property).
fn space(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn ws(s: &str, at: &mut usize) {
    while let Some(c) = s[*at..].chars().next() {
        if !space(c) { break; }
        *at += c.len_utf8();
    }
}
fn num(s: &str, at: &mut usize) -> Option<f64> {
    let start = *at;
    while s.as_bytes().get(*at).is_some_and(|c|
                c.is_ascii_digit() || *c == b'.') {
        *at += 1;
    }
    if start == *at {
        None
    } else { Some(s[start..*at].parse().unwrap_or(f64::NAN)) }
}
fn byte(s: &str, at: &mut usize, b: u8) -> bool {
    if s.as_bytes().get(*at) == Some(&b) { *at += 1; true } else { false }
}
fn functional(s: &str, start: usize, srgb: bool) -> Option<CssColor> {
    let mut at = start;
    if srgb {
        let before = at;
        ws(s, &mut at);
        if at == before { return None; }
    }
    let r = num(s, &mut at)?;
    if srgb {
        let before = at;
        ws(s, &mut at);
        if at == before { return None; }
    } else { if !byte(s, &mut at, b',') { return None; } ws(s, &mut at); }
    let g = num(s, &mut at)?;
    if srgb {
        let before = at;
        ws(s, &mut at);
        if at == before { return None; }
    } else { if !byte(s, &mut at, b',') { return None; } ws(s, &mut at); }
    let b = num(s, &mut at)?;
    let mut alpha = 1.0;
    let end = at;
    if srgb { ws(s, &mut at); }
    if byte(s, &mut at, if srgb { b'/' } else { b',' }) {
        ws(s, &mut at);
        alpha = num(s, &mut at)?;
    } else { at = end; }
    if !byte(s, &mut at, b')') { return None; }
    let scale =
        |x: f64| if x.is_nan() { x } else { x.clamp(0.0, 1.0) * 255.0 };
    Some(CssColor {
            rgb: if srgb {
                pack(scale(r), scale(g), scale(b))
            } else { pack(r, g, b) },
            alpha,
        })
}

/// Parse exactly the rgb/rgba, color(srgb), and hex forms accepted by the JS
/// renderer. Unrecognised strings return opaque white. None is JS's missing colour.
pub fn parse_css_color(css: Option<&str>) -> CssColor {
    let Some(css) = css else { return CssColor::default(); };
    let trimmed = css.trim_matches(space);
    if let Some(h) = trimmed.strip_prefix('#') {
        if (3..=8).contains(&h.len()) &&
                h.bytes().all(|c| c.is_ascii_hexdigit()) {
            let digits =
                if h.len() <= 4 {
                    h.chars().flat_map(|c| [c, c]).collect::<String>()
                } else { h.to_owned() };
            let rgb =
                i32::from_str_radix(&digits[..digits.len().min(6)],
                        16).unwrap();
            let alpha =
                if digits.len() == 8 {
                    u8::from_str_radix(&digits[6..], 16).unwrap() as f64 / 255.0
                } else { 1.0 };
            return CssColor { rgb, alpha };
        }
    }
    // RegExp::match searches anywhere and rgb(a) is tried before color(srgb).
    for (i, _) in css.match_indices("rgb") {
        let tail = &css[i..];
        let prefix =
            if tail.starts_with("rgba(") {
                5
            } else if tail.starts_with("rgb(") { 4 } else { continue };
        if let Some(c) = functional(css, i + prefix, false) { return c; }
    }
    for (i, _) in css.match_indices("color(srgb") {
        if let Some(c) = functional(css, i + 10, true) { return c; }
    }
    CssColor::default()
}

pub(crate) fn blend(c: CssColor, under: i32) -> i32 {
    if c.alpha >= 1.0 { return c.rgb; }
    let m =
        |s|
            ((c.rgb >> s) & 255) as f64 * c.alpha +
                ((under >> s) & 255) as f64 * (1.0 - c.alpha);
    pack(m(16), m(8), m(0))
}

pub(crate) fn average(img: &Image, x0: usize, y0: usize, w: usize, h: usize)
    -> i32 {
    let (mut r, mut g, mut b, mut n) = (0.0, 0.0, 0.0, 0.0);
    for y in y0..img.height.min(y0 + h) {
        for x in x0..img.width.min(x0 + w) {
            let i = (y * img.width + x) * 4;
            r += img.data[i] as f64;
            g += img.data[i + 1] as f64;
            b += img.data[i + 2] as f64;
            n += 1.0;
        }
    }
    if n == 0.0 { 0 } else { pack(r / n, g / n, b / n) }
}
pub(crate) fn dominant(img: &Image, x0: usize, y0: usize, w: usize, h: usize)
    -> i32 {
    // Insertion-ordered, like JS Map. Most cells have very few distinct bins.
    let mut bins: Vec<(usize, [f64; 4])> = Vec::new();
    for y in y0..img.height.min(y0 + h) {
        for x in x0..img.width.min(x0 + w) {
            let i = (y * img.width + x) * 4;
            let d = &img.data[i..];
            let k =
                ((d[0] as usize >> 4) << 8) | ((d[1] as usize >> 4) << 4) |
                    (d[2] as usize >> 4);
            let j =
                bins.iter().position(|(key, _)|
                            *key ==
                                k).unwrap_or_else(||
                        { bins.push((k, [0.0; 4])); bins.len() - 1 });
            bins[j].1[0] += 1.0;
            for c in 0..3 { bins[j].1[c + 1] += d[c] as f64; }
        }
    }
    let mut best = [0.0; 4];
    for (_, e) in bins { if e[0] > best[0] { best = e; } }
    if best[0] == 0.0 {
        0
    } else { pack(best[1] / best[0], best[2] / best[0], best[3] / best[0]) }
}

pub(crate) fn single_width(ch: char) -> char {
    let c = ch as u32;
    if c < 32 || (0x7f..0xa0).contains(&c) ||
            crate::unicode_marks::is_mark_or_format(c) {
        return ' ';
    }
    if c > 0xffff ||
            [(0x1100, 0x115f), (0x2e80, 0xa4cf), (0xac00, 0xd7a3),
                            (0xf900, 0xfaff), (0xfe30, 0xfe4f), (0xff00, 0xff60),
                            (0xffe0, 0xffe6)].iter().any(|&(a, b)| c >= a && c <= b) {
        '?'
    } else { ch }
}
