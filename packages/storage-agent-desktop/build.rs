use std::{env, path::PathBuf, process::Command};

fn main() {
    slint_build::compile_with_config(
        "ui/main.slint",
        slint_build::CompilerConfiguration::new().with_style("fluent".into()),
    )
    .unwrap();
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("quorum-agent.res");
        let rc = env::var_os("QUORUM_RC").map(PathBuf::from).unwrap_or_else(|| {
            let kits = PathBuf::from(env::var_os("ProgramFiles(x86)").unwrap_or_else(|| "C:/Program Files (x86)".into()))
                .join("Windows Kits/10/bin");
            let mut versions: Vec<_> = std::fs::read_dir(kits).expect("Windows SDK resource compiler is required")
                .filter_map(Result::ok).map(|entry| entry.path().join("x64/rc.exe"))
                .filter(|path| path.is_file()).collect();
            versions.sort(); versions.pop().expect("Windows SDK x64 rc.exe is required")
        });
        assert!(Command::new(rc).current_dir(&manifest).arg("/nologo").arg("/fo").arg(&out)
            .arg("assets/quorum-agent.rc").status().expect("Cannot run Windows resource compiler").success(),
            "Windows icon/resource compilation failed");
        println!("cargo:rustc-link-arg-bin=quorum-storage-agent-desktop={}", out.display());
        println!("cargo:rerun-if-changed=assets/quorum-agent.rc");
        println!("cargo:rerun-if-changed=assets/quorum-agent.ico");
        println!("cargo:rerun-if-env-changed=QUORUM_RC");
    }
}
