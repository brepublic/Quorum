use std::{fs::{self, File, OpenOptions}, io::{self, Read, Write}, path::{Path, PathBuf},
    sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver}}, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

// Private filesystem IPC avoids network listeners. Publish requests atomically;
// the kernel lock decides which process is allowed to consume them.
pub struct Instance {_lock: File, alive: Arc<AtomicBool>, pub requests: Receiver<String>}
impl Drop for Instance {fn drop(&mut self) {self.alive.store(false, Ordering::Release);}}
impl Instance {
    pub fn open(target: &str) -> io::Result<Option<Self>> {Self::open_in(super::config_directory()?, target)}
    fn open_in(directory: PathBuf, target: &str) -> io::Result<Option<Self>> {
        fs::create_dir_all(&directory)?;
        if fs::symlink_metadata(&directory)?.file_type().is_symlink() {return Err(io::ErrorKind::PermissionDenied.into());}
        crate::windows::protect(&directory)?;
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(directory.join("desktop.lock"))?;
        let queue = directory.join("requests");
        match lock.try_lock() {
            Ok(()) => (),
            Err(std::fs::TryLockError::WouldBlock) => {
                if target.len() > 32768 {return Err(io::ErrorKind::InvalidInput.into());}
                for _ in 0..40 {
                    if queue.is_dir() {break;}
                    thread::sleep(Duration::from_millis(50));
                }
                let name = format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
                let temporary = queue.join(format!("{name}.tmp"));
                let published = queue.join(format!("{name}.json"));
                let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary)?;
                file.write_all(serde_json::to_string(target)?.as_bytes())?; file.sync_all()?; drop(file);
                fs::rename(&temporary, &published)?;
                // Acknowledgement means the live window consumed this request.
                for _ in 0..40 {
                    if !published.exists() {return Ok(None);}
                    thread::sleep(Duration::from_millis(50));
                }
                let _ = fs::remove_file(published);
                return Err(io::Error::other("The running Chair Agent did not respond"));
            }
            Err(error) => return Err(io::Error::other(error)),
        }
        fs::create_dir_all(&queue)?; crate::windows::protect(&queue)?;
        let alive = Arc::new(AtomicBool::new(true)); let active = alive.clone();
        let (tx, requests) = mpsc::channel();
        thread::spawn(move || {
            while active.load(Ordering::Acquire) {
                if let Ok(entries) = fs::read_dir(&queue) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().is_none_or(|ext| ext != "json") {continue;}
                        if let Ok(info) = fs::symlink_metadata(&path) {
                            if !info.is_file() || info.file_type().is_symlink() || info.len() > 65536 {continue;}
                            if let Ok(file) = File::open(&path) {
                                let mut source = String::new();
                                if file.take(65536).read_to_string(&mut source).is_ok() {
                                    if let Ok(target) = serde_json::from_str::<String>(&source) {let _ = tx.send(target);}
                                }
                            }
                            let _ = fs::remove_file(path);
                        }
                    }
                }
                thread::sleep(Duration::from_millis(50));
            }
        });
        Ok(Some(Self {_lock: lock, alive, requests}))
    }
}
pub fn register(_exe: &Path, _node: &Path, _bridge: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Windows installation belongs to the release stage"))
}
pub fn unregister() -> io::Result<()> {Err(io::ErrorKind::Unsupported.into())}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn forwards_one_instance_and_releases_on_exit() {
        let directory = std::env::temp_dir().join(format!("quorum-windows-instance-{}", std::process::id()));
        let first = Instance::open_in(directory.clone(), "").unwrap().unwrap();
        assert!(Instance::open_in(directory.clone(), "quorum-agent://pair#测试").unwrap().is_none());
        assert_eq!(first.requests.recv_timeout(Duration::from_secs(2)).unwrap(), "quorum-agent://pair#测试");
        drop(first); thread::sleep(Duration::from_millis(100));
        let recovered = Instance::open_in(directory.clone(), "").unwrap().unwrap(); drop(recovered);
        thread::sleep(Duration::from_millis(100)); fs::remove_dir_all(directory).unwrap();
    }
}
