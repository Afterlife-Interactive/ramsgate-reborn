import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isLauncherOutdatedMessage, LAUNCHER_OUTDATED_TEXT_START } from "./launcherOutdated.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("only the launcher-too-old text starts the automatic update", () => {
  assert.equal(isLauncherOutdatedMessage(`${LAUNCHER_OUTDATED_TEXT_START}. This version is too old to start the game.`), true);
  assert.equal(isLauncherOutdatedMessage("This game folder is not the Ramsgate Reborn game (it looks like an old copy)."), false);
  assert.equal(isLauncherOutdatedMessage("The game could not be started. Either this game folder is not the Ramsgate Reborn game, or the launcher is too old."), false);
  assert.equal(isLauncherOutdatedMessage(null), false);
  assert.equal(isLauncherOutdatedMessage(""), false);
});

test("the native text starts the way the screen looks for it", () => {
  const rust = read("../../src-tauri/src/commands/auth.rs");
  assert.ok(rust.includes(`LAUNCHER_OUTDATED_TEXT_START: &str = "${LAUNCHER_OUTDATED_TEXT_START}"`));
});

test("the app shell installs the update when the refusal shows up", () => {
  const app = read("../App.tsx");
  assert.match(app, /isLauncherOutdatedMessage\(authError\)/);
  assert.match(app, /LAUNCHER_OUTDATED_EVENT/);
  assert.match(app, /installLauncherUpdate\(update\)/);
  const home = read("../screens/dashboard/HomeTab.tsx");
  assert.match(home, /announceIfLauncherOutdated/);
});

test("a refused game exe never tells the player to verify or repair", () => {
  const rust = read("../../src-tauri/src/commands/auth.rs");
  const body = rust.slice(rust.indexOf("pub(crate) fn game_build_unsupported_text"), rust.indexOf("pub(crate) fn safe_api_error"));
  assert.doesNotMatch(body, /verify or repair/i);
  assert.match(body, /WRONG_FOLDER_TEXT_START/);
  const ui = read("../auth/AuthContext.tsx");
  assert.doesNotMatch(ui, /verify or repair/i);
});
