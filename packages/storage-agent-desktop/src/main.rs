mod localization;
mod desktop;
use slint::winit_030::WinitWindowAccessor;
use localization::{translate, load_language, save_language};
use serde_json::{json, Value};
use slint::{ComponentHandle, ModelRc, SharedString, VecModel};
use std::{
    cell::{Cell, RefCell},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    rc::Rc,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};
slint::include_modules!();

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn bytes(n: f64) -> String {
    if n >= 1048576.0 {
        format!("{:.1} MiB", n / 1048576.0)
    } else if n >= 1024.0 {
        format!("{:.1} KiB", n / 1024.0)
    } else {
        format!("{} B", n as u64)
    }
}
fn form_state(ui: &MainWindow) -> Value {
    json!([
        ui.get_config_path().as_str(),
        ui.get_server_url().as_str(),
        ui.get_root_path().as_str(),
        ui.get_certificate().as_str(),
        ui.get_scan_seconds().as_str(),
        if ui.get_loaded() {
            String::new()
        } else {
            ui.get_device_label().to_string()
        }
    ])
}
fn render(ui: &MainWindow, rows: &[Value], logs: &[String]) {
    let search = ui.get_search().to_lowercase();
    let show_deleted = ui.get_show_deleted();
    let model: Vec<FileRow> = rows
        .iter()
        .filter(|v| {
            (show_deleted || v["deleted"] != true)
                && text(v, "name").to_lowercase().contains(&search)
        })
        .map(|v| {
            let sent = v["bytes"].as_f64().unwrap_or(0.0);
            let total = v["total"].as_f64().unwrap_or(0.0);
            let progressing = v["progress"].as_bool().unwrap_or(false);
            FileRow {
                name: text(v, "name").into(),
                size: bytes(v["size"].as_f64().unwrap_or(0.0)).into(),
                local: translate(text(v, "local"), ui.get_language().as_str()).into(),
                cache: translate(text(v, "cache"), ui.get_language().as_str()).into(),
                transfer: if progressing {
                    format!("{} / {}", bytes(sent), bytes(total)).into()
                } else {
                    SharedString::default()
                },
                fraction: if total > 0.0 {
                    (sent / total).clamp(0.0, 1.0) as f32
                } else {
                    0.0
                },
                progressing,
            }
        })
        .collect();
    ui.set_files(ModelRc::new(VecModel::from(model)));
    let filter = ui.get_log_filter().to_lowercase();
    ui.set_log_text(
        logs.iter()
            .filter(|l| l.to_lowercase().contains(&filter))
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
            .into(),
    );
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let target = match arguments.as_slice() {
        [] => String::new(),
        [flag] if flag == "--open" => String::new(),
        [flag, target] if flag == "--open" => target.clone(),
        [target] if target != "--register" => target.clone(),
        [flag] if flag == "--register" => String::new(),
        _ => return Err("Use --open <configuration or pairing URL>".into()),
    };
    let exe = std::env::current_exe()?;
    let node = std::env::var_os("QUORUM_AGENT_NODE").map(PathBuf::from)
        .unwrap_or_else(|| exe.parent().unwrap().join("runtime/node"));
    let bridge = std::env::var_os("QUORUM_AGENT_BRIDGE").map(PathBuf::from)
        .unwrap_or_else(|| exe.parent().unwrap().join("app/desktop-bridge.js"));
    if arguments.first().is_some_and(|arg| arg == "--register") {
        desktop::register(&exe, &node, &bridge)?; return Ok(());
    }
    let Some(instance) = desktop::Instance::open(&target)? else {return Ok(());};
    slint::BackendSelector::new().backend_name("winit".into())
        .with_winit_window_attributes_hook(|attributes| {
            let attributes = slint::winit_030::winit::platform::wayland::WindowAttributesExtWayland::with_name(
                attributes, desktop::APP_ID, desktop::APP_ID);
            slint::winit_030::winit::platform::x11::WindowAttributesExtX11::with_name(
                attributes, desktop::APP_ID, desktop::APP_ID)
        }).select()?;
    let ui = MainWindow::new()?;
    ui.set_show_settings(true);
    ui.on_translate(|key, language| translate(key.as_str(), language.as_str()).into());
    ui.set_language(load_language().into());
    let saved_form = Rc::new(RefCell::new(form_state(&ui)));
    let mut process = Command::new(&node)
        .arg(&bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let input = Arc::new(Mutex::new(process.stdin.take()));
    let output = process.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel::<Value>();
    let tx2 = tx.clone();
    if target.is_empty() {
        if let Some(stdin) = input.lock().unwrap().as_mut() {writeln!(stdin, "{}", json!({"command":"restore"}))?;}
    } else {tx.send(json!({"event":"open-request", "target":target}))?;}
    if desktop::register(&exe, &node, &bridge).is_err() {ui.set_error_code("DESKTOP_REGISTRATION_FAILED".into());}
    thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = tx2.send(v);
            }
        }
    });
    thread::spawn(move || {
        let _ = process.wait();
        let _ = tx.send(json!({"event":"bridge-exit"}));
    });
    let rows = Rc::new(RefCell::new(Vec::<Value>::new()));
    let logs = Rc::new(RefCell::new(Vec::<String>::new()));
    let weak = ui.as_weak();
    let input_action = input.clone();
    let logs_action = logs.clone();
    let saved_action = saved_form.clone();
    ui.on_action(move |action| {
        let Some(ui) = weak.upgrade() else {return};
        if ui.get_busy() || ui.get_closing() {return;}
        let action = action.as_str();
        if !ui.get_confirm_discard().is_empty() && !action.starts_with("discard-") {return;}
        let dirty = form_state(&ui) != *saved_action.borrow();
        if action == "import" {
            let weak = ui.as_weak();
            thread::spawn(move || {
                if let Some(path) = rfd::FileDialog::new().add_filter("Quorum configuration", &["quorum-agent", "json"]).pick_file() {
                    let _ = weak.upgrade_in_event_loop(move |ui| {
                        ui.set_pending_target(path.to_string_lossy().into_owned().into()); ui.invoke_action("open".into());
                    });
                }
            }); return;
        }
        if action == "open" && (dirty || !ui.get_pairing_code().is_empty() || ui.get_setup_mode()) {
            ui.set_confirm_discard("open".into()); return;
        }
        if action == "load" && (dirty || !ui.get_pairing_code().is_empty()) {
            ui.set_confirm_discard("load".into()); return;
        }
        if action == "discard-close" {
            ui.set_confirm_discard("".into()); ui.set_closing(true); ui.set_status("STOPPING".into());
            input_action.lock().unwrap().take(); return;
        }
        let action = if action == "discard-load" {ui.set_confirm_discard("".into()); "load"}
            else if action == "discard-open" {ui.set_confirm_discard("".into()); "open"} else {action};
        if action == "discard-settings" {
            ui.set_confirm_discard("".into());
            let old = saved_action.borrow();
            ui.set_config_path(old[0].as_str().unwrap_or("").into());
            ui.set_server_url(old[1].as_str().unwrap_or("").into());
            ui.set_root_path(old[2].as_str().unwrap_or("").into());
            ui.set_certificate(old[3].as_str().unwrap_or("").into());
            ui.set_scan_seconds(old[4].as_str().unwrap_or("30").into());
            if !ui.get_loaded() {ui.set_device_label(old[5].as_str().unwrap_or("").into());}
            ui.set_pairing_code("".into()); return;
        }
        if action == "discard" {ui.set_confirm_discard("settings".into()); return;}
        if matches!(action,"start"|"restart"|"unpair"|"unpair-local"|"confirm-unpair") && (dirty || ui.get_config_path() != ui.get_saved_config_path()) {
            ui.set_error_code("Settings changed. Save them first, or import the original configuration again.".into()); return;
        }
        if action == "confirm-unpair" {
            ui.set_unpair_failed(false); ui.set_confirm_unpair(true); return;
        }
        if action == "open-root" || action == "open-web" {
            let target = if action == "open-root" {ui.get_root_path()} else {ui.get_committee_url()};
            if !target.is_empty() {let _ = Command::new("xdg-open").arg(target.as_str()).spawn();} return;
        }
        if action == "export-logs" {
            let content = logs_action.borrow().join("\n");
            let weak = ui.as_weak();
            thread::spawn(move || {
                if let Some(path) = rfd::FileDialog::new().set_file_name("quorum-agent.log").save_file() {
                    let success = std::fs::write(path, content).is_ok();
                    let _ = weak.upgrade_in_event_loop(move |ui| {
                        if success {ui.set_feedback("Logs exported".into());}
                        else {ui.set_error_code("Cannot export logs. Check directory permissions and free space.".into());}
                    });
                }
            }); return;
        }
        let mut value = json!({"command":action,"target":ui.get_pending_target().as_str(),"configPath":ui.get_config_path().as_str(),"serverUrl":ui.get_server_url().as_str(),
            "rootPath":ui.get_root_path().as_str(),"caCertificatePath":ui.get_certificate().as_str(),"scanSeconds":ui.get_scan_seconds().as_str(),
            "pairingCode":ui.get_pairing_code().as_str(),"deviceLabel":ui.get_device_label().as_str()});
        ui.set_error_code("".into()); ui.set_error_stage("".into()); ui.set_feedback("".into()); ui.set_busy(true);
        if matches!(action, "save" | "save-as" | "pair") {
            let choose_path = action == "save-as" || (action == "save" && ui.get_config_path().trim().is_empty());
            if choose_path { value["command"] = json!("save-as"); }
            let language = ui.get_language().to_string();
            let input = input_action.clone();
            let weak = ui.as_weak();
            thread::spawn(move || {
                let path = if choose_path {
                    rfd::FileDialog::new().set_file_name("agent-config.json").save_file()
                } else { Some(PathBuf::from(text(&value, "configPath"))) };
                if let Some(path) = path {
                    if choose_path { value["savePath"] = json!(path.to_string_lossy()); }
                    if path.symlink_metadata().is_ok() {
                        let replace = translate("Overwrite", &language);
                        let result = rfd::MessageDialog::new()
                            .set_title(translate("Overwrite configuration?", &language))
                            .set_description(format!("{}\n\n{}", translate("This file already exists. Replace its contents?", &language), path.display()))
                            .set_level(rfd::MessageLevel::Warning)
                            .set_buttons(rfd::MessageButtons::OkCancelCustom(replace.into(), translate("Cancel", &language).into()))
                            .show();
                        if result != rfd::MessageDialogResult::Custom(replace.into()) && result != rfd::MessageDialogResult::Ok {
                            let _ = weak.upgrade_in_event_loop(|ui| ui.set_busy(false));
                            return;
                        }
                        value["overwrite"] = json!(true);
                    }
                    let sent = input.lock().unwrap().as_mut()
                        .is_some_and(|stdin| writeln!(stdin, "{value}").is_ok());
                    if !sent {let _ = weak.upgrade_in_event_loop(|ui| {
                        ui.set_busy(false); ui.set_error_code("BRIDGE_EXITED".into());
                    });}
                } else {let _ = weak.upgrade_in_event_loop(|ui| ui.set_busy(false));}
            });
            return;
        }
        if let Some(stdin) = input_action.lock().unwrap().as_mut() {if writeln!(stdin,"{value}").is_err() {ui.set_busy(false); ui.set_error_code("BRIDGE_EXITED".into());}}
    });
    let weak = ui.as_weak();
    ui.on_choose(move |kind| {
        let weak = weak.clone();
        let kind = kind.to_string();
        let initial = weak.upgrade().map(|ui| ui.get_root_path().to_string()).unwrap_or_default();
        thread::spawn(move || {
            let path = if kind == "root" {
                rfd::FileDialog::new().set_directory(&initial).pick_folder()
            } else {
                rfd::FileDialog::new().pick_file()
            };
            if let Some(path) = path {
                let value = path.to_string_lossy().into_owned();
                let _ = weak.upgrade_in_event_loop(move |ui| match kind.as_str() {
                    "root" => ui.set_root_path(value.into()),
                    "certificate" => ui.set_certificate(value.into()),
                    _ => ui.set_config_path(value.into()),
                });
            }
        });
    });
    let weak = ui.as_weak();
    let r = rows.clone();
    let l = logs.clone();
    ui.on_filter_changed(move || {
        if let Some(ui) = weak.upgrade() {
            render(&ui, &r.borrow(), &l.borrow());
        }
    });
    let weak = ui.as_weak();
    let language_rows = rows.clone();
    let language_logs = logs.clone();
    ui.on_language_changed(move || {
        if let Some(ui) = weak.upgrade() {
            if save_language(ui.get_language().as_str()).is_err() {
                ui.set_error_code("LANGUAGE_SAVE_FAILED".into());
            }
            render(&ui, &language_rows.borrow(), &language_logs.borrow());
        }
    });
    let bridge_alive = Rc::new(Cell::new(true));
    let close_alive = bridge_alive.clone();
    let weak = ui.as_weak();
    let close_input = input.clone();
    let saved_close = saved_form.clone();
    ui.window().on_close_requested(move || {
        if !close_alive.get() {
            return slint::CloseRequestResponse::HideWindow;
        }
        if let Some(ui) = weak.upgrade() {
            if ui.get_busy() {
                return slint::CloseRequestResponse::KeepWindowShown;
            }
            if form_state(&ui) != *saved_close.borrow() || !ui.get_pairing_code().is_empty() || ui.get_setup_mode() {
                ui.set_confirm_discard("close".into());
                return slint::CloseRequestResponse::KeepWindowShown;
            }
            ui.set_closing(true);
            ui.set_status("STOPPING".into());
        }
        close_input.lock().unwrap().take();
        slint::CloseRequestResponse::KeepWindowShown
    });
    let weak = ui.as_weak();
    let timer = slint::Timer::default();
    timer.start(
        slint::TimerMode::Repeated,
        Duration::from_millis(100),
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let mut redraw = false;
            for target in instance.requests.try_iter() {ui.set_pending_target(target.into()); ui.set_open_pending(true);}
            if ui.get_open_pending() && !ui.get_busy() && !ui.get_closing() {
                ui.set_open_pending(false);
                let _ = ui.show();
                ui.window().with_winit_window(|window| {window.set_minimized(false); window.focus_window();});
                if !ui.get_pending_target().is_empty() {ui.invoke_action("open".into());}
            }
            for value in rx.try_iter() {
                match text(&value, "event") {
                    "defaults" => {
                        ui.set_config_path(text(&value, "configPath").into()); ui.set_saved_config_path(ui.get_config_path());
                        *saved_form.borrow_mut() = form_state(&ui);
                    }
                    "open-request" => {ui.set_pending_target(text(&value, "target").into()); ui.set_open_pending(true);}
                    "setup" => {
                        ui.set_setup_mode(true); ui.set_loaded(false); ui.set_show_settings(true);
                        ui.set_committee_name(text(&value, "committeeName").into());
                        ui.set_config_path(text(&value, "configPath").into());
                        ui.set_server_url(text(&value, "serverUrl").into());
                        ui.set_root_path(text(&value, "rootPath").into());
                        ui.set_certificate("".into()); ui.set_scan_seconds("30".into());
                        ui.set_pairing_code("".into()); ui.set_status("UNPAIRED".into());
                        ui.set_saved_config_path(ui.get_config_path());
                        *saved_form.borrow_mut() = form_state(&ui);
                        rows.borrow_mut().clear(); redraw = true;
                    }
                    "unpaired" => {
                        ui.set_loaded(false); ui.set_setup_mode(false); ui.set_show_settings(true);
                        ui.set_committee_name("".into());
                        ui.set_confirm_unpair(false);
                        ui.set_committee_url("".into());
                        ui.set_pairing_code("".into());
                        ui.set_last_connection("".into());
                        ui.set_observed("".into());
                        ui.set_status("UNPAIRED".into());
                        ui.set_saved_config_path(ui.get_config_path());
                        *saved_form.borrow_mut() = form_state(&ui);
                        rows.borrow_mut().clear();
                        redraw = true;
                    }
                    "config" => {
                        ui.set_confirm_unpair(false);
                        rows.borrow_mut().clear();
                        redraw = true;
                        ui.set_last_connection("".into());
                        ui.set_observed("".into());
                        let paired = value["paired"] == true;
                        ui.set_setup_mode(false); ui.set_committee_name(text(&value, "committeeName").into());
                        ui.set_loaded(paired);
                        ui.set_status(if paired { "STOPPED" } else { "UNPAIRED" }.into());
                        if !paired {
                            ui.set_device_label(text(&value, "deviceLabel").into());
                        }
                        ui.set_config_path(text(&value, "configPath").into());
                        ui.set_server_url(text(&value, "serverUrl").into());
                        ui.set_root_path(text(&value, "rootPath").into());
                        ui.set_certificate(text(&value, "caCertificatePath").into());
                        ui.set_scan_seconds(value["scanSeconds"].to_string().into());
                        ui.set_committee_url(text(&value, "committeeUrl").into());
                        ui.set_saved_config_path(ui.get_config_path());
                        *saved_form.borrow_mut() = form_state(&ui);
                    }
                    "state" => {
                        let state = text(&value, "state");
                        ui.set_status(state.into());
                        if state == "STARTING" {ui.set_show_settings(false);}
                        ui.set_running(matches!(state, "STARTING" | "RUNNING" | "STOPPING"));
                        if state == "EXITED" {
                            for row in rows.borrow_mut().iter_mut() {
                                row["cache"] = json!("UNKNOWN");
                                row["progress"] = json!(false);
                                if text(row, "local") == "UPLOADING" {
                                    row["local"] = json!("PENDING_UPLOAD");
                                }
                                if text(row, "local") == "DOWNLOADING" {
                                    row["local"] = json!("PENDING_DOWNLOAD");
                                }
                            }
                            redraw = true;
                        }
                    }
                    "busy" => ui.set_busy(value["value"] == true),
                    "snapshot" => {
                        if !ui.get_closing() && ui.get_status() != "STOPPING" {
                            ui.set_status(
                                if value["connected"] == true {
                                    "RUNNING"
                                } else {
                                    "DISCONNECTED"
                                }
                                .into(),
                            );
                        }
                        ui.set_running(true);
                        ui.set_last_connection(text(&value, "lastConnected").into());
                        ui.set_observed(text(&value, "updatedAt").into());
                        *rows.borrow_mut() = value["files"].as_array().cloned().unwrap_or_default();
                        redraw = true;
                    }
                    "completed" => {
                        let operation = text(&value, "operation");
                        ui.set_feedback(
                            match operation {
                                "save" | "save-as" => "Configuration saved",
                                "load" => "Configuration imported",
                                "pair" | "setup-pair" => "Pairing completed",
                                "unpair" => "Authorization revoked",
                                "unpair-local" => "Unpaired locally; server authorization has not been confirmed revoked",
                                _ => "",
                            }
                            .into(),
                        );
                        if matches!(operation, "pair" | "load" | "setup-pair") {
                            ui.set_pairing_code("".into());
                            ui.set_pending_target("".into());
                        }
                    }
                    "error" => {
                        if text(&value, "operation") == "unpair" { ui.set_unpair_failed(true); }
                        let code = text(&value, "code");
                        let stage = text(&value, "stage");
                        ui.set_error_stage(stage.into());
                        ui.set_error_code(code.into());
                        logs.borrow_mut().push(format!(
                            "operation={} stage={} error={}",
                            text(&value, "operation"),
                            stage,
                            code
                        ));
                        redraw = true;
                    }
                    "log" => {
                        let mut l = logs.borrow_mut();
                        l.push(text(&value, "text").to_string());
                        if l.len() > 1000 {
                            l.remove(0);
                        }
                        redraw = true;
                    }
                    "bridge-exit" => {
                        bridge_alive.set(false);
                        if ui.get_closing() {
                            let _ = slint::quit_event_loop();
                        } else {
                            ui.set_running(false);
                            ui.set_busy(true);
                            ui.set_status("EXITED".into());
                            ui.set_error_code("BRIDGE_EXITED".into());
                        }
                    }
                    _ => {}
                }
            }
            ui.set_dirty(form_state(&ui) != *saved_form.borrow());
            if ui.get_dirty() {
                ui.set_feedback("".into());
            }
            if redraw {
                render(&ui, &rows.borrow(), &logs.borrow());
            }
        },
    );
    ui.run()?;
    input.lock().unwrap().take();
    Ok(())
}
