//! Same input and measurement boundaries as tests/benchmark.mjs.
use mcp_apps_render::{
    Image, Memory, Options, Painter, Session, compose_frame,
};
use serde::Deserialize;
use std::{fs, hint::black_box, io::Cursor, path::PathBuf, time::Instant};
#[derive(Deserialize)]
struct Step {
    image: String,
    options: Options,
}
#[derive(Deserialize)]
struct Fixture {
    frames: Vec<Step>,
}
fn main() {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let fixture: Fixture =
        serde_json::from_slice(&fs::read(root.join("benchmark.json")).unwrap()).unwrap();
    let decoder =
        png::Decoder::new(Cursor::new(fs::read(root.join(&fixture.frames[0].image)).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut data = vec![0;reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut data).unwrap();
    data.truncate(info.buffer_size());
    let image =
        Image {
            width: info.width as usize,
            height: info.height as usize,
            data,
        };
    for step in fixture.frames {
        let mut options = step.options;
        let mut memory = Memory::default();
        let mut painter = Painter::default();
        let mut session = Session::default();
        options.now = Some(0.0);
        let start = Instant::now();
        black_box(compose_frame(&image, &[], &options, Some(&mut memory),
                Some(&mut painter), &mut session));
        let cold = start.elapsed().as_secs_f64() * 1000.0;
        for i in 1..=20 {
            options.now = Some(i as f64 * 100.0);
            black_box(compose_frame(&image, &[], &options, Some(&mut memory),
                    Some(&mut painter), &mut session));
        }
        let mut times = Vec::new();
        let start = Instant::now();
        for i in 21..=220 {
            options.now = Some(i as f64 * 100.0);
            let start = Instant::now();
            black_box(compose_frame(&image, &[], &options, Some(&mut memory),
                    Some(&mut painter), &mut session));
            times.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let mean = start.elapsed().as_secs_f64() * 1000.0 / 200.0;
        times.sort_by(f64::total_cmp);
        println!("{}",serde_json::json!({"runtime":"Rust release","truecolor":options.truecolor,"sextants":options.sextants,"lines":options.lines,"cols":100,"rows":30,"scale":2,"frames":200,"cold_ms":cold,"mean_ms":mean,"median_ms":times[100],"p95_ms":times[190]}));
    }
}
