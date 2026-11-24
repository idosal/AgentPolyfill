use std::io::Cursor;

use crate::{Error, Result};

/// A screenshot in row-major, eight-bit RGBA order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// Decode the same screenshot formats as `mod/helper/png.mjs`: eight-bit,
/// non-interlaced grayscale, grayscale-alpha, RGB and RGBA.
///
/// As in JavaScript, grayscale/RGB `tRNS` metadata is ignored. The `png` crate
/// additionally validates checksums and the structure of malformed files.
pub fn decode_png(bytes: &[u8]) -> Result<Image> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(Error::InvalidInput("not a PNG"));
    }
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder.read_info()?;
    let info = reader.info();
    if info.bit_depth != png::BitDepth::Eight
        || info.interlaced
        || info.color_type == png::ColorType::Indexed
    {
        return Err(Error::InvalidInput("unsupported PNG (requires 8-bit, non-interlaced grayscale/RGB/RGBA)"));
    }
    let width = info.width as usize;
    let height = info.height as usize;
    let rgba_len = width.checked_mul(height).and_then(|n| n.checked_mul(4))
        .ok_or(Error::InvalidInput("PNG dimensions overflow"))?;
    let mut data = vec![0; reader.output_buffer_size()
        .ok_or(Error::InvalidInput("PNG dimensions overflow"))?];
    let output = reader.next_frame(&mut data)?;
    data.truncate(output.buffer_size());
    if output.color_type != png::ColorType::Rgba {
        let mut rgba = Vec::with_capacity(rgba_len);
        match output.color_type {
            png::ColorType::Grayscale => {
                for g in data { rgba.extend_from_slice(&[g, g, g, 255]); }
            }
            png::ColorType::GrayscaleAlpha => {
                for p in data.chunks_exact(2) { rgba.extend_from_slice(&[p[0], p[0], p[0], p[1]]); }
            }
            png::ColorType::Rgb => {
                for p in data.chunks_exact(3) { rgba.extend_from_slice(&[p[0], p[1], p[2], 255]); }
            }
            _ => unreachable!("input color type was checked above"),
        }
        data = rgba;
    }
    Ok(Image { width, height, data })
}
