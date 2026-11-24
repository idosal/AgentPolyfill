//! Dependency-free, deterministic fuzz inputs shared by the parser unit tests.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::pin::Pin;
use std::task::{Context, Poll};

use serde_json::{Value, json};
use tokio::io::{AsyncRead, ReadBuf};

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self { Self(seed) }

    // SplitMix64: every case has its own seed, independent of earlier cases.
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut n = self.0;
        n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
        n ^ (n >> 31)
    }

    pub fn below(&mut self, limit: usize) -> usize {
        (self.next() % limit as u64) as usize
    }

    pub fn bytes(&mut self, max: usize) -> Vec<u8> {
        (0..self.below(max + 1)).map(|_| self.next() as u8).collect()
    }

    pub fn string(&mut self, max: usize) -> String {
        const CHARS: &[char] = &['a', 'Z', '0', '-', '_', ':', '/', '.', '*', ' ', '\t', '\r', '\n',
            '\0', '\'', '"', '\\', '$', '{', '}', ';', '=', 'é', '中', '😀', '\u{2028}'];
        (0..self.below(max + 1)).map(|_| CHARS[self.below(CHARS.len())]).collect()
    }

    pub fn json(&mut self, depth: usize) -> Value {
        match self.below(if depth == 0 { 6 } else { 8 }) {
            0 => Value::Null,
            1 => json!(self.below(2) == 0),
            2 => json!(self.next() as i64),
            3 => json!(self.next()),
            4 => json!([f64::MAX, -f64::MAX, 0.0, -0.5, 1e100][self.below(5)]),
            5 => json!(self.string(64)),
            6 => Value::Array((0..self.below(5)).map(|_| self.json(depth - 1)).collect()),
            _ => Value::Object((0..self.below(5)).map(|_| (self.string(12), self.json(depth - 1))).collect()),
        }
    }
}

/// Reproduce a failure with FUZZ_SEED=0x... cargo test <test-name>.
/// Catch here so even a panic inside the parser reports its exact case seed.
pub fn cases(base: u64, count: usize, mut run: impl FnMut(&mut Rng)) {
    let replay = std::env::var("FUZZ_SEED").ok().map(|s| {
        if let Some(hex) = s.strip_prefix("0x") { u64::from_str_radix(hex, 16).unwrap() }
        else { s.parse().unwrap() }
    });
    let mut seeds = Rng::new(base);
    for _ in 0..if replay.is_some() { 1 } else { count } {
        let seed = replay.unwrap_or_else(|| seeds.next());
        if let Err(error) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&mut Rng::new(seed)))) {
            let message = error.downcast_ref::<String>().map(String::as_str)
                .or_else(|| error.downcast_ref::<&str>().copied()).unwrap_or("non-string panic");
            panic!("fuzz case FUZZ_SEED={seed:#018x}: {message}");
        }
    }
}

/// Arbitrary short reads, optionally with a real Pending/wakeup between reads.
pub struct Chunked {
    data: Vec<u8>,
    pub read: usize,
    rng: Rng,
    max: usize,
    pending: bool,
}

impl Chunked {
    pub fn new(data: Vec<u8>, seed: u64, max: usize) -> Self {
        assert!(max > 0);
        Self { data, read: 0, rng: Rng::new(seed), max, pending: false }
    }
}

impl AsyncRead for Chunked {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.pending {
            self.pending = false;
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        let max = self.max;
        let n = (1 + self.rng.below(max)).min(buf.remaining()).min(self.data.len() - self.read);
        buf.put_slice(&self.data[self.read..self.read + n]);
        self.read += n;
        self.pending = self.rng.below(8) == 0;
        Poll::Ready(Ok(()))
    }
}

// Track actual allocation requests only on the current test thread. This avoids
// interference from concurrently running tests and measures realloc as well.
thread_local! { static LARGEST: Cell<Option<usize>> = const { Cell::new(None) }; }
struct TrackingAllocator;

fn record(size: usize) {
    let _ = LARGEST.try_with(|largest| {
        if let Some(old) = largest.get() { largest.set(Some(old.max(size))); }
    });
}

// SAFETY: every allocation operation is forwarded unchanged to System.
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        unsafe { System.realloc(ptr, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: TrackingAllocator = TrackingAllocator;

pub fn allocations<T>(run: impl FnOnce() -> T) -> (T, usize) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) { LARGEST.set(None); }
    }
    LARGEST.set(Some(0));
    let _reset = Reset;
    let result = run();
    (result, LARGEST.get().unwrap())
}
