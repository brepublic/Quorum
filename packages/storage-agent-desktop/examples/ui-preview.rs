#[path = "../src/localization.rs"]
mod localization;
use localization::translate;
// Native Wayland layout smoke test. Uses clearly labelled synthetic rows, never an Agent config.
use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
use slint::{ComponentHandle, ModelRc, VecModel};
use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;
slint::include_modules!();
// Render the production Slint component at exact sizes without compositor tiling.
// This is a layout fixture, not an account or file-sync simulation.
struct PreviewPlatform(Rc<MinimalSoftwareWindow>);
impl slint::platform::Platform for PreviewPlatform {
    fn create_window_adapter(
        &self,
    ) -> Result<Rc<dyn slint::platform::WindowAdapter>, slint::PlatformError> {
        Ok(self.0.clone())
    }
}
// Exercise actual Slint hit targets and keyboard focus; callbacks are recorded, never sent to a server.
fn exercise_login(window: &MainWindow, redraw: impl Fn()) {
    use slint::platform::{Key, PointerEventButton, WindowEvent};
    let actions = Rc::new(RefCell::new(Vec::<String>::new()));
    let recorded = actions.clone();
    window.on_action(move |action| recorded.borrow_mut().push(action.to_string()));
    let click = |x, y| {
        let position = slint::LogicalPosition::new(x, y);
        window.window().dispatch_event(WindowEvent::PointerPressed {
            position,
            button: PointerEventButton::Left,
        });
        window
            .window()
            .dispatch_event(WindowEvent::PointerReleased {
                position,
                button: PointerEventButton::Left,
            });
        redraw();
    };
    let key = |text: slint::SharedString| {
        window
            .window()
            .dispatch_event(WindowEvent::KeyPressed { text: text.clone() });
        window
            .window()
            .dispatch_event(WindowEvent::KeyReleased { text });
        redraw();
    };
    assert_eq!(window.get_page(), "login");
    click(650., 187.);
    assert!(window.get_login_network());
    key(" ".into());
    assert!(
        !window.get_login_network(),
        "Space must activate the focused disclosure"
    );
    click(650., 502.);
    assert!(window.get_login_options());
    click(390., 565.);
    assert_eq!(actions.borrow().last().unwrap(), "import");
    click(390., 603.);
    assert_eq!(actions.borrow().last().unwrap(), "enter-manual");
    click(650., 502.);
    assert!(!window.get_login_options());
    click(370., 301.);
    key("chair@example.com".into());
    key(Key::Tab.into());
    key("example-password".into());
    assert_eq!(window.get_email(), "chair@example.com");
    assert_eq!(
        window.get_password(),
        "example-password",
        "Tab from email must focus password"
    );
    key(Key::Return.into());
    assert_eq!(actions.borrow().last().unwrap(), "login");
    click(315., 502.);
    assert!(window.get_language_menu());
    key(Key::Escape.into());
    assert!(!window.get_language_menu());
    click(315., 502.);
    click(480., 334.);
    assert_eq!(window.get_language(), "en");
    assert!(!window.get_language_menu());
    assert_eq!(
        window.get_email(),
        "chair@example.com",
        "Language changes must preserve input"
    );
    assert_eq!(window.get_password(), "example-password");
    window.set_page("home".into());
    window.set_loaded(true);
    window.set_running(true);
    window.set_show_settings(false);
    redraw();
    click(910., 28.);
    click(760., 76.);
    assert_eq!(actions.borrow().last().unwrap(), "navigate-settings");
    click(910., 28.);
    click(760., 110.);
    assert_eq!(actions.borrow().last().unwrap(), "navigate-logs");
    click(910., 28.);
    click(760., 144.);
    assert_eq!(actions.borrow().last().unwrap(), "open-web");
    println!("Slint interaction smoke passed: disclosure, keyboard activation, import/manual actions, email → Tab → password → Enter, language/Escape, draft preservation and application menu actions");
}
fn exercise_connection(window: &MainWindow, redraw: impl Fn()) {
    use slint::platform::{PointerEventButton, WindowEvent};
    let actions = Rc::new(RefCell::new(Vec::<String>::new()));
    let recorded = actions.clone();
    window.on_action(move |action| recorded.borrow_mut().push(action.to_string()));
    let click = |x, y| {
        let position = slint::LogicalPosition::new(x, y);
        window.window().dispatch_event(WindowEvent::PointerPressed {position, button: PointerEventButton::Left});
        window.window().dispatch_event(WindowEvent::PointerReleased {position, button: PointerEventButton::Left});
        redraw();
    };
    assert!(window.get_show_settings() && window.get_loaded() && window.get_running());
    click(200., 301.);
    assert_eq!(actions.borrow().last().unwrap(), "confirm-switch");
    click(300., 301.);
    assert_eq!(actions.borrow().last().unwrap(), "confirm-unpair");
    // Inject the confirmation state; this preview never invokes the Node bridge.
    window.set_switch_committee(true);
    window.set_confirm_unpair(true);
    redraw();
    click(590., 436.);
    assert_eq!(actions.borrow().last().unwrap(), "unpair", "Confirmation must work while syncing");
    window.set_busy(true);
    window.set_status("STOPPING".into());
    redraw();
    click(320., 436.);
    assert!(window.get_confirm_unpair(), "An active disconnect cannot be cancelled midway");
    window.set_busy(false);
    redraw();
    click(320., 436.);
    assert!(!window.get_confirm_unpair());
    window.set_page("login".into());
    window.set_loaded(false);
    window.set_show_settings(false);
    window.set_feedback("Authorization revoked".into());
    redraw();
    click(678., 198.);
    assert!(window.get_feedback().is_empty(), "Result notices must be dismissible");
    println!("Connection entry points, running confirmation, busy guard and notice dismissal passed");
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let offscreen = std::env::args().any(|arg| arg == "--offscreen").then(|| {
        let adapter = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
        slint::platform::set_platform(Box::new(PreviewPlatform(adapter.clone()))).unwrap();
        adapter
    });
    let window = MainWindow::new()?;
    if std::env::args().any(|arg| arg == "--light") {
        window
            .global::<Palette>()
            .set_color_scheme("light".parse().unwrap());
    }
    if std::env::args().any(|arg| arg == "--dark") {
        window
            .global::<Palette>()
            .set_color_scheme("dark".parse().unwrap());
    }
    let language = if std::env::args().any(|arg| arg == "--en") {
        "en"
    } else {
        "zh-CN"
    };
    window.on_translate(|key, language| translate(key.as_str(), language.as_str()).into());
    window.set_language(language.into());
    window.set_page(
        if std::env::args().any(|arg| arg == "--manual") {
            "manual"
        } else if std::env::args().any(|arg| arg == "--password") {
            "password"
        } else if std::env::args().any(|arg| arg == "--login") {
            "login"
        } else if std::env::args().any(|arg| arg == "--committees") {
            "committees"
        } else {
            "home"
        }
        .into(),
    );
    window.set_candidates_loaded(true);
    window.set_login_options(std::env::args().any(|arg| arg == "--options"));
    window.set_login_network(std::env::args().any(|arg| arg == "--network"));
    window.set_language_menu(std::env::args().any(|arg| arg == "--language"));
    window.set_committees(ModelRc::new(VecModel::from(vec![CommitteeRow {
        id: "preview".into(),
        name: "联合国安全理事会".into(),
        detail: "样例会议 · 样例议题".into(),
        paused: true,
        host: "".into(),
        provider: "SERVER_VOLUME".into(),
    }])));
    window.set_files_loaded(true);
    window.set_committee_status("PAUSED".into());
    window.set_editing(std::env::args().any(|arg| arg == "--edit"));
    window.set_status("RUNNING".into());
    if std::env::args().any(|arg| matches!(arg.as_str(), "--fresh-times" | "--stale-times" | "--stale-cache")) {
        window.set_committee_status("ACTIVE".into());
        let now = std::time::SystemTime::now();
        let stale = std::env::args().any(|arg| arg == "--stale-times");
        let stale_cache = stale || std::env::args().any(|arg| arg == "--stale-cache");
        let timestamp = |seconds| chrono::DateTime::<chrono::Utc>::from(now - std::time::Duration::from_secs(seconds)).to_rfc3339();
        window.set_last_connection(timestamp(if stale { 120 } else { 10 }).into());
        window.set_observed(timestamp(if stale_cache { 3600 } else { 10 }).into());
        window.set_last_connection_age(localization::stale_time(window.get_last_connection().as_str(), now, language).into());
        window.set_observed_age(localization::stale_time(window.get_observed().as_str(), now, language).into());
    }
    window.set_committee_name("联合国安全理事会".into());
    window.set_root_path("/home/chair/Documents/Quorum/联合国安全理事会-1".into());
    window.set_server_url("https://quorum.example.com".into());
    window.set_config_path("/home/chair/.config/quorum-agent/configurations/agent.json".into());
    window.set_setup_mode(std::env::args().any(|arg| arg == "--setup"));
    window.set_show_advanced(std::env::args().any(|arg| arg == "--advanced"));
    window.set_show_logs(std::env::args().any(|arg| arg == "--logs"));
    if std::env::args().any(|arg| arg == "--discard") {
        window.set_confirm_discard("open".into());
    }

    let settings = std::env::args().any(|arg| arg == "--settings");
    window.set_loaded(
        window.get_page() == "home"
            && !window.get_setup_mode()
            && (!settings || std::env::args().any(|arg| arg == "--paired")),
    );
    window.set_confirm_unpair(std::env::args().any(|arg| arg == "--confirm-unpair"));
    if std::env::args().any(|arg| arg == "--unpair-failed") {
        window.set_unpair_failed(true);
        window.set_error_stage("revoke".into());
        window.set_error_code("AUTHENTICATION_REQUIRED".into());
    }
    window
        .set_running(window.get_loaded() && !window.get_editing() && !window.get_confirm_unpair());
    if window.get_editing() || window.get_confirm_unpair() {
        window.set_status("STOPPED".into());
    }
    if std::env::args().any(|arg| arg == "--switch-committee") {
        window.set_switch_committee(true);
        window.set_confirm_unpair(true);
        window.set_running(true);
        window.set_status("RUNNING".into());
    }
    if std::env::args().any(|arg| arg == "--stopping") {
        window.set_busy(true);
        window.set_status("STOPPING".into());
    }
    if std::env::args().any(|arg| arg == "--disconnected-notice") {
        window.set_feedback("Authorization revoked".into());
    }
    if std::env::args().any(|arg| arg == "--local-disconnect-notice") {
        window.set_feedback("Unpaired locally; server authorization has not been confirmed revoked".into());
    }
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
    if window.get_setup_mode() {
        window.set_show_settings(true);
        window.set_account_setup(true);
    }
    if std::env::args().any(|arg| arg == "--transfer") {
        window.set_current_host("Chair-Laptop".into());
    }
    if std::env::args().any(|arg| arg == "--empty") {
        window.set_files(ModelRc::new(VecModel::default()));
    }
    if std::env::args().any(|arg| arg == "--offline") {
        window.set_status("DISCONNECTED".into());
        window.set_committee_status("".into());
    }
    window.set_log_text("14:32:05 storage_agent.connected\n14:32:08 storage_agent.sync_started\n14:32:12 storage_agent.sync_completed".into());
    if std::env::args().any(|arg| arg == "--error") {
        window.set_error_stage("tls".into());
        window.set_error_code("UNABLE_TO_GET_ISSUER_CERT_LOCALLY".into());
    }
    window.show()?;
    if let Some(adapter) = offscreen {
        let (width, height) = if std::env::args().any(|arg| arg == "--small") {
            (760, 600)
        } else {
            (960, 720)
        };
        adapter.set_size(slint::PhysicalSize::new(width, height));
        slint::platform::update_timers_and_animations();
        let mut pixels = slint::SharedPixelBuffer::<slint::Rgb8Pixel>::new(width, height);
        adapter.draw_if_needed(|renderer| {
            renderer.render(pixels.make_mut_slice(), width as usize);
        });
        if std::env::args().any(|arg| matches!(arg.as_str(), "--exercise-login" | "--exercise-connection")) {
            let exercise = if std::env::args().any(|arg| arg == "--exercise-connection") {exercise_connection} else {exercise_login};
            exercise(&window, || {
                slint::platform::update_timers_and_animations();
                let mut frame = slint::SharedPixelBuffer::<slint::Rgb8Pixel>::new(width, height);
                adapter.draw_if_needed(|renderer| {
                    renderer.render(frame.make_mut_slice(), width as usize);
                });
            });
            window.window().request_redraw();
            adapter.draw_if_needed(|renderer| {
                renderer.render(pixels.make_mut_slice(), width as usize);
            });
        }
        if std::env::args().any(|arg| arg == "--scroll-bottom") {
            window
                .window()
                .dispatch_event(slint::platform::WindowEvent::PointerScrolled {
                    position: slint::LogicalPosition::new(400., 450.),
                    delta_x: 0.,
                    delta_y: -2000.,
                });
            slint::platform::update_timers_and_animations();
            adapter.draw_if_needed(|renderer| {
                renderer.render(pixels.make_mut_slice(), width as usize);
            });
        }
        let path = std::env::var("QUORUM_UI_CAPTURE")
            .unwrap_or_else(|_| "/tmp/quorum-agent-ui.ppm".into());
        let mut file = std::fs::File::create(path)?;
        write!(file, "P6\n{width} {height}\n255\n")?;
        file.write_all(pixels.as_bytes())?;
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--small") {
        window
            .window()
            .set_size(slint::LogicalSize::new(760.0, 600.0));
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
