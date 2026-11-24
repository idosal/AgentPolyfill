use std::{collections::HashMap, fs, io::{Cursor, Read}, path::PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::read::ZlibDecoder;
use mcp_apps_pictures::{EncoderOptions, StripJob, StripResult, StripState, crc32, decode_png, encode_strips, quantize};
use serde::Deserialize;

fn fixture(name: &str) -> Vec<u8> {
    fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()
}

#[derive(Deserialize)]
struct Manifest {
    decode: Vec<DecodeCase>,
    quantize: Vec<QuantizeCase>,
    sequences: Vec<Sequence>,
    crc32: Vec<CrcCase>,
}
#[derive(Deserialize)]
struct DecodeCase { name: String, png: String, rgba: String, width: usize, height: usize }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuantizeCase {
    name: String, png: String, y0: usize, height: usize, max_colours: Option<usize>, expected: Option<ExpectedQuantized>,
}
#[derive(Deserialize)]
struct ExpectedQuantized { palette: Vec<[u8; 3]>, indices: String, psnr: serde_json::Value, colours: usize }
#[derive(Deserialize)]
struct Sequence { name: String, palette: bool, steps: Vec<Step> }
#[derive(Deserialize)]
struct Step {
    view: String,
    #[serde(default)]
    drop: bool,
    job: Option<Job>,
    expected: Option<StripResult>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Job { png: String, rows: usize, top: i64, all: bool, stamp: u64, version: u64 }
#[derive(Deserialize)]
struct CrcCase { bytes: String, expected: u32 }
fn manifest() -> Manifest { serde_json::from_slice(&fixture("manifest.json")).unwrap() }

#[test]
fn javascript_png_decoding_fixtures_match_every_rgba_byte() {
    for case in manifest().decode {
        let image = decode_png(&fixture(&case.png)).unwrap();
        assert_eq!((image.width, image.height), (case.width, case.height), "{}", case.name);
        assert_eq!(image.data, fixture(&case.rgba), "{}", case.name);
    }
}

#[test]
fn javascript_quantize_fixtures_match_palette_indices_psnr_and_colour_count() {
    for case in manifest().quantize {
        let image = decode_png(&fixture(&case.png)).unwrap();
        let actual = quantize(&image.data, image.width, case.y0, case.height, case.max_colours).unwrap();
        match (actual, case.expected) {
            (None, None) => (),
            (Some(actual), Some(expected)) => {
                assert_eq!(actual.palette, expected.palette, "{} palette", case.name);
                assert_eq!(actual.indices, fixture(&expected.indices), "{} indices", case.name);
                assert_eq!(actual.colours, expected.colours, "{} colours", case.name);
                if expected.psnr == "Infinity" { assert_eq!(actual.psnr, f64::INFINITY, "{}", case.name); }
                else {
                    let psnr = expected.psnr.as_f64().unwrap();
                    assert!((actual.psnr - psnr).abs() <= 1e-9, "{} PSNR {} != {}", case.name, actual.psnr, psnr);
                }
            }
            _ => panic!("{}: early-exit mismatch", case.name),
        }
    }
}

// Parse and validate every chunk, retaining exact bytes (including its CRC).
// IDAT compression is the only permitted byte-level difference.
fn chunks(png: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let mut at = 8;
    let mut chunks = Vec::new();
    while at < png.len() {
        let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = png[at + 4..at + 8].try_into().unwrap();
        let end = at + 12 + len;
        let checksum = u32::from_be_bytes(png[end - 4..end].try_into().unwrap());
        assert_eq!(checksum, crc32(&png[at + 4..end - 4]), "CRC for {kind:?}");
        chunks.push((kind, png[at..end].to_vec()));
        at = end;
    }
    assert_eq!(at, png.len());
    chunks
}

#[derive(Debug, PartialEq, Eq)]
struct DecodedStrip {
    width: u32,
    height: u32,
    color: png::ColorType,
    palette: Option<Vec<u8>>,
    samples: Vec<u8>,
    rgba: Vec<u8>,
}
fn decode_strip(bytes: &[u8]) -> DecodedStrip {
    // Identity decoding checks the index bytes as well as their palette. A second
    // decoder expands indexed colors to compare actual displayed pixels.
    let mut reader = png::Decoder::new(Cursor::new(bytes)).read_info().unwrap();
    let palette = reader.info().palette.as_ref().map(|p| p.to_vec());
    let mut samples = vec![0; reader.output_buffer_size().unwrap()];
    let output = reader.next_frame(&mut samples).unwrap();
    samples.truncate(output.buffer_size());
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().unwrap();
    let mut expanded = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut expanded).unwrap();
    expanded.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgb => expanded.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::Rgba => expanded,
        _ => panic!("unexpected strip format"),
    };
    DecodedStrip { width: output.width, height: output.height, color: output.color_type, palette, samples, rgba }
}

fn assert_png_parity(actual: &str, expected: &str, stamp: u64, context: &str) {
    let actual = STANDARD.decode(actual).unwrap();
    let expected = STANDARD.decode(expected).unwrap();
    let a = chunks(&actual);
    let e = chunks(&expected);
    assert_eq!(a.iter().map(|(k, _)| k).collect::<Vec<_>>(), e.iter().map(|(k, _)| k).collect::<Vec<_>>(), "{context} chunk order");
    assert_eq!(a.iter().filter(|(k, _)| k != b"IDAT").collect::<Vec<_>>(), e.iter().filter(|(k, _)| k != b"IDAT").collect::<Vec<_>>(), "{context} non-IDAT chunks");
    let text = a.iter().find(|(k, _)| k == b"tEXt").unwrap();
    assert_eq!(&text.1[8..text.1.len() - 4], format!("mcp-apps-cli\0{stamp}").as_bytes(), "{context} stamp");
    let inflated = |chunks: &[([u8; 4], Vec<u8>)]| {
        let idat = chunks.iter().filter(|(k, _)| k == b"IDAT")
            .flat_map(|(_, b)| b[8..b.len() - 4].iter().copied()).collect::<Vec<_>>();
        let mut raw = Vec::new();
        ZlibDecoder::new(idat.as_slice()).read_to_end(&mut raw).unwrap();
        raw
    };
    assert_eq!(inflated(&a), inflated(&e), "{context} uncompressed scanlines");
    assert_eq!(decode_strip(&actual), decode_strip(&expected), "{context} pixels/palette/indices");
}

#[test]
fn javascript_stateful_strip_fixtures_match_bands_pixels_palette_and_non_idat_chunks() {
    for sequence in manifest().sequences {
        let mut states = HashMap::new();
        for (index, step) in sequence.steps.into_iter().enumerate() {
            if step.drop { states.remove(&step.view); continue; }
            let job = step.job.unwrap();
            let png = fixture(&job.png);
            let state = states.entry(step.view).or_insert_with(|| StripState::new(EncoderOptions { palette: sequence.palette }));
            let actual = encode_strips(state, StripJob { png: &png, rows: job.rows, top: job.top, all: job.all, stamp: job.stamp, version: job.version });
            let context = format!("{} step {index}", sequence.name);
            if let Some(error) = step.error {
                assert!(actual.unwrap_err().to_string().contains(&error), "{context}");
                continue;
            }
            let actual = actual.unwrap();
            let expected = step.expected.unwrap();
            assert_eq!(actual.strip_count, expected.strip_count, "{context}");
            assert_eq!(bands(&actual), bands(&expected), "{context}");
            for (a, e) in actual.strips.iter().zip(&expected.strips) {
                assert_png_parity(&a.png, &e.png, job.stamp, &context);
            }
            assert_eq!(serde_json::to_value(&actual).unwrap()["stripCount"], actual.strip_count);
        }
    }
}

#[test]
fn crc32_matches_node_and_standard_vectors() {
    assert_eq!(crc32(b"123456789"), 0xcbf43926);
    assert_eq!(crc32(b""), 0);
    for case in manifest().crc32 { assert_eq!(crc32(&STANDARD.decode(case.bytes).unwrap()), case.expected); }
}

#[test]
fn benchmark_chrome_screenshot_matches_node() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected { width: usize, height: usize, rgba_crc32: u32, expected: StripResult }
    let expected: Expected = serde_json::from_slice(&fixture("benchmark-parity.json")).unwrap();
    let png = fixture("benchmark.png");
    let image = decode_png(&png).unwrap();
    assert_eq!((image.width, image.height), (expected.width, expected.height));
    assert_eq!(crc32(&image.data), expected.rgba_crc32);
    let actual = encode_strips(&mut state(), StripJob { rows: 48, ..job(&png, 1) }).unwrap();
    assert_eq!(actual.strip_count, expected.expected.strip_count);
    assert_eq!(bands(&actual), bands(&expected.expected));
    for (a, e) in actual.strips.iter().zip(&expected.expected.strips) {
        assert_png_parity(&a.png, &e.png, 1, "Chrome benchmark");
    }
}

// Direct ports of the original JS assertions, kept readable independently of
// the larger fixture corpus.
#[test]
fn a_band_with_256_colours_or_fewer_keeps_every_one_exactly() {
    let image = decode_png(&fixture("exact256.png")).unwrap();
    let result = quantize(&image.data, image.width, 2, 4, None).unwrap().unwrap();
    assert_eq!(result.psnr, f64::INFINITY);
    for (p, &index) in result.indices.iter().enumerate() {
        let i = (2 * image.width + p) * 4;
        assert_eq!(result.palette[index as usize], image.data[i..i + 3]);
    }
}

#[test]
fn a_page_of_flat_colours_with_soft_edges_stays_the_same_to_the_eye() {
    let image = decode_png(&fixture("flat-ui.png")).unwrap();
    let result = quantize(&image.data, image.width, 0, image.height, None).unwrap().unwrap();
    assert!(result.colours > 256);
    assert!(result.palette.len() <= 256);
    assert!(result.psnr >= 42.0, "psnr {}", result.psnr);
}

#[test]
fn a_band_with_too_many_colours_is_left_as_it_is() {
    let image = decode_png(&fixture("photo.png")).unwrap();
    assert!(quantize(&image.data, image.width, 0, 64, Some(4096)).unwrap().is_none());
}

fn job(png: &[u8], version: u64) -> StripJob<'_> {
    StripJob { png, rows: 14, top: 0, all: false, stamp: version, version }
}
fn bands(result: &StripResult) -> Vec<(usize, usize)> {
    result.strips.iter().map(|s| (s.i, s.rows)).collect()
}
fn state() -> StripState { StripState::new(EncoderOptions::default()) }

#[test]
fn only_changed_bands_are_sent_and_same_version_is_restamped_without_decoding() {
    let mut state = state();
    let first = encode_strips(&mut state, job(&fixture("bands.png"), 1)).unwrap();
    assert_eq!(first.strip_count, 3);
    assert_eq!(bands(&first), [(0, 6), (1, 6), (2, 2)]);
    let middle = fixture("bands-middle.png");
    let second = encode_strips(&mut state, job(&middle, 2)).unwrap();
    assert_eq!(bands(&second), [(1, 6)]);
    assert!(encode_strips(&mut state, job(&middle, 3)).unwrap().strips.is_empty());
    let again = encode_strips(&mut state, StripJob { all: true, stamp: 9, ..job(b"not a png", 3) }).unwrap();
    assert_eq!(bands(&again), [(0, 6), (1, 6), (2, 2)]);
    let bytes = STANDARD.decode(&again.strips[0].png).unwrap();
    assert!(bytes.windows(14).any(|w| w == b"mcp-apps-cli\x009"));
}

#[test]
fn view_states_can_live_on_a_worker_and_dropping_a_view_starts_over() {
    let caller = std::thread::current().id();
    std::thread::spawn(move || {
        assert_ne!(caller, std::thread::current().id());
        let mut states = HashMap::new();
        let grey = fixture("bands-grey.png");
        for view in ["a", "b"] {
            let result = encode_strips(states.entry(view).or_insert_with(state), job(&grey, 1)).unwrap();
            assert_eq!(bands(&result), [(0, 6), (1, 6), (2, 2)]);
        }
        let result = encode_strips(states.get_mut("a").unwrap(), job(&fixture("bands-last.png"), 2)).unwrap();
        assert_eq!(bands(&result), [(2, 2)]);
        states.remove("a");
        let result = encode_strips(states.entry("a").or_insert_with(state), job(&grey, 3)).unwrap();
        assert_eq!(bands(&result), [(0, 6), (1, 6), (2, 2)]);
        assert!(encode_strips(states.get_mut("a").unwrap(), job(b"not a png", 4)).unwrap_err().to_string().contains("not a PNG"));
        assert!(encode_strips(states.get_mut("b").unwrap(), job(&grey, 2)).unwrap().strips.is_empty());
    }).join().unwrap();
}

#[test]
fn palette_choices_and_alpha_match_javascript_policy() {
    for (input, palette_expected) in [("flat-ui", true), ("gradient", false), ("photo", false), ("noise", false), ("alpha", true)] {
        let png = fixture(&format!("{input}.png"));
        for enabled in [true, false] {
            let result = encode_strips(&mut StripState::new(EncoderOptions { palette: enabled }), StripJob { rows: 6, ..job(&png, 1) }).unwrap();
            let decoded = decode_strip(&STANDARD.decode(&result.strips[0].png).unwrap());
            assert_eq!(decoded.palette.is_some(), enabled && palette_expected, "{input}, palette={enabled}");
            if input == "alpha" {
                let image = decode_png(&png).unwrap();
                if enabled {
                    assert!(decoded.rgba.chunks_exact(4).all(|p| p[3] == 255));
                    for (a, b) in decoded.rgba.chunks_exact(4).zip(image.data.chunks_exact(4)) { assert_eq!(a[..3], b[..3]); }
                } else { assert_eq!(decoded.rgba, image.data); }
            }
        }
    }
}

#[test]
fn invalid_inputs_return_errors_and_do_not_replace_cached_version() {
    assert!(decode_png(b"not a png").is_err());
    let png = fixture("bands.png");
    assert!(decode_png(&png[..png.len() / 2]).is_err());
    assert!(quantize(&[0; 4], 1, 0, 2, None).is_err());
    assert!(quantize(&[], usize::MAX, 1, 1, None).is_err());
    let mut state = state();
    encode_strips(&mut state, job(&png, 1)).unwrap();
    assert!(encode_strips(&mut state, job(b"bad PNG", 2)).is_err());
    let again = encode_strips(&mut state, StripJob { all: true, ..job(b"also bad", 1) }).unwrap();
    assert_eq!(again.strips.len(), 3);
    // The screenshot decoder deliberately has JS's supported-format boundary.
    let indexed = STANDARD.decode(&again.strips[0].png).unwrap();
    assert!(decode_png(&indexed).unwrap_err().to_string().contains("unsupported PNG"));
    let tiny = fixture("257-colours.png");
    assert!(encode_strips(&mut state, job(&tiny, 2)).is_err());
}

#[test]
fn screenshot_decoder_rejects_unsupported_depth_interlace_and_corrupt_crc() {
    let encode = |depth, samples: &[u8]| {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(depth);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(samples).unwrap();
        }
        bytes
    };
    let sixteen = encode(png::BitDepth::Sixteen, &[0; 8]);
    assert!(decode_png(&sixteen).unwrap_err().to_string().contains("unsupported PNG"));
    let mut interlaced = encode(png::BitDepth::Eight, &[10, 20, 30, 255]);
    // A 1x1 Adam7 image has just one nonempty pass, with the same scanline.
    interlaced[28] = 1;
    let checksum = crc32(&interlaced[12..29]);
    interlaced[29..33].copy_from_slice(&checksum.to_be_bytes());
    assert!(decode_png(&interlaced).unwrap_err().to_string().contains("unsupported PNG"));
    let mut corrupt = fixture("bands.png");
    corrupt[29] ^= 1;
    assert!(decode_png(&corrupt).is_err());
}
