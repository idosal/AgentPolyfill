use crate::{Image, color::*};

const QUADRANTS: [char; 16] =
    [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚',
            '▐', '▜', '▄', '▙', '▟', '█'];
pub(crate) const PHOTO_WEIGHTS: [f64; 3] = [0.9, 1.8, 0.3];
#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub ch: char,
    pub complement: Option<char>,
    pub kind: u8,
    pub mask: usize,
    pub a: usize,
    pub b: usize,
    pub nf: f64,
}
pub(crate) struct Candidates {
    pub all: Vec<Candidate>,
    pub hx: usize,
    pub hy: usize,
    pub t1: usize,
    pub t2: usize,
    pub cw: usize,
    pub ch: usize,
}
impl Candidates {
    pub fn new(cw: usize, ch: usize) -> Self {
        let (hx, hy) = (cw >> 1, ch >> 1);
        let area =
            [hx * hy, (cw - hx) * hy, hx * (ch - hy), (cw - hx) * (ch - hy)];
        let mut all = Vec::new();
        for mask in 1..15 {
            let nf =
                (0..4).filter(|k|
                                    mask & (1 << k) != 0).map(|k| area[k]).sum::<usize>() as
                    f64;
            all.push(Candidate {
                    ch: QUADRANTS[mask],
                    complement: Some(QUADRANTS[mask ^ 15]),
                    kind: 0,
                    mask,
                    a: 0,
                    b: 0,
                    nf,
                });
        }
        let eh = |k| js_round((ch * k) as f64 / 8.0).max(1.0) as usize;
        let ew = |k| js_round((cw * k) as f64 / 8.0).max(1.0) as usize;
        for k in [1, 2, 3, 5, 6, 7] {
            all.push(Candidate {
                    ch: char::from_u32(0x2580 + k as u32).unwrap(),
                    complement: if k == 7 { Some('▔') } else { None },
                    kind: 1,
                    mask: 0,
                    a: ch - eh(k),
                    b: ch,
                    nf: (eh(k) * cw) as f64,
                });
            all.push(Candidate {
                    ch: char::from_u32(0x2590 - k as u32).unwrap(),
                    complement: if k == 7 { Some('▕') } else { None },
                    kind: 2,
                    mask: 0,
                    a: 0,
                    b: ew(k),
                    nf: (ew(k) * ch) as f64,
                });
        }
        all.push(Candidate {
                ch: '▔',
                complement: Some('▇'),
                kind: 1,
                mask: 0,
                a: 0,
                b: eh(1),
                nf: (eh(1) * cw) as f64,
            });
        all.push(Candidate {
                ch: '▕',
                complement: Some('▉'),
                kind: 2,
                mask: 0,
                a: cw - ew(1),
                b: cw,
                nf: (ew(1) * ch) as f64,
            });
        let t1 = js_round(ch as f64 / 3.0) as usize;
        let t2 = js_round(2.0 * ch as f64 / 3.0) as usize;
        let area =
            [hx * t1, (cw - hx) * t1, hx * (t2 - t1), (cw - hx) * (t2 - t1),
                    hx * (ch - t2), (cw - hx) * (ch - t2)];
        for mask in 1..63 {
            if mask == 21 || mask == 42 { continue; }
            let nf =
                (0..6).filter(|k|
                                    mask & (1 << k) != 0).map(|k| area[k]).sum::<usize>() as
                    f64;
            all.push(Candidate {
                    ch: sextant(mask),
                    complement: Some(sextant(63 - mask)),
                    kind: 3,
                    mask,
                    a: 0,
                    b: 0,
                    nf,
                });
        }
        Self { all, hx, hy, t1, t2, cw, ch }
    }
    pub fn list(&self) -> &[Candidate] { &self.all[..28] }
    pub fn partitions(&self, sextants: bool) -> Vec<usize> {
        self.all.iter().enumerate().filter_map(|(k, c)|
                    {
                        (if c.kind == 3 {
                                    sextants && c.mask < 32
                                } else if c.kind == 0 {
                                    c.mask <= 7
                                } else { c.ch == '▇' || c.ch == '▉' }).then_some(k)
                    }).collect()
    }
}
fn sextant(mask: usize) -> char {
    match mask {
        21 => '▌',
        42 => '▐',
        63 => '█',
        _ =>
            char::from_u32(0x1fb00 + mask as u32 - 1 - u32::from(mask > 21) -
                        u32::from(mask > 42)).unwrap(),
    }
}

pub(crate) struct Gather {
    row: Vec<f64>,
    col: Vec<f64>,
    quad: [f64; 12],
    sext: [f64; 18],
    pub sf: [f64; 3],
    pub t: [f64; 3],
    pub n: f64,
    pub w: [f64; 3],
}
impl Gather {
    pub fn new(c: &Candidates) -> Self {
        Self {
            row: vec![0.0; (c.ch+1)*3],
            col: vec![0.0; (c.cw+1)*3],
            quad: [0.0; 12],
            sext: [0.0; 18],
            sf: [0.0; 3],
            t: [0.0; 3],
            n: (c.cw * c.ch) as f64,
            w: [1.0; 3],
        }
    }
    pub fn gather(&mut self, img: &Image, x0: usize, y0: usize,
        c: &Candidates, w: [f64; 3]) {
        self.row.fill(0.0);
        self.col.fill(0.0);
        self.quad.fill(0.0);
        self.sext.fill(0.0);
        for y in 0..c.ch {
            let py = (y0 + y).min(img.height - 1);
            let qy = if y < c.hy { 0 } else { 6 };
            let sy = if y < c.t1 { 0 } else if y < c.t2 { 6 } else { 12 };
            let mut sum = [0.0; 3];
            for x in 0..c.cw {
                let px = (x0 + x).min(img.width - 1);
                let i = (py * img.width + px) * 4;
                let q = qy + if x < c.hx { 0 } else { 3 };
                let e = sy + if x < c.hx { 0 } else { 3 };
                for (k, sum) in sum.iter_mut().enumerate() {
                    let v = img.data[i + k] as f64;
                    *sum += v;
                    self.col[(x + 1) * 3 + k] += v;
                    self.quad[q + k] += v;
                    self.sext[e + k] += v;
                }
            }
            for (k, v) in sum.iter().enumerate() {
                self.row[(y + 1) * 3 + k] = self.row[y * 3 + k] + v;
            }
        }
        for x in 1..=c.cw {
            for k in 0..3 {
                self.col[x * 3 + k] += self.col[(x - 1) * 3 + k];
            }
        }
        self.t.copy_from_slice(&self.row[c.ch * 3..c.ch * 3 + 3]);
        self.w = w;
    }
    pub fn fit(&mut self, c: &Candidate) -> f64 {
        self.sf.fill(0.0);
        if c.kind == 0 || c.kind == 3 {
            let (parts, max) =
                if c.kind == 3 {
                    (&self.sext[..], 6)
                } else { (&self.quad[..], 4) };
            for k in 0..max {
                if c.mask & (1 << k) != 0 {
                    for j in 0..3 { self.sf[j] += parts[k * 3 + j]; }
                }
            }
        } else {
            let p = if c.kind == 1 { &self.row } else { &self.col };
            for k in 0..3 { self.sf[k] = p[c.b * 3 + k] - p[c.a * 3 + k]; }
        }
        let [a, b, cw] = self.w;
        let [r, g, bv] = self.sf;
        let [tr, tg, tb] = self.t;
        (a * r * r + b * g * g + cw * bv * bv) / c.nf +
            (a * (tr - r).powi(2) + b * (tg - g).powi(2) +
                        cw * (tb - bv).powi(2)) / (self.n - c.nf)
    }
    pub fn flat(&self) -> f64 {
        let [a, b, c] = self.w;
        let [r, g, bv] = self.t;
        (a * r * r + b * g * g + c * bv * bv) / self.n
    }
    pub fn colors(&self, nf: f64) -> (i32, i32) {
        let nb = self.n - nf;
        (pack(self.sf[0] / nf, self.sf[1] / nf, self.sf[2] / nf),
            pack((self.t[0] - self.sf[0]) / nb, (self.t[1] - self.sf[1]) / nb,
                (self.t[2] - self.sf[2]) / nb))
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Fit {
    pub index: i16,
    pub glyph: Option<char>,
    pub fg: i32,
    pub bg: i32,
    pub mean: i32,
    pub alt: Option<Option<Box<Fit>>>,
}
impl Fit {
    fn new(index: i16, fg: i32, bg: i32, mean: i32) -> Self {
        Self { index, fg, bg, mean, glyph: None, alt: None }
    }
    fn flat(c: i32) -> Self { Self::new(-1, c, c, c) }
}
pub(crate) fn fit_cell(s: &mut Gather, img: &Image, x: usize, y: usize,
    c: &Candidates, photo: bool) -> Fit {
    s.gather(img, x, y, c, if photo { PHOTO_WEIGHTS } else { [1.0; 3] });
    let flat = s.flat();
    let mut best = -1;
    let mut best_j = flat;
    for (k, cand) in c.list().iter().enumerate() {
        let j = s.fit(cand);
        if j > best_j { best_j = j; best = k as i16; }
    }
    let mean = pack(s.t[0] / s.n, s.t[1] / s.n, s.t[2] / s.n);
    if best < 0 || (best_j - flat) / s.n < if photo { 3.0 } else { 45.0 } {
        return Fit::flat(mean);
    }
    let cand = &c.list()[best as usize];
    s.fit(cand);
    let (fg, bg) = s.colors(cand.nf);
    Fit::new(best, fg, bg, mean)
}

pub(crate) struct Ui {
    key: [i32; 32],
    n: [i32; 32],
    r: [f64; 32],
    g: [f64; 32],
    b: [f64; 32],
    top: [i32; 32],
    left: [i32; 32],
    side: [u8; 32],
    bin: Vec<u8>,
    row_on: Vec<i32>,
    col_on: Vec<i32>,
    quad_on: [i32; 4],
    pub prev: u16,
    soft: [u8; 32],
    row_soft: Vec<i32>,
    col_soft: Vec<i32>,
    share: [f32; 32],
    inked: bool,
}
impl Ui {
    pub fn new(c: &Candidates) -> Self {
        Self {
            key: [0; 32],
            n: [0; 32],
            r: [0.0; 32],
            g: [0.0; 32],
            b: [0.0; 32],
            top: [0; 32],
            left: [0; 32],
            side: [0; 32],
            bin: vec![0;c.cw*c.ch],
            row_on: vec![0;c.ch],
            col_on: vec![0;c.cw],
            quad_on: [0; 4],
            prev: 0,
            soft: [0; 32],
            row_soft: vec![0;c.ch],
            col_soft: vec![0;c.cw],
            share: [0.0; 32],
            inked: false,
        }
    }
    fn color(&self, k: usize) -> i32 { pack(self.r[k], self.g[k], self.b[k]) }
    pub fn fit(&mut self, img: &Image, x0: usize, y0: usize, c: &Candidates,
        ink: i32, ink_top: i64, ink_bottom: i64) -> Option<Fit> {
        let (cw, ch) = (c.cw, c.ch);
        let mut bins = 0;
        self.inked = ink >= 0;
        for y in 0..ch {
            for x in 0..cw {
                let i =
                    ((y0 + y).min(img.height - 1) * img.width +
                                (x0 + x).min(img.width - 1)) * 4;
                let d = &img.data[i..];
                let key =
                    ((d[0] as i32 >> 4) << 8) | ((d[1] as i32 >> 4) << 4) |
                            (d[2] as i32 >> 4) |
                        if self.inked && y as i64 >= ink_top &&
                                (y as i64) < ink_bottom {
                            4096
                        } else { 0 };
                let mut k = 0;
                while k < bins && self.key[k] != key { k += 1; }
                if k == bins {
                    if bins == 32 { return None; }
                    self.key[k] = key;
                    self.n[k] = 0;
                    self.top[k] = 0;
                    self.left[k] = 0;
                    self.r[k] = 0.0;
                    self.g[k] = 0.0;
                    self.b[k] = 0.0;
                    bins += 1;
                }
                self.bin[y * cw + x] = k as u8;
                self.n[k] += 1;
                if y < c.hy { self.top[k] += 1; }
                if x < c.hx { self.left[k] += 1; }
                self.r[k] += d[0] as f64;
                self.g[k] += d[1] as f64;
                self.b[k] += d[2] as f64;
            }
        }
        for k in 0..bins {
            self.r[k] /= self.n[k] as f64;
            self.g[k] /= self.n[k] as f64;
            self.b[k] /= self.n[k] as f64;
            self.side[k] = 0;
        }
        let (ir, ig, ib) =
            (((ink >> 16) & 255) as f64, ((ink >> 8) & 255) as f64,
                (ink & 255) as f64);
        if self.inked {
            for k in 0..bins {
                if self.key[k] >= 4096 &&
                        (self.r[k] -
                                                ir).abs().max((self.g[k] -
                                                ig).abs()).max((self.b[k] - ib).abs()) <= 40.0 {
                    self.side[k] = 3;
                }
            }
        }
        let a =
            (0..bins).filter(|&k|
                            self.side[k] !=
                                3).fold(None,
                    |a: Option<usize>, k|
                        if a.is_none_or(|a| self.n[k] > self.n[a]) {
                            Some(k)
                        } else { a })?;
        let (ar, ag, ab) = (self.r[a], self.g[a], self.b[a]);
        if self.inked {
            let (er, eg, eb) = (ir - ar, ig - ag, ib - ab);
            let ee = er * er + eg * eg + eb * eb;
            for k in 0..bins {
                if ee <= 0.0 { break; }
                if k == a || self.side[k] == 3 || self.key[k] < 4096 {
                    continue;
                }
                let (dr, dg, db) =
                    (self.r[k] - ar, self.g[k] - ag, self.b[k] - ab);
                let t = (dr * er + dg * eg + db * eb) / ee;
                if t > 0.1 &&
                        dr * dr + dg * dg + db * db - t * t * ee < 24.0 * 24.0 {
                    self.side[k] = 3;
                }
            }
        }
        let first = self.color(a);
        for _ in 0..3 {
            let mut b = None;
            let mut weight = 0.0;
            for k in 0..bins {
                if k == a || self.side[k] >= 3 { continue; }
                let (dr, dg, db) =
                    (self.r[k] - ar, self.g[k] - ag, self.b[k] - ab);
                if dr.abs().max(dg.abs()).max(db.abs()) < 10.0 { continue; }
                let w = self.n[k] as f64 * (dr * dr + dg * dg + db * db);
                if w > weight { weight = w; b = Some(k); }
            }
            let Some(b) = b else { return Some(Fit::flat(first)); };
            let (br, bg, bb) = (self.r[b], self.g[b], self.b[b]);
            let (er, eg, eb) = (br - ar, bg - ag, bb - ab);
            let ee = er * er + eg * eg + eb * eb;
            let second = self.color(b);
            let reach = 0.3 * ee;
            let mut third = 0;
            let mut mass = 0.0;
            for k in 0..bins {
                self.soft[k] = 0;
                self.share[k] = 0.0;
                if self.side[k] >= 3 { continue; }
                self.side[k] = 0;
                let (dr, dg, db) =
                    (self.r[k] - ar, self.g[k] - ag, self.b[k] - ab);
                let dd = dr * dr + dg * dg + db * db;
                let t = (dr * er + dg * eg + db * eb) / ee;
                if t >= 0.3 && dd - t * t * ee <= 0.15 * ee {
                    self.soft[k] = 1;
                    self.share[k] = t.min(1.0) as f32;
                    mass += self.n[k] as f64 * self.share[k] as f64;
                }
                if (self.r[k] - br).powi(2) + (self.g[k] - bg).powi(2) +
                            (self.b[k] - bb).powi(2) <= reach {
                    self.side[k] = 1;
                } else if dd > reach { self.side[k] = 2; third += self.n[k]; }
            }
            self.row_on.fill(0);
            self.col_on.fill(0);
            self.row_soft.fill(0);
            self.col_soft.fill(0);
            self.quad_on.fill(0);
            let (mut on, mut soft_n) = (0, 0);
            for y in 0..ch {
                for x in 0..cw {
                    let k = self.bin[y * cw + x] as usize;
                    if self.soft[k] != 0 {
                        soft_n += 1;
                        self.row_soft[y] += 1;
                        self.col_soft[x] += 1;
                    }
                    if self.side[k] != 1 { continue; }
                    on += 1;
                    self.row_on[y] += 1;
                    self.col_on[x] += 1;
                    self.quad_on[if y < c.hy { 0 } else { 2 } +
                                if x < c.hx { 0 } else { 1 }] += 1;
                }
            }
            if let Some(fit) =
                    self.fit_mask(c, bins, on, third, soft_n, mass, first,
                        second) {
                return Some(fit);
            }
            for k in 0..bins {
                if self.side[k] == 1 || self.soft[k] != 0 {
                    self.side[k] = 4;
                }
            }
            self.side[a] = 0;
        }
        Some(Fit::flat(first))
    }
    fn stripe(&self, horizontal: bool, centre: f64, len: usize, e: usize,
        band: i32, rest: i32, mean: i32) -> Fit {
        let len = len as f64;
        let hold =
            if self.prev == 0x2501 || self.prev == 0x2503 {
                len / 8.0
            } else if self.prev > 0x2580 && self.prev < 0x2596 {
                -len / 8.0
            } else { 0.0 };
        if e == 1 && (centre - len / 2.0).abs() <= len / 5.0 + hold {
            let mut f = Fit::new(-1, band, rest, mean);
            f.glyph = Some(if horizontal { '━' } else { '┃' });
            return f;
        }
        let (index, fg, bg) =
            if horizontal {
                if centre < len / 2.0 {
                    if e == 1 {
                        (26, band, rest)
                    } else { (lower_bar(8 - e), rest, band) }
                } else { (lower_bar(e), band, rest) }
            } else if centre < len / 2.0 {
                (left_bar(e), band, rest)
            } else if e == 1 {
                (27, band, rest)
            } else { (left_bar(8 - e), rest, band) };
        Fit::new(index, fg, bg, mean)
    }
    #[allow(clippy::too_many_arguments)]
    fn fit_mask(&self, c: &Candidates, bins: usize, on: i32, third: i32,
        soft_n: i32, mass: f64, first: i32, second: i32) -> Option<Fit> {
        let n = (c.cw * c.ch) as i32;
        let wrong = on.min(n - on);
        let mean = if on * 2 > n { second } else { first };
        if on * 2 > n && n - on < 6 { return Some(Fit::flat(second)); }
        if wrong.max(soft_n) < 6 { return None; }
        if wrong >= 6 {
            for want in [1, 0] {
                let (band, rest) =
                    if want == 1 { (second, first) } else { (first, second) };
                if let Some((start, size)) =
                        interior_band(&self.row_on, c.ch, c.cw, want) {
                    return Some(self.stripe(true,
                                start as f64 + size as f64 / 2.0, c.ch,
                                eighths(if want == 1 {
                                        (size as f64).min(mass / c.cw as f64)
                                    } else { size as f64 }, c.ch, 4), band, rest, mean));
                }
                if let Some((start, size)) =
                        interior_band(&self.col_on, c.cw, c.ch, want) {
                    return Some(self.stripe(false,
                                start as f64 + size as f64 / 2.0, c.cw,
                                eighths(if want == 1 {
                                        (size as f64).min(mass / c.ch as f64)
                                    } else { size as f64 }, c.cw, 4), band, rest, mean));
                }
            }
        }
        if !self.inked {
            let dots =
                if third as f64 <= 0.05 * n as f64 {
                    self.sloped_line(c, mass)
                } else { 0 };
            if dots != 0 {
                let rest = self.fit_rest(c, bins, on, third, soft_n, mass,
                    first, second, wrong, mean);
                let mut f = Fit::new(-1, second, first, first);
                f.glyph = char::from_u32(0x2800 + dots);
                f.alt = Some(rest.map(Box::new));
                return Some(f);
            }
        }
        self.fit_rest(c, bins, on, third, soft_n, mass, first, second,
            wrong, mean)
    }
    #[allow(clippy::too_many_arguments)]
    fn fit_rest(&self, c: &Candidates, bins: usize, on: i32, third: i32,
        soft_n: i32, mass: f64, first: i32, second: i32, wrong: i32,
        mean: i32) -> Option<Fit> {
        let n = (c.cw * c.ch) as i32;
        if third as f64 > 0.12 * n as f64 {
            let (mut t, mut bo, mut l, mut r) = (None, None, None, None);
            for k in 0..bins {
                if self.side[k] == 3 { continue; }
                if t.is_none_or(|t| self.top[k] > self.top[t]) {
                    t = Some(k);
                }
                if bo.is_none_or(|bo|
                            self.n[k] - self.top[k] > self.n[bo] - self.top[bo]) {
                    bo = Some(k);
                }
                if l.is_none_or(|l| self.left[k] > self.left[l]) {
                    l = Some(k);
                }
                if r.is_none_or(|r|
                            self.n[k] - self.left[k] > self.n[r] - self.left[r]) {
                    r = Some(k);
                }
            }
            let (t, bo, l, r) =
                (t.unwrap(), bo.unwrap(), l.unwrap(), r.unwrap());
            let vertical =
                self.top[t] + self.n[bo] - self.top[bo] >=
                    self.left[l] + self.n[r] - self.left[r];
            let (p, q) = if vertical { (t, bo) } else { (l, r) };
            if p == q { return Some(Fit::flat(self.color(p))); }
            return Some(if vertical {
                        Fit::new(11, self.color(q), self.color(p), first)
                    } else {
                        Fit::new(4, self.color(p), self.color(q), first)
                    });
        }
        let (mut best, mut best_agree, mut inverted) = (-1, 0.0, false);
        if wrong >= 6 {
            for (k, cand) in c.list().iter().enumerate() {
                let thin =
                    cand.kind != 0 &&
                        (cand.nf * 4.0 <= n as f64 ||
                                cand.nf * 4.0 >= 3.0 * n as f64);
                let mut inside = 0;
                if cand.kind == 0 {
                    for q in 0..4 {
                        if cand.mask & (1 << q) != 0 { inside += self.quad_on[q]; }
                    }
                } else {
                    let counts =
                        if cand.kind == 1 { &self.row_on } else { &self.col_on };
                    inside = counts[cand.a..cand.b].iter().sum();
                }
                let agree =
                    inside as f64 + (n as f64 - cand.nf - (on - inside) as f64);
                let better = agree.max(n as f64 - agree);
                if n as f64 - better >
                        if thin { 0.25 } else { 0.65 } * wrong as f64 {
                    continue;
                }
                if better > best_agree {
                    best_agree = better;
                    best = k as i16;
                    inverted = agree < n as f64 - agree;
                }
            }
        }
        if best >= 0 {
            return Some(if inverted {
                        Fit::new(best, first, second, mean)
                    } else { Fit::new(best, second, first, mean) });
        }
        if soft_n >= 6 && soft_n as f64 <= 0.4 * n as f64 {
            let mut centre = 0.0;
            if self.col_soft.iter().filter(|&&n| n != 0).count() >=
                    c.cw.saturating_sub(1) {
                for y in 0..c.ch {
                    centre += self.row_soft[y] as f64 * (y as f64 + 0.5);
                }
                return Some(self.stripe(true, centre / soft_n as f64, c.ch,
                            eighths(mass / c.cw as f64, c.ch, 2), second, first,
                            first));
            }
            if self.row_soft.iter().filter(|&&n| n != 0).count() >=
                    c.ch.saturating_sub(2) {
                for x in 0..c.cw {
                    centre += self.col_soft[x] as f64 * (x as f64 + 0.5);
                }
                return Some(self.stripe(false, centre / soft_n as f64, c.cw,
                            eighths(mass / c.ch as f64, c.cw, 2), second, first,
                            first));
            }
        }
        if on * 2 > n { Some(Fit::flat(second)) } else { None }
    }
    fn sloped_line(&self, c: &Candidates, mass: f64) -> u32 {
        if mass < 3.0 { return 0; }
        let cols = self.col_soft.iter().filter(|&&n| n != 0).count();
        let rows = self.row_soft.iter().filter(|&&n| n != 0).count();
        let across = cols >= c.cw.saturating_sub(1);
        let down = rows >= c.ch.saturating_sub(2);
        if !across && !down { return 0; }
        let thick = mass / cols.max(rows) as f64;
        if thick > 3.2 { return 0; }
        let mut dots = [0.0; 16];
        let (mut wl, mut yl, mut wr, mut yr, mut wt, mut xt, mut wb, mut xb) =
            (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for y in 0..c.ch {
            let r = (y * 4 / c.ch).min(3);
            for x in 0..c.cw {
                let col = usize::from(x >= c.hx);
                dots[8 + col * 4 + r] += 1.0;
                let w = self.share[self.bin[y * c.cw + x] as usize] as f64;
                if w == 0.0 { continue; }
                dots[col * 4 + r] += w;
                if col == 0 {
                    wl += w;
                    yl += w * y as f64;
                } else { wr += w; yr += w * y as f64; }
                if y < c.hy {
                    wt += w;
                    xt += w * x as f64;
                } else { wb += w; xb += w * x as f64; }
            }
        }
        let even =
            |counts: &[i32]|
                {
                    let mut lo = i32::MAX;
                    let mut hi = 0;
                    for &v in counts {
                        if v == 0 { continue; }
                        lo = lo.min(v);
                        hi = hi.max(v);
                    }
                    hi as i64 - lo as i64 <= 2
                };
        if across &&
                self.col_soft.iter().any(|&v| v as i64 >= c.ch as i64 - 2) {
            return 0;
        }
        if down && self.row_soft.iter().any(|&v| v as i64 >= c.cw as i64 - 1)
            {
            return 0;
        }
        let slant =
            (across && wl != 0.0 && wr != 0.0 &&
                                (yl / wl - yr / wr).abs() >= 0.75) ||
                        (down && !across && wt != 0.0 && wb != 0.0 &&
                                    (xt / wt - xb / wb).abs() >= 0.75 && even(&self.row_soft))
                    || (across && rows as f64 >= 2.0 * thick + 3.0) ||
                (down && !across && cols as f64 >= 2.0 * thick + 2.0 &&
                        even(&self.row_soft));
        if slant { dots_of(&mut dots) } else { 0 }
    }
}
fn lower_bar(k: usize) -> i16 {
    if k == 4 {
        11
    } else {
        14 +
            2 *
                [1, 2, 3, 5, 6, 7].iter().position(|&v| v == k).unwrap() as
                    i16
    }
}
fn left_bar(k: usize) -> i16 {
    if k == 4 {
        4
    } else {
        15 +
            2 *
                [1, 2, 3, 5, 6, 7].iter().position(|&v| v == k).unwrap() as
                    i16
    }
}
fn eighths(size: f64, len: usize, most: usize) -> usize {
    ((size * 8.0 / len as f64 + 0.3).floor() as usize).max(1).min(most)
}
fn interior_band(counts: &[i32], len: usize, across: usize, want: i32)
    -> Option<(usize, usize)> {
    let mut base = across as i32;
    for &v in counts { base = base.min(v); }
    if base as f64 > across as f64 / 2.0 { base = 0; }
    let (mut start, mut end, mut runs) = (0, usize::MAX, 0);
    for (i, &v) in counts.iter().enumerate() {
        if v > base + 1 && (v as i64) < across as i64 - 1 { return None; }
        let on = i32::from(v as i64 >= across as i64 - 1);
        if on == want {
            if i == 0 || end != i { runs += 1; start = i; }
            end = i + 1;
        }
    }
    if runs != 1 || (end - start) as f64 > len as f64 / 2.0 {
        None
    } else { Some((start, end - start)) }
}
fn dots_of(cov: &mut [f64; 16]) -> u32 {
    const BITS: [u32; 8] = [1, 2, 4, 0x40, 8, 0x10, 0x20, 0x80];
    let mut bits = 0;
    for c in 0..2 {
        let mut most: f64 = 0.0;
        for r in 0..4 {
            let f = cov[c * 4 + r] / cov[8 + c * 4 + r].max(1.0);
            cov[c * 4 + r] = f;
            most = most.max(f);
        }
        if most < 0.12 { continue; }
        for r in 0..4 {
            if cov[c * 4 + r] >= 0.12_f64.max(0.45 * most) {
                bits |= BITS[c * 4 + r];
            }
        }
    }
    bits
}
