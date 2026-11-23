use crate::{Image, color::*, fit::*};
use std::sync::OnceLock;

pub(crate) fn lattice_of(r: f64, g: f64, b: f64) -> usize {
    let level = |v| js_round(v / 17.0).clamp(0.0, 15.0) as usize;
    (level(r) << 8) | (level(g) << 4) | level(b)
}
pub(crate) fn lattice_color(i: usize) -> i32 {
    ((((i >> 8) & 15) * 17) << 16 | (((i >> 4) & 15) * 17) << 8 |
                (i & 15) * 17) as i32
}
fn toe(x: f64) -> f64 {
    let k3 = (1.0 + 0.206) / (1.0 + 0.03);
    0.5 *
        (k3 * x - 0.206 +
                ((k3 * x - 0.206).powi(2) + 4.0 * 0.03 * k3 * x).sqrt())
}
fn ok_of_srgb(r: f64, g: f64, b: f64) -> [f64; 3] {
    let lin =
        |v: f64|
            {
                let x = v / 255.0;
                if x <= 0.04045 {
                    x / 12.92
                } else { ((x + 0.055) / 1.055).powf(2.4) }
            };
    let (r, g, b) = (lin(r), lin(g), lin(b));
    let l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b).cbrt();
    let m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b).cbrt();
    let s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b).cbrt();
    [toe(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s),
            1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
fn oklab() -> &'static [[f32; 3]] {
    static TABLE: OnceLock<Vec<[f32; 3]>> = OnceLock::new();
    TABLE.get_or_init(||
            (0..4096).map(|i|
                        ok_of_srgb((((i >> 8) & 15) * 17) as f64,
                                (((i >> 4) & 15) * 17) as f64,
                                ((i & 15) * 17) as f64).map(|x| x as f32)).collect())
}
fn dist(ok: &[[f32; 3]], i: usize, j: usize) -> f64 {
    (ok[i][0] as f64 - ok[j][0] as f64).powi(2) +
            (ok[i][1] as f64 - ok[j][1] as f64).powi(2) +
        (ok[i][2] as f64 - ok[j][2] as f64).powi(2)
}
#[derive(Clone,Debug)]
pub(crate) struct Palette {
    pub hist: Vec<f32>,
    pub centers: Vec<usize>,
    rgb: Vec<[f32; 3]>,
    ok: Vec<[f32; 3]>,
    near: Vec<i16>,
    pub frames: usize,
}
impl Default for Palette {
    fn default() -> Self {
        Self {
            hist: vec![0.0;4096],
            centers: vec![],
            rgb: vec![],
            ok: vec![],
            near: vec![],
            frames: 0,
        }
    }
}
impl Palette {
    pub fn color(&self, j: usize) -> i32 { lattice_color(self.centers[j]) }
    pub fn learn(&mut self, s: &Gather, nf: Option<f64>) {
        if let Some(nf) = nf {
            let nb = s.n - nf;
            let k = lattice_of(s.sf[0] / nf, s.sf[1] / nf, s.sf[2] / nf);
            self.hist[k] = (self.hist[k] as f64 + nf) as f32;
            let k =
                lattice_of((s.t[0] - s.sf[0]) / nb, (s.t[1] - s.sf[1]) / nb,
                    (s.t[2] - s.sf[2]) / nb);
            self.hist[k] = (self.hist[k] as f64 + nb) as f32;
        } else {
            let k = lattice_of(s.t[0] / s.n, s.t[1] / s.n, s.t[2] / s.n);
            self.hist[k] = (self.hist[k] as f64 + s.n) as f32;
        }
    }
    pub fn update(&mut self, iters: usize) {
        let ok = oklab();
        let mut pts = Vec::new();
        let mut wts = Vec::new();
        for i in 0..4096 {
            if self.hist[i] > 0.5 {
                pts.push(i);
                wts.push((self.hist[i] as f64).sqrt());
            }
        }
        if pts.is_empty() { pts.push(0); wts.push(1.0); }
        let top_up =
            |centers: &mut Vec<usize>|
                {
                    let mut min_d: Vec<f64> =
                        pts.iter().map(|&p|
                                    centers.iter().map(|&c|
                                                dist(ok, p, c)).fold(f64::INFINITY, f64::min)).collect();
                    while centers.len() < 48.min(pts.len() + 1) {
                        let mut best = None;
                        let mut best_v = 0.0;
                        for k in 0..pts.len() {
                            let v = wts[k] * min_d[k];
                            if v > best_v { best_v = v; best = Some(k); }
                        }
                        let Some(best) = best else { break; };
                        let c = pts[best];
                        centers.push(c);
                        for k in 0..pts.len() {
                            min_d[k] = min_d[k].min(dist(ok, pts[k], c));
                        }
                    }
                };
        let mut centers =
            if self.centers.is_empty() {
                vec![0]
            } else { self.centers.clone() };
        top_up(&mut centers);
        for _ in 0..iters {
            let mut acc = vec![[0.0;4];centers.len()];
            for k in 0..pts.len() {
                let p = pts[k];
                let mut j = 0;
                let mut bd = f64::INFINITY;
                for (c, &center) in centers.iter().enumerate() {
                    let dd = dist(ok, p, center);
                    if dd < bd { bd = dd; j = c; }
                }
                for z in 0..3 { acc[j][z] += wts[k] * ok[p][z] as f64; }
                acc[j][3] += wts[k];
            }
            for c in 1..centers.len() {
                let [l, a, b, w] = acc[c];
                if w <= 0.0 { continue; }
                let mut best_p = centers[c];
                let mut bd = f64::INFINITY;
                for (i, o) in ok.iter().enumerate() {
                    let dd =
                        (o[0] as f64 - l / w).powi(2) +
                                (o[1] as f64 - a / w).powi(2) +
                            (o[2] as f64 - b / w).powi(2);
                    if dd < bd { bd = dd; best_p = i; }
                }
                centers[c] = best_p;
            }
            let mut unique = Vec::new();
            for c in centers { if !unique.contains(&c) { unique.push(c); } }
            centers = unique;
            top_up(&mut centers);
        }
        self.centers = centers;
        self.rgb =
            self.centers.iter().map(|&c|
                        [(((c >> 8) & 15) * 17) as f32,
                                (((c >> 4) & 15) * 17) as f32,
                                ((c & 15) * 17) as f32]).collect();
        self.ok = self.centers.iter().map(|&c| ok[c]).collect();
        self.near = vec![-1;1<<18];
    }
    fn pick(&mut self, m: [f64; 3]) -> (usize, f64) {
        let bin =
            ((int32(m[0]) >> 2) << 12) | ((int32(m[1]) >> 2) << 6) |
                (int32(m[2]) >> 2);
        let mut j = self.near[bin as usize];
        if j < 0 {
            let [l, a, b] =
                ok_of_srgb(((int32(m[0]) & !3) + 2) as f64,
                    ((int32(m[1]) & !3) + 2) as f64,
                    ((int32(m[2]) & !3) + 2) as f64);
            let mut d = f64::INFINITY;
            for (k, o) in self.ok.iter().enumerate() {
                let dd =
                    (l - o[0] as f64).powi(2) + (a - o[1] as f64).powi(2) +
                        (b - o[2] as f64).powi(2);
                if dd < d { d = dd; j = k as i16; }
            }
            self.near[bin as usize] = j;
        }
        let rgb = self.rgb[j as usize];
        let e =
            0.9 * (m[0] - rgb[0] as f64).powi(2) +
                    1.8 * (m[1] - rgb[1] as f64).powi(2) +
                0.3 * (m[2] - rgb[2] as f64).powi(2);
        (j as usize, e)
    }
}
pub(crate) struct PhotoFit {
    pub index: i16,
    pub fg: usize,
    pub bg: usize,
    pub flat: usize,
    pub gain: f64,
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn fit_photo(s: &mut Gather, img: &Image, x: usize, y: usize,
    c: &Candidates, prev: i16, pal: &mut Palette, parts: &[usize])
    -> PhotoFit {
    s.gather(img, x, y, c, PHOTO_WEIGHTS);
    let flat_j = s.flat();
    let (flat_idx, flat_e) =
        pal.pick([s.t[0] / s.n, s.t[1] / s.n, s.t[2] / s.n]);
    let flat_score = flat_j - s.n * flat_e;
    let (mut best, mut best_score, mut best_f, mut best_b) =
        (-1, flat_score, flat_idx, flat_idx);
    let (mut prev_score, mut prev_f, mut prev_b) = (f64::NEG_INFINITY, 0, 0);
    let (mut free_best, mut free_best_j) = (None, flat_j);
    let mut free_j = Vec::with_capacity(parts.len());
    let mut top: Vec<usize> = Vec::with_capacity(9);
    for (i, &k) in parts.iter().enumerate() {
        let j = s.fit(&c.all[k]);
        free_j.push(j);
        if j > free_best_j { free_best_j = j; free_best = Some(k); }
        let mut at = top.len();
        while at > 0 && free_j[top[at - 1]] < j { at -= 1; }
        if at < 8 { top.insert(at, i); top.truncate(8); }
    }
    let prev_at =
        if prev >= 0 {
            parts.iter().position(|&p| p == prev as usize)
        } else { None };
    let mut prev_in = false;
    let tops = top.len();
    for t in 0..=tops {
        let i = if t < tops { Some(top[t]) } else { prev_at };
        let Some(i) = i else { continue; };
        if t == tops && prev_in { continue; }
        let k = parts[i];
        if k as i16 == prev { prev_in = true; }
        let cand = &c.all[k];
        let j = s.fit(cand);
        let nf = cand.nf;
        let nb = s.n - nf;
        let (jf, ef) = pal.pick([s.sf[0] / nf, s.sf[1] / nf, s.sf[2] / nf]);
        let (jb, eb) =
            pal.pick([(s.t[0] - s.sf[0]) / nb, (s.t[1] - s.sf[1]) / nb,
                        (s.t[2] - s.sf[2]) / nb]);
        if jf == jb { continue; }
        let score = j - nf * ef - nb * eb;
        if k as i16 == prev { prev_score = score; prev_f = jf; prev_b = jb; }
        if score > best_score {
            best_score = score;
            best = k as i16;
            best_f = jf;
            best_b = jb;
        }
    }
    if prev >= 0 && prev_score - flat_score >= 0.8 * (best_score - flat_score)
        {
        best = prev;
        best_score = prev_score;
        best_f = prev_f;
        best_b = prev_b;
    }
    let threshold = if prev >= 0 { 0.6 * 3.0 } else { 3.0 };
    if best >= 0 && (best_score - flat_score) / s.n < threshold { best = -1; }
    if let Some(k) = free_best {
        s.fit(&c.all[k]);
        pal.learn(s, Some(c.all[k].nf));
    } else { pal.learn(s, None); }
    if best < 0 {
        PhotoFit {
            index: -1,
            fg: flat_idx,
            bg: flat_idx,
            flat: flat_idx,
            gain: 0.0,
        }
    } else {
        PhotoFit {
            index: best,
            fg: best_f,
            bg: best_b,
            flat: flat_idx,
            gain: best_score - flat_score,
        }
    }
}
