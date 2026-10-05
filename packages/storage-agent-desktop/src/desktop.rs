use std::{fs::{self, File, OpenOptions}, io::{self, BufRead, BufReader, Read, Write},
    os::unix::{fs::{OpenOptionsExt, PermissionsExt}, net::{UnixListener, UnixStream}},
    path::{Path, PathBuf}, sync::mpsc::{self, Receiver}, thread, time::Duration};

pub const APP_ID: &str = "org.quorum.ChairAgent";
fn user_directory(variable: &str, fallback: &str) -> io::Result<PathBuf> {
    Ok(std::env::var_os(variable).filter(|v| !v.is_empty()).map(PathBuf::from)
        .unwrap_or(PathBuf::from(std::env::var_os("HOME").ok_or(io::ErrorKind::NotFound)?).join(fallback)))
}

pub struct Instance { _lock: File, socket: PathBuf, pub requests: Receiver<String> }
impl Drop for Instance { fn drop(&mut self) { let _ = fs::remove_file(&self.socket); } }
impl Instance {
    pub fn open(target: &str) -> io::Result<Option<Self>> {
        let directory = user_directory("XDG_CONFIG_HOME", ".config")?.join("quorum-agent");
        Self::open_in(directory, target)
    }
    fn open_in(directory: PathBuf, target: &str) -> io::Result<Option<Self>> {
        fs::create_dir_all(&directory)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).mode(0o600)
            .open(directory.join("desktop.lock"))?;
        let socket = directory.join("desktop.sock");
        if let Err(error) = lock.try_lock() {
            if !matches!(error, std::fs::TryLockError::WouldBlock) {return Err(io::Error::other(error));}
            for _ in 0..20 {
                if let Ok(mut stream) = UnixStream::connect(&socket) {
                    stream.write_all(serde_json::to_string(target)?.as_bytes())?;
                    stream.write_all(b"\n")?;
                    return Ok(None);
                }
                thread::sleep(Duration::from_millis(50));
            }
            return Err(io::Error::other("The running Chair Agent did not respond."));
        }
        match fs::remove_file(&socket) {Ok(()) => (), Err(e) if e.kind() == io::ErrorKind::NotFound => (), Err(e) => return Err(e)}
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        let (tx, requests) = mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut line = String::new();
                if BufReader::new(stream.take(65536)).read_line(&mut line).is_ok() {
                    if let Ok(target) = serde_json::from_str::<String>(&line) {let _ = tx.send(target);}
                }
            }
        });
        Ok(Some(Self {_lock: lock, socket, requests}))
    }
}
fn exec_quote(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\\\\\").replace('"', "\\\"").replace('`', "\\\\`").replace('$', "\\\\$").replace('%', "%%");
    format!("\"{escaped}\"")
}
fn desktop_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t")
}
pub fn register(exe: &Path, node: &Path, bridge: &Path) -> io::Result<()> {
    let data = user_directory("XDG_DATA_HOME", ".local/share")?;
    let applications = data.join("applications");
    let icons = data.join("icons/hicolor/scalable/apps");
    let mime = data.join("mime/packages");
    for directory in [&applications, &icons, &mime] {fs::create_dir_all(directory)?;}
    let icon_path = icons.join(format!("{APP_ID}.svg"));
    fs::write(&icon_path, include_str!("../assets/quorum-agent.svg"))?;
    // A file icon also works before a running desktop refreshes its icon theme cache.
    let icon = desktop_value(&icon_path.to_string_lossy());
    let launch = format!("env {} {} {} --open %u", exec_quote(&format!("QUORUM_AGENT_NODE={}", node.display())),
        exec_quote(&format!("QUORUM_AGENT_BRIDGE={}", bridge.display())), exec_quote(&exe.to_string_lossy()));
    fs::write(applications.join(format!("{APP_ID}.desktop")), format!(
        "[Desktop Entry]\nType=Application\nName=Quorum Chair Agent\nName[zh_CN]=Quorum 主席 Agent\nExec={launch}\nIcon={icon}\nStartupWMClass={APP_ID}\nTerminal=false\nCategories=Office;\nMimeType=x-scheme-handler/quorum-agent;application/x-quorum-agent-pairing;\n"))?;
    fs::write(mime.join("quorum-agent.xml"), "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<mime-info xmlns=\"http://www.freedesktop.org/standards/shared-mime-info\"><mime-type type=\"application/x-quorum-agent-pairing\"><comment>Quorum Agent pairing configuration</comment><glob pattern=\"*.quorum-agent\"/></mime-type></mime-info>\n")?;
    for (program, args) in [
        ("update-desktop-database", vec![applications.to_string_lossy().into_owned()]),
        ("update-mime-database", vec![data.join("mime").to_string_lossy().into_owned()]),
        ("xdg-mime", vec!["default".into(), format!("{APP_ID}.desktop"), "x-scheme-handler/quorum-agent".into()]),
        ("xdg-mime", vec!["default".into(), format!("{APP_ID}.desktop"), "application/x-quorum-agent-pairing".into()]),
    ] {
        let status = std::process::Command::new(program).args(args).status()?;
        if !status.success() {return Err(io::Error::other("Desktop registration failed"));}
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn forwards_to_one_instance_and_recovers_a_stale_socket() {
        let directory = std::env::temp_dir().join(format!("quorum-instance-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let first = Instance::open_in(directory.clone(), "").unwrap().unwrap();
        assert!(Instance::open_in(directory.clone(), "quorum-agent://pair#test").unwrap().is_none());
        assert_eq!(first.requests.recv_timeout(Duration::from_secs(2)).unwrap(), "quorum-agent://pair#test");
        assert_eq!(fs::metadata(&first.socket).unwrap().permissions().mode() & 0o777, 0o600);
        drop(first);
        fs::write(directory.join("desktop.sock"), "stale").unwrap();
        let reopened = Instance::open_in(directory.clone(), "").unwrap().unwrap();
        drop(reopened); fs::remove_dir_all(directory).unwrap();
    }
    #[test] fn quotes_desktop_arguments() {
        assert_eq!(exec_quote("/a b/100%/agent"), "\"/a b/100%%/agent\"");
        assert!(exec_quote("$(touch nope)").contains("\\\\$"));
    }
    #[test] fn escapes_desktop_icon_paths_without_shell_quoting() {
        assert_eq!(desktop_value("/home/a b/图标.svg"), "/home/a b/图标.svg");
        assert_eq!(desktop_value("/a\\b\nIcon=other\r\t.svg"), "/a\\\\b\\nIcon=other\\r\\t.svg");
    }
}

// Resolve only recorded files inside the active storage directory, never links or directories.
pub fn local_file_path(root: &Path, relative: &str) -> io::Result<PathBuf> {
    if root.as_os_str().is_empty() || relative.is_empty() {return Err(io::ErrorKind::InvalidInput.into());}
    let root = root.canonicalize()?;
    let mut path = root.clone();
    for part in Path::new(relative).components() {
        let std::path::Component::Normal(name) = part else {return Err(io::ErrorKind::InvalidInput.into());};
        if name.to_string_lossy().starts_with(".quorum-") {return Err(io::ErrorKind::PermissionDenied.into());}
        path.push(name);
        if path.symlink_metadata()?.file_type().is_symlink() {return Err(io::ErrorKind::PermissionDenied.into());}
    }
    let path = path.canonicalize()?;
    if !path.starts_with(root) || !path.is_file() {return Err(io::ErrorKind::PermissionDenied.into());}
    Ok(path)
}

#[cfg(test)] mod local_file_tests {
    use super::*;
    #[test] fn resolves_regular_files_and_rejects_unsafe_or_missing_targets() {
        let root = std::env::temp_dir().join(format!("quorum-open-file-{}", std::process::id()));
        fs::create_dir_all(root.join("材料")).unwrap();
        fs::write(root.join("材料/实际文件.pdf"), "test").unwrap();
        assert_eq!(local_file_path(&root, "材料/实际文件.pdf").unwrap(), root.canonicalize().unwrap().join("材料/实际文件.pdf"));
        std::os::unix::fs::symlink(root.join("材料/实际文件.pdf"), root.join("link.pdf")).unwrap();
        for name in ["", "missing.pdf", "../outside.pdf", "/etc/passwd", "材料", "link.pdf", ".quorum-storage.json"] {
            assert!(local_file_path(&root, name).is_err(), "{name}");
        }
        fs::remove_dir_all(root).unwrap();
    }
}
