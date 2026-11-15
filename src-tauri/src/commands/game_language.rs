use serde::Serialize;

use crate::launch::game_language;

#[derive(Serialize)]
pub struct LanguageOption {
    pub code: &'static str,
    pub name: &'static str,
}

#[tauri::command]
pub fn native_game_languages() -> Vec<LanguageOption> {
    game_language::LANGUAGES.iter().map(|(code, name)| LanguageOption { code, name }).collect()
}

#[tauri::command]
pub fn native_get_game_language() -> String {
    game_language::current()
}

#[tauri::command]
pub fn native_set_game_language(code: String) -> Result<(), String> {
    game_language::set(&code)
}
