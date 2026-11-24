use std::io::Write;
use std::sync::OnceLock;

use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::{Compression, write::ZlibEncoder};
use serde::{Deserialize, Serialize};

use crate::{Error, Result, decode_png, quantize};

pub const STRIP_ROWS: usize = 6;
pub const PALETTE_MAX_COLOURS: usize = 16384;
pub const PALETTE_MIN_PSNR: f64 = 42.0;

/// Encoding policy, fixed for the lifetime of a view's cache.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncoderOptions {
    pub palette: bool,
}

impl Default for EncoderOptions {
    fn default() -> Self { Self { palette: true } }
}

impl EncoderOptions {
    /// Read `MCP_APPS_CLI_PALETTE`; only the exact value `0` disables palettes.
    pub fn from_env() -> Self {
        Self { palette: std::env::var_os("MCP_APPS_CLI_PALETTE").is_none_or(|v| v != "0") }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Layout { width: usize, height: usize, rows: usize, top: i64 }

#[derive(Debug)]
struct Encoded { idat: Vec<u8>, width: u32, height: u32, palette: Option<Vec<u8>> }

/// One view's bands as last sent: each one's hash (not its pixels, a frame's
/// worth per view) and compressed rows. Drop it when the view closes.
/// `Default` snapshots the palette environment setting once, on first use.
#[derive(Debug)]
pub struct StripState {
    options: EncoderOptions,
    layout: Option<Layout>,
    hashes: Vec<u128>,
    encoded: Vec<Encoded>,
    version: Option<u64>,
}

impl Default for StripState {
    fn default() -> Self {
        static OPTIONS: OnceLock<EncoderOptions> = OnceLock::new();
        Self::new(*OPTIONS.get_or_init(EncoderOptions::from_env))
    }
}

impl StripState {
    pub fn new(options: EncoderOptions) -> Self {
        Self { options, layout: None, hashes: Vec::new(), encoded: Vec::new(), version: None }
    }
}

/// A screenshot and the terminal layout in which it will be displayed.
#[derive(Clone, Copy, Debug)]
pub struct StripJob<'a> {
    pub png: &'a [u8],
    pub rows: usize,
    pub top: i64,
    pub all: bool,
    pub stamp: u64,
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Strip {
    pub i: usize,
    pub rows: usize,
    /// A complete stamped PNG, encoded with standard padded base64.
    pub png: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripResult {
    pub strips: Vec<Strip>,
    pub strip_count: usize,
}

/// Encode changed bands, or all bands when requested or the layout changes.
///
/// Same version and band count: `all` rewraps cached IDAT with the new stamp;
/// otherwise nothing is sent. This shortcut precedes PNG decoding and layout
/// comparison, exactly as in JS. Callers must advance `version` on new captures.
/// `MCP_APPS_CLI_STRIPS` is a caller-side dispatch setting, not an encoder option.
pub fn encode_strips(state: &mut StripState, job: StripJob<'_>) -> Result<StripResult> {
    let count = job.rows.div_ceil(STRIP_ROWS);
    let band_rows = |i: usize| (job.rows - i * STRIP_ROWS).min(STRIP_ROWS);
    if state.version == Some(job.version) && state.encoded.len() == count {
        let strips = if job.all {
            state.encoded.iter().enumerate().map(|(i, encoded)| Strip {
                i, rows: band_rows(i), png: STANDARD.encode(wrap_strip(encoded, job.stamp)),
            }).collect()
        } else { Vec::new() };
        return Ok(StripResult { strips, strip_count: count });
    }
    let image = decode_png(job.png)?;
    let row_px = image.height as f64 / job.rows as f64;
    let layout = Layout { width: image.width, height: image.height, rows: job.rows, top: job.top };
    let changed_layout = state.layout.as_ref() != Some(&layout);
    let all = job.all || changed_layout;
    let mut strips = Vec::new();
    let mut updates = Vec::new();
    for i in 0..count {
        let y0 = (i as f64 * STRIP_ROWS as f64 * row_px).round() as usize;
        let end_row = i * STRIP_ROWS + band_rows(i);
        let y1 = (end_row as f64 * row_px).round() as usize;
        if y1 <= y0 || y1 > image.height {
            return Err(Error::InvalidInput("each strip must contain at least one pixel row"));
        }
        let hash = band_hash(&image.data[y0 * image.width * 4..y1 * image.width * 4]);
        if !all && state.hashes.get(i) == Some(&hash) { continue; }
        let encoded = deflate_strip(&image.data, image.width, y0, y1 - y0, state.options)?;
        strips.push(Strip { i, rows: band_rows(i), png: STANDARD.encode(wrap_strip(&encoded, job.stamp)) });
        updates.push((i, hash, encoded));
    }
    // Commit only after success, so bad input cannot poison a view's cache.
    if changed_layout { state.hashes.clear(); state.encoded.clear(); }
    for (i, hash, encoded) in updates {
        if i == state.encoded.len() {
            state.hashes.push(hash);
            state.encoded.push(encoded);
        } else {
            state.hashes[i] = hash;
            state.encoded[i] = encoded;
        }
    }
    state.layout = Some(layout);
    state.version = Some(job.version);
    Ok(StripResult { strips, strip_count: count })
}

/// A band's pixels, to 128 bits: four lanes, each a bijection of its state
/// per word (so bands that differ in any word differ in that lane), folded
/// at the end. Not cryptographic: a page could only make its own band look
/// unchanged. About as fast as comparing the bytes, without keeping them.
pub(crate) fn band_hash(bytes: &[u8]) -> u128 {
    const P: [u64; 4] = [0x9E37_79B9_7F4A_7C15, 0xC2B2_AE3D_27D4_EB4F, 0x1656_67B1_9E37_79F9, 0xD6E8_FEB8_6659_FD93];
    let mut h: [u64; 4] = [0x243F_6A88_85A3_08D3, 0x1319_8A2E_0370_7344, 0xA409_3822_299F_31D0, 0x082E_FA98_EC4E_6C89];
    let word = |c: &[u8], i: usize| u64::from_le_bytes(c[i * 8..i * 8 + 8].try_into().unwrap());
    let mut chunks = bytes.chunks_exact(32);
    for c in &mut chunks {
        for i in 0..4 {
            h[i] = (h[i] ^ word(c, i)).wrapping_mul(P[i]).rotate_left(31);
        }
    }
    let rest = chunks.remainder();
    let mut tail = [0u8; 32];
    tail[..rest.len()].copy_from_slice(rest);
    for i in 0..4 {
        h[i] = (h[i] ^ word(&tail, i) ^ rest.len() as u64).wrapping_mul(P[i]).rotate_left(31);
    }
    let fold = |a: u64, b: u64| {
        let m = u128::from(a).wrapping_mul(u128::from(b ^ P[0]));
        (m as u64) ^ ((m >> 64) as u64)
    };
    let lo = fold(h[0], h[1]) ^ fold(h[2], h[3]).rotate_left(17) ^ bytes.len() as u64;
    let hi = fold(h[1] ^ P[2], h[2]) ^ fold(h[3], h[0] ^ P[3]).rotate_left(23);
    (u128::from(hi) << 64) | u128::from(lo)
}

fn deflate_strip(data: &[u8], width: usize, y0: usize, height: usize, options: EncoderOptions) -> Result<Encoded> {
    let quantized = if options.palette {
        quantize(data, width, y0, height, Some(PALETTE_MAX_COLOURS))?
            .filter(|q| q.psnr >= PALETTE_MIN_PSNR)
    } else { None };
    let (raw, palette) = if let Some(q) = quantized {
        let mut raw = vec![0; (width + 1) * height];
        for y in 0..height {
            raw[y * (width + 1) + 1..(y + 1) * (width + 1)]
                .copy_from_slice(&q.indices[y * width..(y + 1) * width]);
        }
        (raw, Some(q.palette.into_iter().flatten().collect()))
    } else {
        let stride = width * 4;
        let mut raw = vec![0; (stride + 1) * height];
        for y in 0..height {
            raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)]
                .copy_from_slice(&data[(y0 + y) * stride..(y0 + y + 1) * stride]);
        }
        (raw, None)
    };
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(&raw)?;
    Ok(Encoded { idat: encoder.finish()?, width: width as u32, height: height as u32, palette })
}

fn wrap_strip(encoded: &Encoded, stamp: u64) -> Vec<u8> {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = [0; 13];
    header[..4].copy_from_slice(&encoded.width.to_be_bytes());
    header[4..8].copy_from_slice(&encoded.height.to_be_bytes());
    header[8] = 8;
    header[9] = if encoded.palette.is_some() { 3 } else { 6 };
    chunk(&mut png, b"IHDR", &header);
    if let Some(palette) = &encoded.palette { chunk(&mut png, b"PLTE", palette); }
    chunk(&mut png, b"tEXt", format!("mcp-apps-cli\0{stamp}").as_bytes());
    chunk(&mut png, b"IDAT", &encoded.idat);
    chunk(&mut png, b"IEND", &[]);
    png
}

fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    png.extend_from_slice(&(body.len() as u32).to_be_bytes());
    let start = png.len();
    png.extend_from_slice(kind);
    png.extend_from_slice(body);
    let checksum = crc32(&png[start..]);
    png.extend_from_slice(&checksum.to_be_bytes());
}

const CRC_TABLE: [u32; 256] = {
    let mut table = [0; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

/// PNG/IEEE CRC-32 (initial/final XOR 0xffffffff).
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xffffffff;
    for &b in bytes { c = CRC_TABLE[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8); }
    c ^ 0xffffffff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_hash_tells_bands_apart() {
        let band = vec![7u8; 2192 * 4 * 12];
        let mut seen = std::collections::HashSet::new();
        assert!(seen.insert(band_hash(&band)));
        // Any one byte changed, anywhere (the tail too), is another hash.
        for at in (0..band.len()).step_by(997).chain([band.len() - 1]) {
            let mut other = band.clone();
            other[at] ^= 1;
            assert!(seen.insert(band_hash(&other)), "byte {at}");
        }
        // Words swapped between lanes, and a shorter band of the same bytes.
        let mut swapped = band.clone();
        swapped[0] = 1;
        let mut moved = band.clone();
        moved[8] = 1;
        assert_ne!(band_hash(&swapped), band_hash(&moved));
        assert_ne!(band_hash(&band), band_hash(&band[..band.len() - 4]));
    }

    #[test]
    fn same_version_reuses_compressed_allocations_and_hashes() {
        let mut state = StripState::new(EncoderOptions::default());
        let job = StripJob {
            png: include_bytes!("../tests/fixtures/bands.png"),
            rows: 14, top: 0, all: false, stamp: 1, version: 1,
        };
        encode_strips(&mut state, job).unwrap();
        let before = state.encoded.iter().map(|e| (e.idat.as_ptr(), e.idat.clone())).collect::<Vec<_>>();
        let hashes = state.hashes.clone();
        let layout = state.layout.clone();
        let again = encode_strips(&mut state, StripJob { png: b"invalid", all: true, stamp: 2, top: 99, ..job }).unwrap();
        assert_eq!(again.strips.len(), 3);
        for (encoded, (pointer, bytes)) in state.encoded.iter().zip(before) {
            assert_eq!(encoded.idat.as_ptr(), pointer);
            assert_eq!(encoded.idat, bytes);
        }
        assert_eq!(hashes, state.hashes);
        assert_eq!(state.layout, layout);
    }
}
