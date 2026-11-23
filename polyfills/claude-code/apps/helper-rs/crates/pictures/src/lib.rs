//! The PNG, median-cut and iTerm2 strip encoders used by the CLI helper.
//!
//! Keep one [`StripState`] per view and process its jobs in order. See the crate
//! README for JavaScript parity, environment settings and benchmark commands.

mod decode;
mod quantize;
mod strips;

pub use decode::{Image, decode_png};
pub use quantize::{Quantized, quantize};
pub use strips::{
    EncoderOptions, PALETTE_MAX_COLOURS, PALETTE_MIN_PSNR, STRIP_ROWS, Strip, StripJob,
    StripResult, StripState, crc32, encode_strips,
};

/// An invalid input, PNG decoding error, or compression error.
#[derive(Debug)]
pub enum Error {
    InvalidInput(&'static str),
    Png(png::DecodingError),
    Io(std::io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(message) => f.write_str(message),
            Self::Png(error) => error.fmt(f),
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidInput(_) => None,
            Self::Png(error) => Some(error),
            Self::Io(error) => Some(error),
        }
    }
}

impl From<png::DecodingError> for Error {
    fn from(error: png::DecodingError) -> Self {
        Self::Png(error)
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

fn rgba_range(data: &[u8], width: usize, y0: usize, height: usize) -> Result<std::ops::Range<usize>> {
    let end = y0.checked_add(height)
        .and_then(|rows| rows.checked_mul(width))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(Error::InvalidInput("RGBA dimensions overflow"))?;
    if end > data.len() {
        return Err(Error::InvalidInput("RGBA buffer is shorter than the requested rows"));
    }
    Ok(y0 * width * 4..end)
}
