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
pub fn open_target(target: &OsStr) -> io::Result<()> {
    let result = unsafe {ShellExecuteW(ptr::null_mut(), wide(OsStr::new("open")).as_ptr(), wide(target).as_ptr(),
        ptr::null(), ptr::null(), SW_SHOWNORMAL)} as isize;
    if result > 32 {Ok(())} else {Err(io::Error::other("Windows could not open the target"))}
}
