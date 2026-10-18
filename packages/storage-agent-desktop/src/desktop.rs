use std::{io, path::{Path, PathBuf}};
#[cfg(unix)] #[path = "desktop/linux.rs"] mod linux;
#[cfg(unix)] pub use linux::*;
#[cfg(windows)] #[path = "desktop/windows.rs"] mod windows;
#[cfg(windows)] pub use windows::*;

pub use crate::localization::preferences::config_directory;

pub fn open_target(target: &std::ffi::OsStr) -> io::Result<()> {
    #[cfg(windows)] {crate::windows::open_target(target)}
    #[cfg(unix)] {if host_command("xdg-open").arg(target).status()?.success() {Ok(())}
        else {Err(io::Error::other("Cannot open target"))}}
}

// Resolve only recorded files inside the active storage directory, never links or directories.
pub fn local_file_path(root: &Path, relative: &str) -> io::Result<PathBuf> {
    if root.as_os_str().is_empty() || relative.is_empty() {return Err(io::ErrorKind::InvalidInput.into());}
    let root = root.canonicalize()?;
    let mut path = root.clone();
    for part in Path::new(relative).components() {
        let std::path::Component::Normal(name) = part else {return Err(io::ErrorKind::InvalidInput.into());};
        if name.to_string_lossy().to_ascii_lowercase().starts_with(".quorum-") {return Err(io::ErrorKind::PermissionDenied.into());}
        path.push(name);
        if path.symlink_metadata()?.file_type().is_symlink() {return Err(io::ErrorKind::PermissionDenied.into());}
    }
    let path = path.canonicalize()?;
    if !path.starts_with(root) || !path.is_file() {return Err(io::ErrorKind::PermissionDenied.into());}
    #[cfg(windows)] {
        crate::windows::safe_path(&path)?;
        crate::windows::single_file(&std::fs::File::open(&path)?)?;
    }
    Ok(path)
}

#[cfg(test)] mod local_file_tests {
    use super::*;
    use std::fs;
    #[test] fn resolves_regular_files_and_rejects_unsafe_or_missing_targets() {
        let root = std::env::temp_dir().join(format!("quorum-open-file-{}", std::process::id()));
        fs::create_dir_all(root.join("材料")).unwrap();
        fs::write(root.join("材料/实际文件.pdf"), "test").unwrap();
        assert_eq!(local_file_path(&root, "材料/实际文件.pdf").unwrap(), root.canonicalize().unwrap().join("材料/实际文件.pdf"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("材料/实际文件.pdf"), root.join("link.pdf")).unwrap();
        for name in ["", "missing.pdf", "../outside.pdf", "/etc/passwd", "材料", "link.pdf", ".quorum-storage.json"] {
            assert!(local_file_path(&root, name).is_err(), "{name}");
        }
        fs::remove_dir_all(root).unwrap();
    }
}
