//! Windows APIs shared by the GUI and the small Node platform helper.
use std::{ffi::OsStr, io, os::windows::ffi::OsStrExt, path::Path, ptr};
use windows_sys::Win32::{Foundation::*, Security::{*, Authorization::*},
    System::Threading::*,
    UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL}};

fn wide(value: &OsStr) -> Vec<u16> {value.encode_wide().chain(Some(0)).collect()}
unsafe fn sid_text(sid: PSID) -> io::Result<String> {
    let mut text = ptr::null_mut();
    if ConvertSidToStringSidW(sid, &mut text) == 0 {return Err(io::Error::last_os_error());}
    let mut length = 0;
    while *text.add(length) != 0 {length += 1;}
    let result = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
    LocalFree(text.cast());
    Ok(result)
}
pub fn current_sid() -> io::Result<String> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {return Err(io::Error::last_os_error());}
        let mut bytes = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut bytes);
        // TOKEN_USER needs pointer alignment, not a byte-vector's alignment.
        let mut data = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        let ok = GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), bytes, &mut bytes);
        let result = if ok == 0 {Err(io::Error::last_os_error())}
            else {sid_text((*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid)};
        CloseHandle(token);
        result
    }
}
pub fn protect(path: &Path) -> io::Result<()> {
    safe_path(path)?;
    unsafe {
        let sid = current_sid()?;
        let inheritance = if path.is_dir() {"OICI"} else {""};
        let sddl = wide(OsStr::new(&format!("D:P(A;{inheritance};FA;;;{sid})(A;{inheritance};FA;;;SY)(A;{inheritance};FA;;;BA)")));
        let mut descriptor = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, ptr::null_mut()) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut dacl = ptr::null_mut(); let mut present = 0; let mut defaulted = 0;
        let result = if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0 {
            Err(io::Error::last_os_error())
        } else {
            let code = SetNamedSecurityInfoW(wide(path.as_os_str()).as_ptr(), SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, ptr::null_mut(), ptr::null_mut(), dacl, ptr::null());
            if code == 0 {Ok(())} else {Err(io::Error::from_raw_os_error(code as i32))}
        };
        LocalFree(descriptor);
        result
    }
}

pub fn safe_path(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {continue;}
        let info = std::fs::symlink_metadata(ancestor)?;
        if info.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(())
}

pub fn single_file(file: &std::fs::File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::*;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe {GetFileInformationByHandle(file.as_raw_handle(), &mut info)} == 0 {return Err(io::Error::last_os_error());}
    if info.nNumberOfLinks != 1 || info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        Err(io::ErrorKind::PermissionDenied.into())
    } else {Ok(())}
}

pub fn check_private(path: &Path) -> io::Result<()> {
    safe_path(path)?;
    unsafe {
        let user = current_sid()?;
        let mut descriptor = ptr::null_mut(); let mut dacl = ptr::null_mut(); let mut owner = ptr::null_mut();
        let code = GetNamedSecurityInfoW(wide(path.as_os_str()).as_ptr(), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION, &mut owner, ptr::null_mut(), &mut dacl,
            ptr::null_mut(), &mut descriptor);
        if code != 0 {return Err(io::Error::from_raw_os_error(code as i32));}
        let result = (|| {
            if dacl.is_null() || sid_text(owner)? != user {return Err(io::ErrorKind::PermissionDenied.into());}
            let mut user_allowed = false;
            for index in 0..(*dacl).AceCount as u32 {
                let mut entry = ptr::null_mut();
                if GetAce(dacl, index, &mut entry) == 0 {return Err(io::Error::last_os_error());}
                let header = &*(entry.cast::<ACE_HEADER>());
                if header.AceType as u32 != windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE {return Err(io::ErrorKind::PermissionDenied.into());}
                let ace = &*(entry.cast::<ACCESS_ALLOWED_ACE>());
                let sid = sid_text(ptr::addr_of!(ace.SidStart).cast_mut().cast())?;
                if sid != user && sid != "S-1-5-18" && sid != "S-1-5-32-544" {return Err(io::ErrorKind::PermissionDenied.into());}
                user_allowed |= sid == user && ace.Mask != 0;
            }
            if user_allowed {Ok(())} else {Err(io::ErrorKind::PermissionDenied.into())}
        })();
        LocalFree(descriptor);
        result
    }
}

pub struct ProcessJob(HANDLE);
impl ProcessJob {
    pub fn new() -> io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {return Err(io::Error::last_os_error());}
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr::addr_of!(limits).cast(), size_of_val(&limits) as u32) == 0 {
                let error = io::Error::last_os_error(); CloseHandle(job); return Err(error);
            }
            Ok(Self(job))
        }
    }
    pub fn attach(&self, process: &std::process::Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        if unsafe {windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0, process.as_raw_handle())} == 0 {
            Err(io::Error::last_os_error())
        } else {Ok(())}
    }
}
impl Drop for ProcessJob {fn drop(&mut self) {unsafe {CloseHandle(self.0);}}}

#[cfg(test)] mod tests {
    use super::*;
    use std::{process::{Command, Stdio}, io::{BufRead, BufReader}, time::Duration};
    #[test] fn closing_job_terminates_a_real_child_and_its_descendant() {
        let node = std::env::var_os("QUORUM_AGENT_NODE").expect("Set QUORUM_AGENT_NODE for Windows process tests");
        let job = ProcessJob::new().unwrap();
        let mut child = Command::new(&node).args(["-e",
            "process.stdin.once('data',()=>{const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);});"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        job.attach(&child).unwrap();
        use std::io::Write;
        child.stdin.as_mut().unwrap().write_all(b"start").unwrap();
        let mut line = String::new(); BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let pid: u32 = line.trim().parse().unwrap();
        let descendant = unsafe {OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x00100000, 0, pid)};
        assert!(!descendant.is_null());
        drop(job);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            assert!(std::time::Instant::now() < deadline, "job left its child running");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(unsafe {WaitForSingleObject(descendant, Duration::from_secs(5).as_millis() as u32)}, WAIT_OBJECT_0);
        unsafe {CloseHandle(descendant);}
    }
}
pub fn open_target(target: &OsStr) -> io::Result<()> {
    let result = unsafe {ShellExecuteW(ptr::null_mut(), wide(OsStr::new("open")).as_ptr(), wide(target).as_ptr(),
        ptr::null(), ptr::null(), SW_SHOWNORMAL)} as isize;
    if result > 32 {Ok(())} else {Err(io::Error::other("Windows could not open the target"))}
}
