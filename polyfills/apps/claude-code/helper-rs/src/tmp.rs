//! The helper's own temporary folder (Chrome's profile goes in it), the
//! sweep of folders and sockets left by helpers that ended outright, the
//! token's randomness, and the process's surroundings (its parent, signals).

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;

/// The person's home folder: HOME, or on Windows USERPROFILE.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// This helper's own folder, as the Node helper names it: `mcp-apps-cli-<pid>.tmp`.
pub fn own_dir() -> PathBuf {
    std::env::temp_dir().join(format!("mcp-apps-cli-{}.tmp", std::process::id()))
}

/// The helper's own folder, made or found private: a folder, not a link,
/// that this user owns and only this user can open. Its name can be
/// guessed, and on Linux the temporary folder is shared, so another user
/// could make it first; it is checked, not taken as found.
/// Chrome's profile and the pictures go inside it.
pub fn own_private_dir() -> Result<PathBuf> {
    let dir = own_dir();
    crate::store::private_folder(&dir)?;
    Ok(dir)
}

/// Starts the watcher for Chrome (`--reap`): this same binary, in a session
/// of its own, with no stdio, so nothing of it reaches the mod. (Windows has
/// no need: Chrome runs in a job that ends with the helper.)
#[cfg(unix)]
pub fn start_reaper(chrome: i32) {
    let Ok(exe) = std::env::current_exe() else { return };
    let mut command = std::process::Command::new(exe);
    command
        .args(["--reap", &std::process::id().to_string(), &chrome.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    match command.spawn() {
        // Waited for on a thread of its own, so it leaves no zombie when it
        // exits first (Chrome closed); if we go first, it carries on.
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(error) => crate::out::log(format!("no watcher for Chrome: {error}")),
    }
}

/// The watcher: waits while both the helper and Chrome run; once the helper
/// is gone (it was ended outright), stops Chrome, politely then not, and
/// removes the helper's folder. Once Chrome is gone, it just leaves.
#[cfg(unix)]
pub fn reap(helper: i32, chrome: i32) {
    if helper <= 0 || chrome <= 0 {
        return;
    }
    let running = |pid: i32| alive(pid);
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if !running(chrome) {
            return;
        }
        if !running(helper) {
            break;
        }
    }
    // SAFETY: signals to the Chrome we were started for.
    unsafe { libc::kill(chrome, libc::SIGTERM) };
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if !running(chrome) {
            break;
        }
    }
    if running(chrome) {
        unsafe { libc::kill(chrome, libc::SIGKILL) };
    }
    let _ = fs::remove_dir_all(std::env::temp_dir().join(format!("mcp-apps-cli-{helper}.tmp")));
}

#[cfg(not(unix))]
pub fn reap(_helper: i32, _chrome: i32) {}

/// Chrome processes still running on a dead helper's profile (Node's
/// helper, or one from before the watcher), stopped as its folder goes.
#[cfg(unix)]
fn stop_chromes_in(folder: &Path) {
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-ww", "-o", "pid=,args="]).output() else { return };
    let needle = format!("--user-data-dir={}", folder.display());
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim_start();
        let Some((pid, args)) = line.split_once(' ') else { continue };
        if args.contains(&needle) {
            if let Ok(pid) = pid.parse::<i32>() {
                // SAFETY: a Chrome on a profile in a dead helper's own folder.
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
        }
    }
}

#[cfg(not(unix))]
fn stop_chromes_in(_folder: &Path) {}

/// Removes the folders and sockets of helpers no longer running (Claude Code
/// ends its helper outright when it quits, before it can clean up), and any
/// Chrome still running in one.
pub fn sweep_old() {
    let root = std::env::temp_dir();
    let Ok(entries) = fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix("mcp-apps-cli-") else { continue };
        let Some((pid, kind)) = rest.split_once('.') else { continue };
        if !(kind == "tmp" || kind == "sock") {
            continue;
        }
        let Ok(pid) = pid.parse::<i32>() else { continue };
        if pid as u32 == std::process::id() || alive(pid) {
            continue;
        }
        let path = root.join(&name);
        if path.is_dir() {
            stop_chromes_in(&path);
        }
        let _ = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
    }
}

/// Whether a process is running (or exists but is someone else's).
#[cfg(unix)]
fn alive(pid: i32) -> bool {
    // SAFETY: kill with signal 0 only checks the process.
    let r = unsafe { libc::kill(pid, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn alive(pid: i32) -> bool {
    crate::win::alive(pid as u32)
}

pub fn remove_own() {
    let _ = fs::remove_dir_all(own_dir());
}

/// `bytes` random bytes, as hex: the token every request must carry.
pub fn random_hex(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    #[cfg(unix)]
    {
        use std::io::Read;
        anyhow::Context::context(fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)), "reading /dev/urandom")?;
    }
    #[cfg(windows)]
    crate::win::random(&mut buf)?;
    Ok(hex::encode(buf))
}

/// Writes a file only the person can read (mode 0600).
pub fn write_private(path: &Path, text: &str) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut f) = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path) {
            let _ = f.write_all(text.as_bytes());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = fs::write(path, text);
    }
}

#[cfg(unix)]
pub fn parent_pid() -> u32 {
    // SAFETY: getppid has no preconditions.
    unsafe { libc::getppid() as u32 }
}

/// The claude process that started the helper, watched so the helper goes
/// with it: on Unix the helper is handed to another parent then; on Windows
/// a handle taken now says when that process has ended.
pub struct Parent {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    handle: crate::win::Parent,
}

impl Parent {
    pub fn current() -> Self {
        #[cfg(unix)]
        return Self { pid: parent_pid() };
        #[cfg(windows)]
        return Self { handle: crate::win::Parent::current() };
    }

    pub fn gone(&self) -> bool {
        #[cfg(unix)]
        return parent_pid() != self.pid;
        #[cfg(windows)]
        return self.handle.gone();
    }
}

/// Hands memory the helper freed back to the system. A frame's buffers (a
/// decoded screenshot, its PNG and base64) run to megabytes, and the
/// allocator keeps freed ones for reuse: while views are busy that saves
/// work, once they've gone quiet it's memory held for nothing.
pub fn release_memory() {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // SAFETY: no zone (all of them), no goal (as much as it can).
        unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) };
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: no preconditions.
    unsafe {
        libc::malloc_trim(0);
    }
}

/// SIGTERM, SIGINT and SIGHUP (on Windows, Ctrl-C, Ctrl-Break, the console
/// closing, shutdown): the helper closes Chrome and goes.
pub struct Signals {
    #[cfg(unix)]
    term: tokio::signal::unix::Signal,
    #[cfg(unix)]
    int: tokio::signal::unix::Signal,
    #[cfg(unix)]
    hup: tokio::signal::unix::Signal,
    #[cfg(windows)]
    c: tokio::signal::windows::CtrlC,
    #[cfg(windows)]
    brk: tokio::signal::windows::CtrlBreak,
    #[cfg(windows)]
    close: tokio::signal::windows::CtrlClose,
    #[cfg(windows)]
    shutdown: tokio::signal::windows::CtrlShutdown,
}

impl Signals {
    pub fn new() -> Result<Self> {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Ok(Self {
                term: signal(SignalKind::terminate())?,
                int: signal(SignalKind::interrupt())?,
                hup: signal(SignalKind::hangup())?,
            })
        }
        #[cfg(windows)]
        {
            use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_shutdown};
            Ok(Self { c: ctrl_c()?, brk: ctrl_break()?, close: ctrl_close()?, shutdown: ctrl_shutdown()? })
        }
    }

    pub async fn recv(&mut self) {
        #[cfg(unix)]
        tokio::select! {
            _ = self.term.recv() => {},
            _ = self.int.recv() => {},
            _ = self.hup.recv() => {},
        }
        #[cfg(windows)]
        tokio::select! {
            _ = self.c.recv() => {},
            _ = self.brk.recv() => {},
            _ = self.close.recv() => {},
            _ = self.shutdown.recv() => {},
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    // The helper's folder has a name another local
    // user can guess, so it is checked whoever made it.
    #[test]
    fn the_helpers_own_folder_is_checked_not_taken_as_found() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = own_dir();
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dir);
        // Made first as a link to a folder elsewhere: refused, and nothing is made there.
        let elsewhere = std::env::temp_dir().join(format!("mcp-apps-cli-elsewhere-{}", random_hex(4).unwrap()));
        fs::create_dir_all(&elsewhere).unwrap();
        symlink(&elsewhere, &dir).unwrap();
        assert!(own_private_dir().is_err());
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
        fs::remove_file(&dir).unwrap();
        // Made first, open to everyone: closed to all but this user.
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(own_private_dir().unwrap(), dir);
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&elsewhere).unwrap();
    }
}
