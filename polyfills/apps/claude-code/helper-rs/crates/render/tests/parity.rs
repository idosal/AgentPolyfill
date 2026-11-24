use base64::{Engine as _, engine::general_purpose::STANDARD};
use mcp_apps_render::{
    Frame, Image, Memory, Options, Painter, Photo, Session, TextLine,
    canvas_is_photo, compose_frame, parse_css_color,
};
use serde::Deserialize;
use std::{collections::HashMap, fs, io::Cursor, path::{Path, PathBuf}};

#[derive(Deserialize)]
struct Step {
    label: String,
    image: String,
    texts: Vec<TextLine>,
    options: Options,
    memory: Option<String>,
    painter: Option<String>,
    expected: Frame,
}
#[derive(Deserialize)]
struct Fixture {
    name: String,
    frames: Vec<Step>,
}
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}
fn image(path: &Path) -> Image {
    let mut decoder = png::Decoder::new(Cursor::new(fs::read(path).unwrap()));
    decoder.set_transformations(png::Transformations::EXPAND |
            png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().unwrap();
    let mut data = vec![0;reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut data).unwrap();
    data.truncate(info.buffer_size());
    assert_eq!(info.color_type,png::ColorType::Rgba);
    Image { width: info.width as usize, height: info.height as usize, data }
}
fn compare(got: &Frame, want: &Frame, context: &str) {
    assert_eq!((got.cols,got.rows),(want.cols,want.rows),"{context}");
    if got.cells != want.cells {
        let a = STANDARD.decode(&got.cells).unwrap();
        let b = STANDARD.decode(&want.cells).unwrap();
        let mut differences = Vec::new();
        let triple =
            |bytes: &[u8]| -> Vec<u32>
                {
                    bytes.chunks_exact(4).map(|c|
                                u32::from_le_bytes(c.try_into().unwrap())).collect()
                };
        for (i, (a, b)) in
            a.chunks_exact(12).zip(b.chunks_exact(12)).enumerate() {
            if a != b {
                differences.push(format!("({}, {}): Rust {:x?}, JS {:x?}",i%got.cols,i/got.cols,triple(a),triple(b)));
            }
        }
        panic!("{context}: {} differing cells\n{}",differences.len(),differences.iter().take(16).cloned().collect::<Vec<_>>().join("\n"));
    }
    if got.lines != want.lines {
        let row =
            got.lines.as_ref().zip(want.lines.as_ref()).and_then(|(a, b)|
                    a.iter().zip(b).position(|(a, b)| a != b));
        panic!("{context}: styled runs differ at row {row:?}\nRust: {:?}\nJS: {:?}",row.and_then(|r|got.lines.as_ref().and_then(|l|l.get(r))),row.and_then(|r|want.lines.as_ref().and_then(|l|l.get(r))));
    }
}
fn check_file(name: &str) {
    let path = root().join(format!("{name}.json"));
    // Generated from render.mjs's own tests (the JS is the oracle), not
    // checked in: 18 MB, and byte-identical each time they're made.
    let bytes = fs::read(&path).unwrap_or_else(|_| {
        panic!("{} is missing: make the fixtures first, from helper-rs/: node crates/render/tests/make-fixtures.mjs", path.display())
    });
    let fixture: Fixture = serde_json::from_slice(&bytes).unwrap();
    let mut memory = HashMap::<String, Memory>::new();
    let mut painters = HashMap::<String, Painter>::new();
    let mut session = Session::default();
    for (i, step) in fixture.frames.iter().enumerate() {
        let img = image(&root().join(&step.image));
        let m =
            step.memory.as_ref().map(|id|
                    memory.entry(id.clone()).or_default());
        let p =
            step.painter.as_ref().map(|id|
                    painters.entry(id.clone()).or_default());
        let got =
            compose_frame(&img, &step.texts, &step.options, m, p,
                &mut session);
        compare(&got, &step.expected,
            &format!("{} frame {i}: {}",fixture.name,step.label));
    }
}
#[test]
fn ui_and_text() { check_file("render"); }
#[test]
fn sextants() { check_file("sextants"); }
#[test]
fn truecolor() { check_file("truecolor"); }
#[test]
fn palette_budget() { check_file("palette"); }
#[test]
fn edge_cases() { check_file("edges"); }
#[test]
fn benchmark_scene() { check_file("benchmark"); }
#[test]
fn all_fixture_files_are_registered() {
    let mut found: Vec<_> =
        fs::read_dir(root()).unwrap().map(|e|
                            e.unwrap().path()).filter(|p|
                        p.extension().is_some_and(|e|
                                e ==
                                    "json")).map(|p|
                    p.file_stem().unwrap().to_str().unwrap().to_owned()).collect();
    found.sort();
    assert_eq!(found,["benchmark","edges","palette","render","sextants","truecolor","utilities"]);
}
#[test]
fn exported_utilities() {
    #[derive(Deserialize)]
    struct Color {
        input: Option<String>,
        expected: mcp_apps_render::CssColor,
    }
    #[derive(Deserialize)]
    struct Canvas {
        image: String,
        rect: Photo,
        expected: bool,
    }
    #[derive(Deserialize)]
    struct Utilities {
        css: Vec<Color>,
        canvas: Vec<Canvas>,
    }
    let data: Utilities =
        serde_json::from_slice(&fs::read(root().join("utilities.json")).unwrap()).unwrap();
    for c in data.css {
        assert_eq!(parse_css_color(c.input.as_deref()),c.expected,"CSS {:?}",c.input);
    }
    let mut painter = Painter::default();
    for c in data.canvas {
        assert_eq!(canvas_is_photo(&image(&root().join(c.image)),&c.rect,Some(&mut
        painter)),c.expected);
    }
}
