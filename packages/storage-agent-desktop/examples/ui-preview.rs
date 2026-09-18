#[path = "../src/localization.rs"]
mod localization;
use localization::translate;
// Native Wayland layout smoke test. Uses clearly labelled synthetic rows, never an Agent config.
use slint::{ComponentHandle, ModelRc, VecModel};
use std::io::Write;
slint::include_modules!();
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let window = MainWindow::new()?;
    let language = if std::env::args().any(|arg| arg == "--en") { "en" } else { "zh-CN" };
    window.on_translate(|key, language| translate(key.as_str(), language.as_str()).into());
    window.set_language(language.into());
    window.set_status("RUNNING".into());
    let settings = std::env::args().any(|arg| arg == "--settings");
    window.set_loaded(!settings || std::env::args().any(|arg| arg == "--paired"));
    window.set_confirm_unpair(std::env::args().any(|arg| arg == "--confirm-unpair"));
    window.set_running(!settings);
    window.set_files(ModelRc::new(VecModel::from(vec![
        FileRow {
            name: "决议草案 - 中文显示测试.pdf".into(),
            size: "12.4 MiB".into(),
            local: translate("DOWNLOADING", language).into(),
            cache: translate("CACHE_READY", language).into(),
            transfer: "6.2 / 12.4 MiB".into(),
            fraction: 0.5,
            progressing: true,
        },
        FileRow {
            name: "工作文件.docx".into(),
            size: "542 KiB".into(),
            local: translate("READY_REVIEW", language).into(),
            cache: translate("CACHE_READY", language).into(),
            ..Default::default()
        },
        FileRow {
            name: "已公开的立场文件.pdf".into(),
            size: "24 MiB".into(),
            local: translate("READY_PUBLISHED", language).into(),
            cache: translate("REFILLING", language).into(),
            transfer: "8 / 24 MiB".into(),
            fraction: 0.333,
            progressing: true,
        },
        FileRow {
            name: "本地笔记.txt".into(),
            size: "2 KiB".into(),
            local: translate("READY_UNSUBMITTED", language).into(),
            cache: translate("CACHE_MISSING_LOCAL_READY", language).into(),
            ..Default::default()
        },
    ])));
    window.set_show_settings(std::env::args().any(|arg| arg == "--settings"));
    if std::env::args().any(|arg| arg == "--error") {
        window.set_error_stage("tls".into());
        window.set_error_code("UNABLE_TO_GET_ISSUER_CERT_LOCALLY".into());
    }
    if std::env::args().any(|arg| arg == "--small") {
        window
            .window()
            .set_size(slint::LogicalSize::new(920.0, 660.0));
    }
    let weak = window.as_weak();
    let timer = slint::Timer::default();
    timer.start(
        slint::TimerMode::SingleShot,
        std::time::Duration::from_millis(800),
        move || {
            if let Some(window) = weak.upgrade() {
                let image = window.window().take_snapshot().unwrap();
                let path = std::env::var("QUORUM_UI_CAPTURE")
                    .unwrap_or_else(|_| "/tmp/quorum-agent-ui.ppm".into());
                let mut file = std::fs::File::create(path).unwrap();
                write!(file, "P6\n{} {}\n255\n", image.width(), image.height()).unwrap();
                for p in image.as_bytes().chunks_exact(4) {
                    file.write_all(&p[..3]).unwrap();
                }
            }
            slint::quit_event_loop().unwrap();
        },
    );
    window.run()?;
    Ok(())
}
