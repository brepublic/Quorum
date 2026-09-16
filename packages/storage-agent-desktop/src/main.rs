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
fn error_message(code: &str) -> String {
    match code {
        "ENOENT" => "文件或目录不存在。",
        "EACCES" => "没有访问文件或目录的权限。",
        "ECONNREFUSED" => "服务器拒绝连接，请检查地址和服务是否启动。",
        "ENOTFOUND" => "无法解析服务器地址。",
        "ETIMEDOUT" | "TLS_TIMEOUT" | "UND_ERR_CONNECT_TIMEOUT" => "服务器连接超时。",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
        | "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
        | "UNABLE_TO_GET_ISSUER_CERT"
        | "DEPTH_ZERO_SELF_SIGNED_CERT"
        | "SELF_SIGNED_CERT_IN_CHAIN" => "服务器证书不受信任，请选择对应 CA 证书。",
        "LINK_EXPIRED" => "配对码无效或已过期，请在委员会网页重新生成。",
        "RESOURCE_CONFLICT" => "服务器上的设备状态已变化，请刷新委员会网页并重新生成配对码。",
        "VALIDATION_FAILED" => "服务器拒绝配对信息，请检查设备名称和配对码。",
        "PAIRING_CODE_REQUIRED" => "请输入一次性配对码。",
        "DEVICE_LABEL_REQUIRED" => "请输入设备名称。",
        "ROOT_REQUIRED" => "请选择存储目录。",
        "CONFIG_INVALID" => "配置不是有效的 Agent 配置文件，请检查文件格式。",
        "CONFIG_PRIVATE_REQUIRED" | "INVALID_STORAGE_ROOT" => {
            "配置必须为普通私有文件，仅允许当前用户读写，不能使用链接。"
        }
        "EISDIR" => "所选路径是目录，请选择文件。",
        "ENOTDIR" => "路径中有一项不是目录。",
        "ENOSPC" => "磁盘空间不足。",
        "EROFS" => "目标位于只读文件系统。",
        "EPERM" => "系统拒绝访问，请检查文件权限。",
        "ECONNRESET" => "服务器中断连接，请重试。",
        "EHOSTUNREACH" | "ENETUNREACH" | "EAI_AGAIN" => {
            "网络或域名解析暂不可用，请检查连接后重试。"
        }
        "FORBIDDEN" | "AUTHENTICATION_REQUIRED" | "STALE_STORAGE_LEASE" => {
            "设备授权不可用，请在委员会网页核对配对状态。"
        }
        "NOT_FOUND" | "HTTP_ERROR" => "服务器未提供预期接口，请检查服务地址及服务器版本。",
        "SERVICE_NOT_READY" => "服务器尚未就绪，请稍后重试。",
        "RATE_LIMITED" => "请求过于频繁，请稍后重试。",
        "CERT_NOT_YET_VALID" => "服务器证书尚未生效，请核对电脑时间。",
        "UNSAVED_CHANGES" => "设置已修改，请先保存再启动。",
        "CERT_HAS_EXPIRED" => "服务器证书已过期。",
        "ERR_TLS_CERT_ALTNAME_INVALID" => "服务器地址与证书名称不匹配。",
        "STOP_FIRST" => "请先停止 Agent。",
        "INVALID_DRAFT" => "未配对配置格式无效。",
        "CONFIG_EXISTS" => "配置文件已存在，请导入，或指定新的配置文件路径。",
        "ROOT_ALREADY_PAIRED" => "存储目录已有配对记录，请导入对应配置，或选择新的存储目录。",
        "CONFIG_PATH_REQUIRED" => "请填写配置文件路径，或选择已有配置。",
        "REVOKE_FAILED" => "撤销授权失败。请检查原服务器连接，并确认服务器已更新。",
        "CONFIG_PATH_CHANGED" => "保存设置只能写回原配置；保存新文件请使用另存为。",
        "EEXIST" => "目标文件已存在，请选择新的文件名。",
        "CONFIG_REQUIRED" => "请先导入配置或配对。",
        "MOVE_COMPLETE_DIRECTORY" => "目录不完整或文件内容已变化，请完整搬迁原目录后再选择。",
        "AGENT_ALREADY_RUNNING" => "此目录已有 Agent 运行，请先停止原进程。",
        "ROOT_IDENTITY_MISMATCH" => "目录不属于当前设备，请选择完整搬迁的原目录。",
        "SERVER_CERTIFICATE_CHANGED" => {
            "新地址证书与原服务不一致，未发送设备凭据。请使用原地址或重新配对。"
        }
        "HTTPS_REQUIRED" => "请输入不含路径、查询或凭据的 HTTPS 服务器地址。",
        "INVALID_SCAN_INTERVAL" => "扫描间隔须为 1–3600 秒的整数。",
        "INVALID_CERTIFICATE" => "证书文件无效。",
        "CONFIG_OUTSIDE_ROOT" => "私有配置和证书必须位于存储目录之外。",
        "AGENT_EXITED" => "Agent 异常退出，请查看日志。",
        "PAIRING_FAILED" => "配对失败，请检查配对码、目录和服务器连接。",
        "BRIDGE_EXITED" => "Agent 控制进程已退出，请重新打开窗口。",
        _ => "未能完成此步骤，请查看日志中的操作及错误代码。",
    }
    .to_string()
}
fn form_state(ui: &MainWindow) -> Value {
    json!([
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
fn stage_label(stage: &str) -> &str {
    match stage {
        "server-address" => "服务器地址",
        "scan-interval" => "扫描间隔",
        "storage-directory" => "存储目录",
        "ca-certificate" => "CA 证书",
        "tls" => "验证服务器证书",
        "config-read" => "读取配置",
        "config-write" => "写入配置",
        "pairing-input" => "配对信息",
        "server-pairing" => "服务器配对",
        "local-state" => "写入本地配对记录",
        "revoke" => "撤销授权",
        _ => "处理设置",
    }
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
                local: text(v, "local").into(),
                cache: text(v, "cache").into(),
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
    let ui = MainWindow::new()?;
    ui.set_show_settings(true);
    let saved_form = Rc::new(RefCell::new(form_state(&ui)));
    let exe = std::env::current_exe()?;
    let node = std::env::var_os("QUORUM_AGENT_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| exe.parent().unwrap().join("runtime/node"));
    let bridge = std::env::var_os("QUORUM_AGENT_BRIDGE")
        .map(PathBuf::from)
        .unwrap_or_else(|| exe.parent().unwrap().join("app/desktop-bridge.js"));
    let mut process = Command::new(node)
        .arg(bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let input = Arc::new(Mutex::new(process.stdin.take()));
    let output = process.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel::<Value>();
    let tx2 = tx.clone();
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
        let dirty = form_state(&ui) != *saved_action.borrow();
        if action == "load" && (dirty || !ui.get_pairing_code().is_empty()) {
            ui.set_confirm_discard("load".into()); return;
        }
        if action == "discard-close" {
            ui.set_confirm_discard("".into()); ui.set_closing(true); ui.set_status("停止中".into());
            input_action.lock().unwrap().take(); return;
        }
        let action = if action == "discard-load" {ui.set_confirm_discard("".into()); "load"} else {action};
        if matches!(action,"start"|"restart"|"unpair") && (dirty || ui.get_config_path() != ui.get_saved_config_path()) {
            ui.set_error_text("设置已修改，请先保存；恢复原配置请重新导入。".into()); return;
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
                        if success {ui.set_feedback("日志已导出".into());}
                        else {ui.set_error_text("导出日志：无法写入目标文件，请检查目录权限和磁盘空间。".into());}
                    });
                }
            }); return;
        }
        let mut value = json!({"command":action,"configPath":ui.get_config_path().as_str(),"serverUrl":ui.get_server_url().as_str(),
            "rootPath":ui.get_root_path().as_str(),"caCertificatePath":ui.get_certificate().as_str(),"scanSeconds":ui.get_scan_seconds().as_str(),
            "pairingCode":ui.get_pairing_code().as_str(),"deviceLabel":ui.get_device_label().as_str()});
        ui.set_error_text("".into()); ui.set_feedback("".into()); ui.set_busy(true);
        if action == "save-as" || (action == "save" && ui.get_config_path().trim().is_empty()) {
            value["command"] = json!("save-as");
            let input = input_action.clone();
            let weak = ui.as_weak();
            thread::spawn(move || {
                let path = rfd::FileDialog::new().set_file_name("agent-config.json").save_file();
                if let Some(path) = path {
                    value["savePath"] = json!(path.to_string_lossy());
                    let sent = input.lock().unwrap().as_mut()
                        .is_some_and(|stdin| writeln!(stdin, "{value}").is_ok());
                    if !sent {let _ = weak.upgrade_in_event_loop(|ui| {
                        ui.set_busy(false); ui.set_error_text(error_message("BRIDGE_EXITED").into());
                    });}
                } else {let _ = weak.upgrade_in_event_loop(|ui| ui.set_busy(false));}
            });
            return;
        }
        if let Some(stdin) = input_action.lock().unwrap().as_mut() {if writeln!(stdin,"{value}").is_err() {ui.set_busy(false); ui.set_error_text(error_message("BRIDGE_EXITED").into());}}
    });
    let weak = ui.as_weak();
    ui.on_choose(move |kind| {
        let weak = weak.clone();
        let kind = kind.to_string();
        thread::spawn(move || {
            let path = if kind == "root" {
                rfd::FileDialog::new().pick_folder()
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
            if form_state(&ui) != *saved_close.borrow() || !ui.get_pairing_code().is_empty() {
                ui.set_confirm_discard("close".into());
                return slint::CloseRequestResponse::KeepWindowShown;
            }
            ui.set_closing(true);
            ui.set_status("停止中".into());
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
            for value in rx.try_iter() {
                match text(&value, "event") {
                    "unpaired" => {
                        ui.set_loaded(false);
                        ui.set_confirm_unpair(false);
                        ui.set_config_path("".into());
                        ui.set_root_path("".into());
                        ui.set_server_url("https://localhost".into());
                        ui.set_certificate("".into());
                        ui.set_committee_url("".into());
                        ui.set_pairing_code("".into());
                        ui.set_last_connection("".into());
                        ui.set_observed("".into());
                        ui.set_status("已解除配对".into());
                        ui.set_saved_config_path("".into());
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
                        ui.set_loaded(paired);
                        ui.set_status(if paired { "未启动" } else { "未配对" }.into());
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
                        ui.set_running(matches!(state, "启动中" | "运行中" | "停止中"));
                        if state == "已退出" {
                            for row in rows.borrow_mut().iter_mut() {
                                row["cache"] = json!("状态未知");
                                row["progress"] = json!(false);
                                if text(row, "local") == "上传中" {
                                    row["local"] = json!("待上传");
                                }
                                if text(row, "local") == "下载中" {
                                    row["local"] = json!("待下载");
                                }
                            }
                            redraw = true;
                        }
                    }
                    "busy" => ui.set_busy(value["value"] == true),
                    "snapshot" => {
                        if !ui.get_closing() && ui.get_status() != "停止中" {
                            ui.set_status(
                                if value["connected"] == true {
                                    "运行中"
                                } else {
                                    "连接异常"
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
                                "save" | "save-as" => "配置已保存",
                                "load" => "配置已导入",
                                "pair" => "配对成功",
                                "unpair" => "授权已撤销",
                                _ => "",
                            }
                            .into(),
                        );
                        if matches!(operation, "pair" | "load") {
                            ui.set_pairing_code("".into());
                        }
                    }
                    "error" => {
                        let code = text(&value, "code");
                        let stage = text(&value, "stage");
                        ui.set_error_text(
                            format!("{}：{}", stage_label(stage), error_message(code)).into(),
                        );
                        logs.borrow_mut().push(format!(
                            "操作={} 步骤={} 错误={}",
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
                            ui.set_status("已退出".into());
                            ui.set_error_text(error_message("BRIDGE_EXITED").into());
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
