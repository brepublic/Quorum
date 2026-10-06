#[cfg(windows)] mod windows;

#[cfg(windows)] fn run() -> std::io::Result<()> {
    use std::{fs::OpenOptions, io::{Read, Write}, os::windows::{fs::OpenOptionsExt, io::AsRawHandle}, path::PathBuf};
    use windows_sys::Win32::Storage::FileSystem::*;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {return Err(std::io::ErrorKind::InvalidInput.into());}
    let path = PathBuf::from(&args[1]);
    match args[0].to_str() {
        Some("--protect") => windows::protect(&path),
        Some("--check-private") => windows::check_private(&path),
        Some("--hold-file") => {
            windows::safe_path(&path)?;
            let file = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(&path)?;
            println!("HELD"); std::io::stdout().flush()?;
            let mut buffer = [0u8; 32];
            while std::io::stdin().read(&mut buffer)? != 0 {}
            drop(file); Ok(())
        }
        Some("--lock-root") => {
            windows::safe_path(&path)?;
            if !path.is_dir() {return Err(std::io::ErrorKind::InvalidInput.into());}
            let target = path.join(".quorum-storage.lock");
            let file = OpenOptions::new().create(true).truncate(false).read(true).write(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(&target)?;
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            if unsafe {GetFileInformationByHandle(file.as_raw_handle(), &mut info)} == 0 {return Err(std::io::Error::last_os_error());}
            if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 || info.nNumberOfLinks != 1 {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            match file.try_lock() {
                Ok(()) => (),
                Err(std::fs::TryLockError::WouldBlock) => {println!("AGENT_ALREADY_RUNNING"); return Ok(());}
                Err(error) => return Err(std::io::Error::other(error)),
            }
            println!("LOCKED"); std::io::stdout().flush()?;
            // EOF on the owning Node process's pipe releases the kernel lock,
            // including when that process is killed unexpectedly.
            let mut buffer = [0u8; 32];
            while std::io::stdin().read(&mut buffer)? != 0 {}
            drop(file); Ok(())
        }
        _ => Err(std::io::ErrorKind::InvalidInput.into()),
    }
}
fn main() {
    #[cfg(windows)] if run().is_err() {eprintln!("WINDOWS_PLATFORM_FAILED"); std::process::exit(1);}
    #[cfg(not(windows))] {eprintln!("Windows platform helper is only available on Windows"); std::process::exit(1);}
}
