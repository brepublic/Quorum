use std::{io, path::PathBuf};
pub fn config_directory() -> io::Result<PathBuf> {
    #[cfg(windows)] let base = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())
        .map(PathBuf::from).ok_or(io::ErrorKind::NotFound)?;
    #[cfg(unix)] let base = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or(io::ErrorKind::NotFound)?;
    Ok(base.join("quorum-agent"))
}

pub fn system_language() -> String {
    #[cfg(windows)] {
        let mut buffer = [0u16; 85];
        let count = unsafe {windows_sys::Win32::Globalization::GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32)};
        if count > 0 {String::from_utf16_lossy(&buffer[..count as usize - 1])} else {"en".into()}
    }
    #[cfg(unix)] {std::env::var("LANG").unwrap_or_default()}
}
