#[path = "../src/localization.rs"]
mod localization;
use localization::translate;
// Native Wayland layout smoke test. Uses clearly labelled synthetic rows, never an Agent config.
use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
use slint::{ComponentHandle, Model, ModelRc, VecModel};
use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;
slint::include_modules!();
// Render the production Slint component at exact sizes without compositor tiling.
// This is a layout fixture, not an account or file-sync simulation.
thread_local! {static TEST_CLIPBOARD: RefCell<String> = RefCell::new(String::new());}
struct PreviewPlatform(Rc<MinimalSoftwareWindow>);
impl slint::platform::Platform for PreviewPlatform {
    fn set_clipboard_text(&self, text: &str, _: slint::platform::Clipboard) {TEST_CLIPBOARD.with(|c| *c.borrow_mut() = text.into());}
    fn clipboard_text(&self, _: slint::platform::Clipboard) -> Option<String> {Some(TEST_CLIPBOARD.with(|c| c.borrow().clone()))}
    fn create_window_adapter(
        &self,
    ) -> Result<Rc<dyn slint::platform::WindowAdapter>, slint::PlatformError> {
        Ok(self.0.clone())
    }
}
// Exercise actual Slint hit targets and keyboard focus; callbacks are recorded, never sent to a server.
fn exercise_overwrite(window: &MainWindow, redraw: impl Fn()) {
    use slint::platform::{Key, WindowEvent};
    let decisions = Rc::new(RefCell::new(Vec::new()));
    let recorded = decisions.clone();
    window.on_overwrite_decision(move |confirmed| recorded.borrow_mut().push(confirmed));
    window.set_overwrite_path("/home/主席/会议配置/agent-config.json".into());
    window.set_busy(true);
    redraw();
    assert!(!window.get_controls_enabled());
    for text in [Key::Return.into(), Key::Escape.into()] {
        window.window().dispatch_event(WindowEvent::KeyPressed {text});
    }
    assert_eq!(*decisions.borrow(), vec![false, false], "default Enter and Escape must cancel");
    let size = window.window().size();
    let position = slint::LogicalPosition::new(size.width as f32 / 2. + 210., size.height as f32 / 2. + 44.);
    window.window().dispatch_event(WindowEvent::PointerPressed {position, button: slint::platform::PointerEventButton::Left});
    window.window().dispatch_event(WindowEvent::PointerReleased {position, button: slint::platform::PointerEventButton::Left});
    assert_eq!(*decisions.borrow(), vec![false, false, true], "Overwrite requires explicit activation");
    // The overlay remains for screenshot inspection; the callback only records decisions.
}
fn exercise_login(window: &MainWindow, redraw: impl Fn()) {
    use slint::platform::{Key, PointerEventButton, WindowEvent};
    let actions = Rc::new(RefCell::new(Vec::<String>::new()));
    let recorded = actions.clone();
    window.on_action(move |action| recorded.borrow_mut().push(action.to_string()));
    let click = |x, y| {
        let position = slint::LogicalPosition::new(x, y);
        window.window().dispatch_event(WindowEvent::PointerMoved {position});
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
    click(666., 376.);
    assert!(window.get_show_password());
    click(666., 376.);
    assert!(!window.get_show_password());
    for code in ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "NETWORK_ERROR", "OPERATION_FAILED", "INCORRECT_CREDENTIALS"] {
        window.set_error_code(code.into()); redraw();
        assert_eq!(window.get_password(), "example-password");
        // Server results rebuild conditional sections; focus the retained password and retry.
        window.invoke_focus_password(); redraw();
        let before = actions.borrow().len();
        key(Key::Return.into());
        assert_eq!(actions.borrow().len(), before + 1);
        assert_eq!(actions.borrow().last().unwrap(), "login");
        window.set_error_code("".into()); redraw();
    }
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
    assert!(window.get_running() && !window.get_busy() && !window.get_show_logs() && !window.get_show_settings());
    click(760., 144.);

    assert_eq!(actions.borrow().last().unwrap(), "restart");
    click(910., 28.);
    click(760., 178.);
    assert_eq!(actions.borrow().last().unwrap(), "open-web");
    println!("Slint interaction smoke passed: disclosure, keyboard activation, import/manual actions, email → Tab → password → Enter, language/Escape, draft preservation and application menu actions");
}
fn exercise_files(window: &MainWindow, redraw: impl Fn()) {
    use slint::platform::{Key, PointerEventButton, WindowEvent};
    let opened = Rc::new(RefCell::new(Vec::<String>::new()));
    let recorded = opened.clone();
    window.on_open_file(move |id| recorded.borrow_mut().push(id.to_string()));
    let click = |x, y, button| {
        let position = slint::LogicalPosition::new(x, y);
        window.window().dispatch_event(WindowEvent::PointerMoved {position});
        window.window().dispatch_event(WindowEvent::PointerPressed {position, button});
        window.window().dispatch_event(WindowEvent::PointerReleased {position, button}); redraw();
    };
    let key = |text: slint::SharedString| {
        window.window().dispatch_event(WindowEvent::KeyPressed {text:text.clone()});
        window.window().dispatch_event(WindowEvent::KeyReleased {text}); redraw();
    };
    let copy = || {
        window.window().dispatch_event(WindowEvent::KeyPressed {text:Key::Control.into()});
        key("c".into());
        window.window().dispatch_event(WindowEvent::KeyReleased {text:Key::Control.into()}); redraw();
    };
    // Locate the first row through the production hit target and stable model ID.
    // Its height depends on text and inline activity; old absolute Y positions
    // can select the next row even when the rendered list is correct.
    let first_key = format!("{}:actual", window.get_files().row_data(0).unwrap().id);
    let mut first_row_hits = Vec::new();
    for y in (300..=460).step_by(2) {
        click(475., y as f32, PointerEventButton::Left);
        if window.get_selected_name_key().as_str() == first_key { first_row_hits.push(y as f32); }
    }
    assert!(opened.borrow().is_empty(), "Blank-cell row lookup must never open a file");
    let first_top = *first_row_hits.first().expect("First actual-name row must be selectable");
    let first_bottom = *first_row_hits.last().unwrap();
    let first_blank_y = first_bottom - 8.;
    let first_text_y = (first_top + first_bottom) / 2.;
    let first_action_y = first_bottom - 16.;
    // Size is an independent, inert column; blank name-cell space selects.
    click(550., 365., PointerEventButton::Left);
    assert!(opened.borrow().is_empty());
    assert!(window.get_selected_name_key().is_empty());
    click(420., first_blank_y, PointerEventButton::Left);
    assert!(opened.borrow().is_empty());
    assert_eq!(window.get_selected_name_key(), "file-1:actual");
    copy();
    TEST_CLIPBOARD.with(|c| assert_eq!(c.borrow().as_str(), "决议草案 - 中文显示测试.pdf"));
    assert_eq!(window.get_copied_notice(), translate("Copied", window.get_language().as_str()));
    click(400., first_text_y, PointerEventButton::Left);
    assert_eq!(&*opened.borrow(), &["file-1"]);
    key(Key::Return.into());
    assert_eq!(&*opened.borrow(), &["file-1", "file-1"]);
    click(400., first_text_y, PointerEventButton::Right);
    key(Key::DownArrow.into()); key(Key::Return.into());
    assert_eq!(opened.borrow().len(), 2, "Context menu copies, never opens");
    TEST_CLIPBOARD.with(|c| assert_eq!(c.borrow().as_str(), "决议草案 - 中文显示测试.pdf"));
    // Outside clicks must clear selection, including inert cells and page whitespace.
    for (x, y) in [(550., 365.), (90., 610.), (90., 250.)] {
        click(420., first_blank_y, PointerEventButton::Left);
        assert_eq!(window.get_selected_name_key(), "file-1:actual");
        click(x, y, PointerEventButton::Left);
        assert!(window.get_selected_name_key().is_empty(), "Outside click at {x},{y} must deselect");
        if y != 250. {
            TEST_CLIPBOARD.with(|c| *c.borrow_mut() = "unchanged after deselection".into());
            copy();
            TEST_CLIPBOARD.with(|c| assert_eq!(c.borrow().as_str(), "unchanged after deselection", "Deselection must also remove copy focus"));
        }
    }
    click(420., first_blank_y, PointerEventButton::Left);
    // Long names are copied in full, and snapshots retain the focused cell.
    use slint::Model;
    let files = window.get_files();
    let long_name = "长文件名-Long filename with spaces and 中文, supplementary materials and revisions-final.docx";
    let mut row = files.row_data(0).unwrap();
    row.actual_name = long_name.into(); row.stem = long_name.trim_end_matches(".docx").into(); row.extension = ".docx".into();
    files.set_row_data(0, row.clone()); redraw();
    copy(); TEST_CLIPBOARD.with(|c| assert_eq!(c.borrow().as_str(), long_name));
    click(400., first_text_y, PointerEventButton::Right); key(Key::Return.into());
    assert_eq!(opened.borrow().len(), 2, "Long-name context menu must copy, not open");
    key(Key::Menu.into()); key(Key::Escape.into()); copy();
    TEST_CLIPBOARD.with(|c| assert_eq!(c.borrow().as_str(), long_name));
    // Dismiss a long-name menu by clicking outside; dash also deselects.
    key(Key::Menu.into()); click(90., 610., PointerEventButton::Left);
    assert!(window.get_selected_name_key().is_empty(), "Outside click dismisses menu selection");
    click(420., first_blank_y, PointerEventButton::Left); key(Key::Escape.into());
    click(90., 430., PointerEventButton::Left);
    assert!(window.get_selected_name_key().is_empty());
    // Logical names copy but do not open.
    click(90., first_text_y, PointerEventButton::Left); copy(); key(Key::Return.into());
    assert_eq!(opened.borrow().len(), 2);
    TEST_CLIPBOARD.with(|c| assert_eq!(c.borrow().as_str(), "决议草案 - 中文显示测试.pdf"));
    window.window().dispatch_event(WindowEvent::PointerMoved {position: slint::LogicalPosition::new(400., first_text_y)});
    redraw(); std::thread::sleep(std::time::Duration::from_millis(550)); redraw(); copy();
    TEST_CLIPBOARD.with(|c| assert_eq!(c.borrow().as_str(), "决议草案 - 中文显示测试.pdf", "Hovering another name must not change the copy target"));
    key(Key::Escape.into());
    click(90., 610., PointerEventButton::Left);
    assert!(window.get_selected_name_key().is_empty(), "Outside a hovered name also clears the prior selection");
    std::thread::sleep(std::time::Duration::from_millis(150)); redraw();
    let actions = Rc::new(RefCell::new(Vec::<String>::new())); let recorded = actions.clone();
    window.on_action(move |action| recorded.borrow_mut().push(action.to_string()));
    row.local_code = "CONFLICT".into(); row.local = translate("CONFLICT", window.get_language().as_str()).into(); row.progressing = false;
    files.set_row_data(0, row.clone()); redraw();
    click(659., first_action_y, PointerEventButton::Left);
    assert_eq!(actions.borrow().last().unwrap(), "open-conflicts");
    row.local_code = "READY_PUBLISHED".into(); row.local = translate("READY_PUBLISHED", window.get_language().as_str()).into();
    files.set_row_data(0, row.clone()); redraw(); copy();
    TEST_CLIPBOARD.with(|c| assert_eq!(c.borrow().as_str(), long_name, "Disappearing action returns focus to actual name"));
    row.local_code = "FAILED".into(); row.cache_code = "REFILL_FAILED".into();
    files.set_row_data(0, row); redraw(); click(653., first_action_y, PointerEventButton::Left);
    assert_eq!(actions.borrow().last().unwrap(), "navigate-logs");
    // Preserve list position when the diagnostics view temporarily replaces it.
    let sample = files.row_data(0).unwrap();
    window.set_files(ModelRc::new(VecModel::from((0..20).map(|i| {let mut r = sample.clone(); r.id = format!("scroll-{i}").into(); r}).collect::<Vec<_>>())));
    redraw(); window.set_file_scroll(-240.); redraw();
    let scroll = window.get_file_scroll(); assert!(scroll < -100.);
    window.set_show_logs(true); redraw(); window.set_show_logs(false); redraw();
    assert_eq!(window.get_file_scroll(), scroll, "Returning from logs preserves list scroll");
    println!("Selection vs open, clipboard, menus, full names, stable updates, inline actions and scroll retention passed");
}
fn exercise_connection(window: &MainWindow, redraw: impl Fn()) {
    use slint::platform::{PointerEventButton, WindowEvent};
    let actions = Rc::new(RefCell::new(Vec::<String>::new()));
    let recorded = actions.clone();
    window.on_action(move |action| recorded.borrow_mut().push(action.to_string()));
    let click = |x, y| {
        let position = slint::LogicalPosition::new(x, y);
        window.window().dispatch_event(WindowEvent::PointerMoved {position});
        window.window().dispatch_event(WindowEvent::PointerPressed {position, button: PointerEventButton::Left});
        window.window().dispatch_event(WindowEvent::PointerReleased {position, button: PointerEventButton::Left});
        redraw();
    };
    assert!(window.get_show_settings() && window.get_loaded() && window.get_running());
    click(200., 301.);
    assert_eq!(actions.borrow().last().unwrap(), "confirm-switch");
    click(740., 303.);
    assert_eq!(actions.borrow().last().unwrap(), "confirm-unpair");
    // The outlined disconnect control must retain keyboard activation and guards.
    for text in [" ", "\n"] {
        let before = actions.borrow().len();
        window.window().dispatch_event(WindowEvent::KeyPressed {text: text.into()});
        window.window().dispatch_event(WindowEvent::KeyReleased {text: text.into()});
        assert_eq!(actions.borrow().len(), before + 1);
        assert_eq!(actions.borrow().last().unwrap(), "confirm-unpair");
    }
    for busy in [false, true] {
        window.set_dirty(!busy);
        window.set_busy(busy);
        redraw();
        let before = actions.borrow().len();
        click(200., 303.);
        click(740., 303.);
        assert_eq!(actions.borrow().len(), before, "Both connection actions must respect busy and unsaved changes");
    }
    window.set_dirty(false);
    window.set_busy(false);
    // Inject the confirmation state; this preview never invokes the Node bridge.
    window.set_previous_committee("欧洲联盟".into());
    window.set_previous_site("https://quorum.example.com".into());
    window.set_switch_committee(true);
    window.set_confirm_unpair(true);
    redraw();
    let before = actions.borrow().len();
    for pressed in [true, false] {
        let text = slint::platform::Key::Return.into();
        window.window().dispatch_event(if pressed {WindowEvent::KeyPressed {text}} else {WindowEvent::KeyReleased {text}});
    }
    redraw();
    assert!(!window.get_confirm_unpair(), "Default keyboard action must cancel, never revoke");
    assert_eq!(actions.borrow().len(), before);
    window.set_confirm_unpair(true); redraw();
    click(675., 503.);
    assert_eq!(actions.borrow().last().unwrap(), "switch-committee", "Final target confirmation must start the staged switch");
    window.set_busy(true);
    window.set_status("STOPPING".into());
    redraw();
    click(240., 503.);
    assert!(window.get_confirm_unpair(), "An active disconnect cannot be cancelled midway");
    window.set_busy(false);
    redraw();
    click(240., 503.);
    assert!(!window.get_confirm_unpair());
    window.set_status("RUNNING".into()); window.set_files_loaded(true); window.set_committee_status("ACTIVE".into());
    window.set_status_delayed(false); window.set_last_connection_age("".into()); window.set_observed_age("".into());
    assert_eq!(window.get_display_status(), "RUNNING");
    window.set_observed_age("2 分钟前".into());
    assert_eq!(window.get_display_status(), "STATUS_DELAYED");
    window.set_observed_age("".into()); window.set_status_delayed(true);
    assert_eq!(window.get_display_status(), "STATUS_DELAYED");
    window.set_status_delayed(false); window.set_committee_status("PAUSED".into());
    assert_eq!(window.get_display_status(), "COMMITTEE_PAUSED_STATUS");
    window.set_status("DISCONNECTED".into());
    assert_eq!(window.get_display_status(), "DISCONNECTED");
    window.set_page("login".into());
    window.set_loaded(false);
    window.set_show_settings(false);
    window.set_feedback("Authorization revoked".into());
    redraw();
    click(678., 198.);
    assert!(window.get_feedback().is_empty(), "Result notices must be dismissible");
    window.set_page("home".into()); window.set_loaded(true); window.set_running(true);
    window.set_status("RUNNING".into()); window.set_committee_status("PAUSED".into());
    println!("Connection actions, safe confirmation, busy guard and status recovery passed");
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
    window.set_account_email("chair@example.com".into());
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
            id: "file-1".into(), actual_name: "决议草案 - 中文显示测试.pdf".into(), stem: "决议草案 - 中文显示测试".into(), extension: ".pdf".into(), can_open: true, local_code: "DOWNLOADING".into(), cache_code: "CACHE_READY".into(),
            name: "决议草案 - 中文显示测试.pdf".into(),
            size: "1024.0 MiB".into(),
            local: translate("DOWNLOADING", language).into(),
            cache: translate("CACHE_READY", language).into(),
            transfer: "512 / 1024 MiB".into(),
            fraction: 0.5,
            progressing: true,
            ..Default::default()
        },
        FileRow {
            id: "file-2".into(), actual_name: "工作文件.docx".into(), stem: "工作文件".into(), extension: ".docx".into(), can_open: true, local_code: "READY_REVIEW".into(), cache_code: "CACHE_READY".into(),
            name: "-".into(),
            size: "1023.9 KiB".into(),
            local: translate("READY_REVIEW", language).into(),
            cache: translate("CACHE_READY", language).into(),
            ..Default::default()
        },
        FileRow {
            stem: "已公开的立场文件".into(), extension: ".pdf".into(), id: "file-3".into(), actual_name: "已公开的立场文件.pdf".into(), can_open: true, local_code: "READY_PUBLISHED".into(), cache_code: "REFILLING".into(),
            name: "已公开的立场文件.pdf".into(),
            size: "24 MiB".into(),
            local: translate("READY_PUBLISHED", language).into(),
            cache: translate("REFILLING", language).into(),
            transfer: "8 / 24 MiB".into(),
            fraction: 0.333,
            progressing: true,
        },
        FileRow {
            id: "file-4".into(), actual_name: "本地笔记.txt".into(), stem: "本地笔记".into(), extension: ".txt".into(), can_open: true, local_code: "READY_UNSUBMITTED".into(), cache_code: "CACHE_MISSING_LOCAL_READY".into(),
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
    if std::env::args().any(|arg| arg == "--password-error") {window.set_error_code("PASSWORD_TOO_SHORT".into()); window.set_password("sample".into());}
    if std::env::args().any(|arg| arg == "--error") {window.set_password("retained-example-password".into());}
    if std::env::args().any(|arg| arg == "--switch-committee") {
        window.set_previous_committee("欧洲联盟".into());
        window.set_switching(true); window.set_setup_mode(true); window.set_account_setup(true); window.set_loaded(false); window.set_running(false);
        window.set_previous_site("https://quorum.example.com".into());
    }

    if std::env::args().any(|arg| arg == "--file-errors") {
        window.set_files(ModelRc::new(VecModel::from(["FAILED", "CONFLICT", "RETRYING"].iter().enumerate().map(|(i, code)| FileRow {id: format!("file-{i}").into(), actual_name: "关于跨境合作与可持续发展的决议草案 - long filename with supplementary materials.pdf".into(), stem: "关于跨境合作与可持续发展的决议草案 - long filename with supplementary materials".into(), extension: ".pdf".into(), can_open: true, name: "委员会工作文件".into(), size: "1 MiB".into(), local_code: (*code).into(), local: translate(code, language).into(), cache_code: "REFILL_FAILED".into(), cache: translate("REFILL_FAILED", language).into(), ..Default::default()}).collect::<Vec<_>>())));
    }
    if std::env::args().any(|arg| arg == "--switch-revoked") {window.set_switch_revoked(true); window.set_error_stage("server-pairing".into()); window.set_error_code("LINK_EXPIRED".into());}
    if std::env::args().any(|arg| arg == "--name-popup" || arg == "--name-menu") {
        let rows = window.get_files(); let mut row = rows.row_data(0).unwrap();
        row.actual_name = "长文件名-Long filename with spaces and 中文, supplementary materials and revisions-final.docx".into();
        row.stem = "长文件名-Long filename with spaces and 中文, supplementary materials and revisions-final".into(); row.extension = ".docx".into();
        rows.set_row_data(0, row);
    }
    if std::env::args().any(|arg| arg == "--short-size") {
        let mut row = window.get_files().row_data(0).unwrap();
        row.name = "工作文件 1.1".into(); row.actual_name = "content".into(); row.stem = "content".into(); row.extension = "".into();
        row.size = "36 B".into(); row.progressing = false; row.local = translate("READY_PUBLISHED", language).into();
        window.set_files(ModelRc::new(VecModel::from(vec![row])));
    }
    let size_width = window.get_files().iter().fold(window.invoke_measure_size(translate("Size", language).into()), |width, row| width.max(window.invoke_measure_size(row.size)));
    window.set_size_column_width(size_width.ceil());
    assert!(size_width > 0. && size_width < 80., "Size column must fit the actual samples without the old reserved width");
    if std::env::args().any(|arg| arg == "--short-size") {assert!(size_width < 40., "36 B must not retain a wide column");}
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
        if std::env::args().any(|arg| arg == "--short-size") {
            let position = slint::LogicalPosition::new(if width == 760 {250.} else {400.}, if width == 760 {360.} else {375.});
            for pressed in [true, false] {
                let button = slint::platform::PointerEventButton::Left;
                window.window().dispatch_event(if pressed {slint::platform::WindowEvent::PointerPressed {position, button}} else {slint::platform::WindowEvent::PointerReleased {position, button}});
            }
            slint::platform::update_timers_and_animations();
            assert_eq!(window.get_selected_name_key(), "file-1:actual");
            window.window().request_redraw();
            adapter.draw_if_needed(|renderer| {renderer.render(pixels.make_mut_slice(), width as usize);});
        }
        if std::env::args().any(|arg| arg == "--name-popup" || arg == "--name-menu") {
            let position = slint::LogicalPosition::new(if width == 760 {250.} else {400.}, if width == 760 {337.} else {350.});
            window.window().dispatch_event(slint::platform::WindowEvent::PointerMoved {position});
            if std::env::args().any(|arg| arg == "--name-menu") {
                let button = slint::platform::PointerEventButton::Right;
                window.window().dispatch_event(slint::platform::WindowEvent::PointerPressed {position,button});
                window.window().dispatch_event(slint::platform::WindowEvent::PointerReleased {position,button});
            } else {std::thread::sleep(std::time::Duration::from_millis(550));}
            for _ in 0..3 {
                slint::platform::update_timers_and_animations(); window.window().request_redraw();
                adapter.draw_if_needed(|renderer| {renderer.render(pixels.make_mut_slice(), width as usize);});
            }
            if std::env::args().any(|arg| arg == "--hover-popup") {
                window.window().dispatch_event(slint::platform::WindowEvent::PointerMoved {position: slint::LogicalPosition::new(350., 380.)});
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            if std::env::args().any(|arg| arg == "--escape-popup") {
                let text = slint::platform::Key::Escape.into();
                window.window().dispatch_event(slint::platform::WindowEvent::KeyPressed {text});
            }
            slint::platform::update_timers_and_animations(); window.window().request_redraw();
            adapter.draw_if_needed(|renderer| {renderer.render(pixels.make_mut_slice(), width as usize);});
        }
        if std::env::args().any(|arg| matches!(arg.as_str(), "--exercise-login" | "--exercise-connection" | "--exercise-files" | "--exercise-overwrite")) {
            let exercise = if std::env::args().any(|arg| arg == "--exercise-overwrite") {exercise_overwrite} else if std::env::args().any(|arg| arg == "--exercise-files") {exercise_files} else if std::env::args().any(|arg| arg == "--exercise-connection") {exercise_connection} else {exercise_login};
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
        if std::env::args().any(|arg| arg == "--menu") {
            for pressed in [true, false] {
                let position = slint::LogicalPosition::new(width as f32 - 50., 28.);
                let button = slint::platform::PointerEventButton::Left;
                window.window().dispatch_event(if pressed {slint::platform::WindowEvent::PointerPressed {position, button}} else {slint::platform::WindowEvent::PointerReleased {position, button}});
            }
            slint::platform::update_timers_and_animations();
            adapter.draw_if_needed(|renderer| {renderer.render(pixels.make_mut_slice(), width as usize);});
            if std::env::args().any(|arg| arg == "--exercise-menu") {
                let action = Rc::new(RefCell::new(String::new())); let observed = action.clone();
                window.on_action(move |name| *observed.borrow_mut() = name.to_string());
                for pressed in [true, false] {
                    let position = slint::LogicalPosition::new(width as f32 - 180., 144.);
                    let button = slint::platform::PointerEventButton::Left;
                    window.window().dispatch_event(if pressed {slint::platform::WindowEvent::PointerPressed {position, button}} else {slint::platform::WindowEvent::PointerReleased {position, button}});
                }
                assert_eq!(action.borrow().as_str(), "restart");
                println!("Sync menu restart callback passed");
            }
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
