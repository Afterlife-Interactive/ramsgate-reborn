mod auth;
mod commands;
mod install;
mod launch;
mod offline;

use tauri::Manager;
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }

            // Windows/Linux: a second protocol invocation while we're already
            // running spawns a new process whose argv carries the URL instead
            // of firing `on_open_url` again — forward it through by hand.
            for arg in argv.iter().skip(1) {
                if let Ok(url) = url::Url::parse(arg) {
                    auth::deep_link::handle_url(app, &url);
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        // Remember size and position, but not whether the title bar was shown: the window is frameless (see
        // WindowFrame.tsx), and a restored "decorations" flag from an older version would bring the native bar back.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(commands::launcher_update::PendingLauncherUpdate::default())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                app.deep_link().register_all()?;
            }

            // Release build: no browser shortcut keys (F5, Ctrl+R/P/S/U, devtools) in the webview. Editing shortcuts
            // (Ctrl+C/V/X/A/Z) are not browser accelerators and keep working; the right-click menu is handled in the
            // front end so text fields keep their own menu.
            #[cfg(all(windows, not(debug_assertions)))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|wv| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                    use windows::core::Interface;
                    if let Ok(core) = wv.controller().CoreWebView2() {
                        if let Ok(settings) = core.Settings() {
                            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                            }
                        }
                    }
                });
            }

            offline::commands::start_lifetime_guard(app.handle());
            commands::retry::set_app_handle(app.handle().clone());
            auth::deep_link::listen(app.handle().clone());
            auth::deep_link::check_startup_url(app.handle());

            Ok(())
        });

    #[cfg(feature = "admin")]
    let builder = builder.invoke_handler(tauri::generate_handler![
            commands::auth::native_restore_session,
            commands::auth::native_login,
            commands::auth::native_register,
            commands::auth::native_discord_complete,
            commands::auth::native_start_discord_login,
            commands::auth::native_set_username,
            commands::auth::native_logout,
            commands::auth::native_forget_session,
            commands::auth::native_get_policy,
            commands::dr_claim::native_dr_claim,
            commands::dr_claim::native_dr_choice_status,
            commands::dr_claim::native_dr_choice_decide,
            commands::dr_claim::native_dr_queue_join,
            commands::dr_claim::native_dr_queue_status,
            commands::dr_claim::native_dr_queue_leave,
            commands::dr_claim::native_pick_dr_key_file,
            commands::dr_claim::native_set_dr_key,
            commands::install::get_install_status,
            commands::install::pick_install_path,
            commands::install::find_existing_install,
            commands::install::use_existing_install,
            commands::uninstall::uninstall_preview,
            commands::uninstall::uninstall_game,
            commands::launch::is_game_running,
            commands::launch::launched_game_state,
            commands::launch::secure_launch,
            commands::queue::native_queue_poll,
            commands::queue::native_queue_leave,
            commands::launch::set_launcher_minimized,
            commands::launcher_update::launcher_update_check,
            commands::launcher_update::launcher_update_install,
            commands::updates::check_runtime_update,
            commands::updates::install_runtime_update,
            commands::logs::native_get_log_paths,
            commands::logs::native_open_log_folder,
            commands::logs::native_upload_last_session,
            commands::online_save_download::native_download_online_save,
            commands::logs::native_report_crash,
            commands::logs::native_get_crash_dump_choice,
            commands::logs::native_set_crash_dump_choice,
            commands::logs::native_crash_dump_offer,
            commands::logs::native_answer_crash_dump,
            commands::game::native_game_manifest,
            commands::game::native_download_game,
            // RR-38 offline half (no network code; see src/offline/mod.rs).
            offline::commands::offline_get_mode,
            offline::commands::offline_accept_notice,
            offline::commands::offline_set_mode,
            offline::commands::offline_overview,
            offline::commands::offline_status,
            offline::commands::offline_start,
            offline::commands::offline_stop,
            offline::commands::offline_restart,
            offline::commands::offline_play,
            offline::commands::offline_install,
            offline::commands::offline_install_state,
            offline::commands::offline_get_rates,
            offline::commands::offline_save_rates,
            offline::commands::offline_reset_rates,
            offline::commands::offline_apply_rates,
            offline::commands::offline_import_save,
            offline::commands::offline_open_log_folder,
            commands::region::native_region_refresh,
            commands::admin::native_admin_request,
            commands::playtime::native_get_playtime,
            commands::game_language::native_game_languages,
            commands::game_language::native_get_game_language,
            commands::game_language::native_set_game_language,
        ]);
    #[cfg(not(feature = "admin"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
            commands::auth::native_restore_session,
            commands::auth::native_login,
            commands::auth::native_register,
            commands::auth::native_discord_complete,
            commands::auth::native_start_discord_login,
            commands::auth::native_set_username,
            commands::auth::native_logout,
            commands::auth::native_forget_session,
            commands::auth::native_get_policy,
            commands::dr_claim::native_dr_claim,
            commands::dr_claim::native_dr_choice_status,
            commands::dr_claim::native_dr_choice_decide,
            commands::dr_claim::native_dr_queue_join,
            commands::dr_claim::native_dr_queue_status,
            commands::dr_claim::native_dr_queue_leave,
            commands::dr_claim::native_pick_dr_key_file,
            commands::dr_claim::native_set_dr_key,
            commands::install::get_install_status,
            commands::install::pick_install_path,
            commands::install::find_existing_install,
            commands::install::use_existing_install,
            commands::uninstall::uninstall_preview,
            commands::uninstall::uninstall_game,
            commands::launch::is_game_running,
            commands::launch::launched_game_state,
            commands::launch::secure_launch,
            commands::queue::native_queue_poll,
            commands::queue::native_queue_leave,
            commands::launch::set_launcher_minimized,
            commands::launcher_update::launcher_update_check,
            commands::launcher_update::launcher_update_install,
            commands::updates::check_runtime_update,
            commands::updates::install_runtime_update,
            commands::logs::native_get_log_paths,
            commands::logs::native_open_log_folder,
            commands::logs::native_upload_last_session,
            commands::online_save_download::native_download_online_save,
            commands::logs::native_report_crash,
            commands::logs::native_get_crash_dump_choice,
            commands::logs::native_set_crash_dump_choice,
            commands::logs::native_crash_dump_offer,
            commands::logs::native_answer_crash_dump,
            commands::game::native_game_manifest,
            commands::game::native_download_game,
            // RR-38 offline half (no network code; see src/offline/mod.rs).
            offline::commands::offline_get_mode,
            offline::commands::offline_accept_notice,
            offline::commands::offline_set_mode,
            offline::commands::offline_overview,
            offline::commands::offline_status,
            offline::commands::offline_start,
            offline::commands::offline_stop,
            offline::commands::offline_restart,
            offline::commands::offline_play,
            offline::commands::offline_install,
            offline::commands::offline_install_state,
            offline::commands::offline_get_rates,
            offline::commands::offline_save_rates,
            offline::commands::offline_reset_rates,
            offline::commands::offline_apply_rates,
            offline::commands::offline_import_save,
            offline::commands::offline_open_log_folder,
            commands::region::native_region_refresh,
            commands::playtime::native_get_playtime,
            commands::game_language::native_game_languages,
            commands::game_language::native_get_game_language,
            commands::game_language::native_set_game_language,
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
