//! What the terminal claude runs in can show, from its environment, as the
//! Node helper decides it (`imageCapable`, `swapEveryDraw`, `TRUECOLOR`).

fn var(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

fn ghostty() -> bool {
    var("TERM_PROGRAM") == "ghostty" || !var("GHOSTTY_RESOURCES_DIR").is_empty()
}

fn kitty() -> bool {
    !var("KITTY_WINDOW_ID").is_empty() || var("TERM") == "xterm-kitty"
}

/// Whether the terminal shows Claude Code's Image element: iTerm2 3.5+,
/// kitty or Ghostty, outside tmux. `MCP_APPS_CLI_MODE=cells|image` decides.
pub fn image_capable() -> bool {
    match var("MCP_APPS_CLI_MODE").as_str() {
        "image" => return true,
        "cells" => return false,
        _ => {}
    }
    if !var("TMUX").is_empty() {
        return false;
    }
    if var("TERM_PROGRAM") == "iTerm.app" {
        let version: Vec<u32> = var("TERM_PROGRAM_VERSION").split('.').map(|p| p.parse().unwrap_or(0)).collect();
        let (major, minor) = (version.first().copied().unwrap_or(0), version.get(1).copied().unwrap_or(0));
        return major > 3 || (major == 3 && minor >= 5);
    }
    ghostty() || kitty()
}

/// iTerm2 shows a picture only after a swap, each time it is drawn anew.
pub fn swap_every_draw() -> bool {
    !(ghostty() || kitty())
}

/// Cells in exact colours, where the terminal has 24-bit colour.
pub fn truecolor() -> bool {
    var("MCP_APPS_CLI_TRUECOLOR") != "0" && {
        let c = var("COLORTERM").to_lowercase();
        c.contains("truecolor") || c.contains("24bit")
    }
}

pub fn image_files() -> bool {
    !swap_every_draw() && var("SSH_CONNECTION").is_empty() && var("SSH_TTY").is_empty() && var("MCP_APPS_CLI_IMAGE_FILES") != "0"
}

pub fn strips_on() -> bool { var("MCP_APPS_CLI_STRIPS") != "0" }

pub fn sextants() -> bool {
    match var("MCP_APPS_CLI_SEXTANTS").as_str() {
        "1" => true, "0" => false,
        _ => var("TERM_PROGRAM") == "WezTerm" || ghostty() || kitty(),
    }
}

pub fn row_height(image: bool) -> f64 {
    let forced = var("MCP_APPS_CLI_CELL_ASPECT").parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0);
    let aspect = forced.or_else(measure_aspect).unwrap_or(2.0);
    if image { (8.0 * aspect * 2.0).round() / 2.0 } else { (8.0 * aspect).round() }
}

#[cfg(unix)]
fn measure_aspect() -> Option<f64> {
    use std::os::fd::AsRawFd;
    let tty = std::fs::File::open("/dev/tty").ok()?;
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    // SAFETY: tty is open and size has the layout expected by TIOCGWINSZ.
    if unsafe { libc::ioctl(tty.as_raw_fd(), libc::TIOCGWINSZ, &mut size) } != 0 { return None; }
    if size.ws_row == 0 || size.ws_col == 0 || size.ws_xpixel == 0 || size.ws_ypixel == 0 { return None; }
    Some((f64::from(size.ws_ypixel) / f64::from(size.ws_row) / (f64::from(size.ws_xpixel) / f64::from(size.ws_col))).clamp(1.2, 3.5))
}

#[cfg(not(unix))]
fn measure_aspect() -> Option<f64> { None }
