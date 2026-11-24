//! A whole picture's PNG, stamped (a `tEXt` chunk with a count), so a
//! terminal that compares pictures sees each one as new. The cells renderer
//! (crates/render) and the strip encoder (crates/pictures) are called from
//! views.rs.

/// Whole-PNG refreshes still need fresh bytes, even while strips are stubbed.
pub fn stamp_png(png: &[u8], stamp: u64) -> Vec<u8> {
    if png.len() < 33 { return png.to_vec(); }
    let body = format!("tEXtmcp-apps-cli\0{stamp}").into_bytes();
    let mut crc = !0u32;
    for byte in &body {
        crc ^= u32::from(*byte);
        for _ in 0..8 { crc = (crc >> 1) ^ (0xedb88320u32 & 0u32.wrapping_sub(crc & 1)); }
    }
    let mut out = Vec::with_capacity(png.len() + body.len() + 8);
    out.extend_from_slice(&png[..33]);
    out.extend_from_slice(&((body.len() - 4) as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out.extend_from_slice(&(!crc).to_be_bytes());
    out.extend_from_slice(&png[33..]);
    out
}
