//! Windows: what the helper does there with no Unix to lean on.
//!
//! - Chrome: started with its debugging pipe on two inherited pipe handles
//!   (`--remote-debugging-io-pipes=<read>,<write>`, the handles' values),
//!   only those handles (and NUL for its stdio) inherited, in a job object
//!   that ends Chrome and every process of it when the helper's handle to it
//!   closes, however the helper ended. (Unix needs a watcher for that.)
//! - The token's randomness, whether a process runs, the parent's id and its
//!   command line (for `--mcp-config`), and a watch on the parent.

use std::ffi::OsStr;
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::time::Duration;

use anyhow::{Result, bail};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    STILL_ACTIVE, SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcessId, GetExitCodeProcess, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcess, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::out::log;

pub const NO_WINDOW: u32 = CREATE_NO_WINDOW;
/// The right to wait for a process (winnt.h's SYNCHRONIZE).
const SYNCHRONIZE: u32 = 0x0010_0000;

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

/// Chrome's process: stopped (all of it, through its job) and waited for.
pub struct ChromeProcess {
    process: OwnedHandle,
    /// Absent where the job couldn't be made or joined (a job the helper
    /// runs in that forbids jobs inside it): Chrome alone is stopped then.
    job: Option<OwnedHandle>,
}

impl ChromeProcess {
    pub async fn kill(&mut self) {
        // SAFETY: handles this value owns.
        unsafe {
            match &self.job {
                Some(job) => TerminateJobObject(raw(job), 1),
                None => TerminateProcess(raw(&self.process), 1),
            };
        }
        self.exited_within(Duration::from_secs(2)).await;
    }

    /// Whether Chrome has ended, waiting at most `wait`.
    pub async fn exited_within(&mut self, wait: Duration) -> bool {
        let Ok(handle) = self.process.try_clone() else { return false };
        let ms = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: a handle of our own, duplicated for the waiting thread.
        tokio::task::spawn_blocking(move || unsafe { WaitForSingleObject(raw(&handle), ms) == WAIT_OBJECT_0 })
            .await
            .unwrap_or(false)
    }
}

/// An anonymous pipe, neither end inheritable yet. The buffer is large:
/// Chrome's answers (a screenshot) run to megabytes.
fn pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    // SAFETY: two out-pointers to handles; no security attributes.
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 1 << 20) } == 0 {
        bail!("CreatePipe: {}", std::io::Error::last_os_error());
    }
    // SAFETY: both handles were just made and are ours.
    Ok(unsafe { (OwnedHandle::from_raw_handle(read as RawHandle), OwnedHandle::from_raw_handle(write as RawHandle)) })
}

fn inheritable(handle: &OwnedHandle) -> Result<()> {
    // SAFETY: a handle we own.
    if unsafe { SetHandleInformation(raw(handle), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
        bail!("SetHandleInformation: {}", std::io::Error::last_os_error());
    }
    Ok(())
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// One argument as CommandLineToArgvW (and Chrome's own parser) reads it
/// back: quoted when it has spaces, tabs or quotes, its backslashes doubled
/// before a quote.
fn quote(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

pub fn command_line(exe: &Path, args: &[String]) -> String {
    let mut line = String::new();
    quote(&exe.to_string_lossy(), &mut line);
    for arg in args {
        line.push(' ');
        quote(arg, &mut line);
    }
    line
}

/// This environment with TMP and TEMP set to `tmp`, sorted (names without
/// case) as CreateProcess expects, NUL-separated, ended by a NUL more.
fn environment(tmp: &Path) -> Vec<u16> {
    let mut vars: Vec<(String, std::ffi::OsString)> = std::env::vars_os()
        .filter_map(|(k, v)| k.into_string().ok().map(|k| (k, v)))
        .filter(|(k, _)| !k.eq_ignore_ascii_case("TMP") && !k.eq_ignore_ascii_case("TEMP"))
        .collect();
    vars.push(("TMP".into(), tmp.into()));
    vars.push(("TEMP".into(), tmp.into()));
    vars.sort_by_key(|(k, _)| k.to_uppercase());
    let mut block = Vec::new();
    for (k, v) in vars {
        block.extend(OsStr::new(&k).encode_wide());
        block.push(u16::from(b'='));
        block.extend(v.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// Starts Chrome on its debugging pipe: the Chrome process, the pipe end we
/// write commands to, and the one we read its answers and events from.
pub fn spawn_chrome(exe: &Path, mut args: Vec<String>, tmp: &Path) -> Result<(ChromeProcess, File, File)> {
    let (child_read, our_write) = pipe()?;
    let (our_read, child_write) = pipe()?;
    inheritable(&child_read)?;
    inheritable(&child_write)?;
    let null: OwnedHandle = std::fs::OpenOptions::new().read(true).write(true).open("NUL")?.into();
    inheritable(&null)?;

    args.push("--remote-debugging-pipe".into());
    args.push(format!(
        "--remote-debugging-io-pipes={},{}",
        raw(&child_read) as usize,
        raw(&child_write) as usize
    ));
    let mut line = wide(OsStr::new(&command_line(exe, &args)));
    let app = wide(exe.as_os_str());
    let env = environment(tmp);

    // Only these handles go to Chrome, not whatever else is inheritable at
    // this moment (an MCP server's stdio being set up on another thread).
    let handles: [HANDLE; 3] = [raw(&child_read), raw(&child_write), raw(&null)];
    let mut size = 0usize;
    // SAFETY: the first call only reports the size the list needs.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut list_buf = vec![0u8; size.max(1)];
    let list = list_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    // SAFETY: list points at `size` bytes; `handles` outlives CreateProcessW.
    unsafe {
        if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
            bail!("InitializeProcThreadAttributeList: {}", std::io::Error::last_os_error());
        }
        if UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            std::mem::size_of_val(&handles),
            std::ptr::null_mut(),
            std::ptr::null(),
        ) == 0
        {
            let error = std::io::Error::last_os_error();
            DeleteProcThreadAttributeList(list);
            bail!("UpdateProcThreadAttribute: {error}");
        }
    }

    // SAFETY: zeroed is a valid STARTUPINFOEXW/PROCESS_INFORMATION.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = raw(&null);
    startup.StartupInfo.hStdOutput = raw(&null);
    startup.StartupInfo.hStdError = raw(&null);
    startup.lpAttributeList = list;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // Suspended until it's in its job, so no process of it starts outside.
    // SAFETY: every pointer is to a live, NUL-ended buffer of ours.
    let started = unsafe {
        let ok = CreateProcessW(
            app.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
            env.as_ptr().cast(),
            std::ptr::null(),
            &startup.StartupInfo,
            &mut info,
        );
        let error = std::io::Error::last_os_error();
        DeleteProcThreadAttributeList(list);
        if ok == 0 { Err(error) } else { Ok(()) }
    };
    if let Err(error) = started {
        bail!("starting Chrome: {error}");
    }
    // SAFETY: CreateProcessW gave us both handles.
    let (process, thread) = unsafe {
        (OwnedHandle::from_raw_handle(info.hProcess as RawHandle), OwnedHandle::from_raw_handle(info.hThread as RawHandle))
    };
    let job = kill_on_close_job(&process);
    // SAFETY: the main thread of the process we just made.
    unsafe { ResumeThread(raw(&thread)) };
    // Chrome has its copies; ours go, so the pipe closes when Chrome ends.
    drop((child_read, child_write, null, thread));
    Ok((ChromeProcess { process, job }, File::from(our_write), File::from(our_read)))
}

/// A job that ends all of its processes when its last handle (ours, never
/// inherited) closes, with `process` in it.
fn kill_on_close_job(process: &OwnedHandle) -> Option<OwnedHandle> {
    // SAFETY: no attributes, no name; the handle is ours if made.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        log(format!("no job for Chrome: {}", std::io::Error::last_os_error()));
        return None;
    }
    // SAFETY: just made.
    let job = unsafe { OwnedHandle::from_raw_handle(job as RawHandle) };
    // SAFETY: zeroed is a valid limit structure; then only the flag is set.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: handles we own; the structure and its size match the class.
    let joined = unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0
            && AssignProcessToJobObject(raw(&job), raw(process)) != 0
    };
    if !joined {
        log(format!("Chrome runs outside a job: {}", std::io::Error::last_os_error()));
        return None;
    }
    Some(job)
}

/// `buf` filled from the system's random source.
pub fn random(buf: &mut [u8]) -> Result<()> {
    // SAFETY: buf is valid for its length; no algorithm handle with this flag.
    let status = unsafe {
        BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
    };
    if status != 0 {
        bail!("BCryptGenRandom: {status:#x}");
    }
    Ok(())
}

/// Whether a process runs (or exists but isn't ours to look at).
pub fn alive(pid: u32) -> bool {
    // SAFETY: a query-only handle, closed below.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let running = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(handle);
        running
    }
}

/// The process that started this one.
pub fn parent_pid() -> u32 {
    // SAFETY: a snapshot handle, closed below; entries sized as required.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return 0;
        }
        let me = GetCurrentProcessId();
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut parent = 0;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.th32ProcessID == me {
                parent = entry.th32ParentProcessID;
                break;
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        parent
    }
}

/// A handle on the parent, taken at start: a process id can be reused once
/// its process ends, a handle can't. Absent if the parent couldn't be opened.
pub struct Parent(Option<OwnedHandle>);

impl Parent {
    pub fn current() -> Self {
        let pid = parent_pid();
        if pid == 0 {
            return Self(None);
        }
        // SAFETY: a wait-and-query handle, owned from here on.
        let handle = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        Self((!handle.is_null()).then(|| unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
    }

    pub fn gone(&self) -> bool {
        // SAFETY: a handle we own; a zero timeout only polls.
        self.0.as_ref().is_some_and(|h| unsafe { WaitForSingleObject(raw(h), 0) } == WAIT_OBJECT_0)
    }
}

/// The parent's command line, as the Node helper reads it (PowerShell),
/// within ten seconds.
pub fn parent_command_line() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let filter = format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={}\").CommandLine", parent_pid());
    let mut child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &filter])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        std::io::Read::read_to_string(&mut stdout, &mut text).ok().map(|_| text)
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok().flatten().map(|t| t.trim().to_string())
}

/// A server's command found as the TypeScript SDK (cross-spawn) finds it:
/// `npx` is `npx.cmd` on Windows, which CreateProcess won't look for. A
/// name with a folder or an extension is left as it is. `path`: the PATH the
/// server's config sets, if it sets one.
pub fn find_program(command: &str, path: Option<&str>) -> Option<std::path::PathBuf> {
    if command.contains(['/', '\\']) || Path::new(command).extension().is_some() {
        return None;
    }
    let path = path.map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH"))?;
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    std::env::split_paths(&path).find_map(|dir| {
        extensions
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| dir.join(format!("{command}{}", e.to_ascii_lowercase())))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_round_trips_as_argv() {
        let q = |s: &str| {
            let mut out = String::new();
            quote(s, &mut out);
            out
        };
        assert_eq!(q("plain"), "plain");
        assert_eq!(q(""), "\"\"");
        assert_eq!(q(r"C:\Program Files\x"), r#""C:\Program Files\x""#);
        assert_eq!(q(r#"a"b"#), r#""a\"b""#);
        assert_eq!(q(r"C:\dir with space\"), r#""C:\dir with space\\""#);
    }
}
