import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isWrongFolderMessage, WRONG_FOLDER_TEXT_START } from "./wrongFolder.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("only the wrong-folder text offers the download button", () => {
  assert.equal(isWrongFolderMessage(`${WRONG_FOLDER_TEXT_START} (it looks like an old Dauntless or Dauntless Revived copy). Your account is fine.`), true);
  assert.equal(isWrongFolderMessage("Please update the launcher. This version is too old to start the game."), false);
  assert.equal(isWrongFolderMessage(null), false);
  assert.equal(isWrongFolderMessage(""), false);
});

test("the native side sends text that starts the way the screen looks for it", () => {
  const rust = read("../../src-tauri/src/commands/auth.rs");
  assert.ok(rust.includes(`WRONG_FOLDER_TEXT_START: &str = "${WRONG_FOLDER_TEXT_START}"`));
});

test("Home offers the download for a refused folder, and no longer suggests Steam or Epic folders", () => {
  const home = read("../screens/dashboard/HomeTab.tsx");
  assert.match(home, /isWrongFolderMessage/);
  assert.match(home, /forgetWrongGameFolder/);
  assert.match(home, /WRONG_FOLDER_BUTTON/);
  assert.doesNotMatch(home, /Use this folder/);
  assert.doesNotMatch(home, /findExistingInstall|useExistingInstall/);
});

test("the old launcher and wrong folder cases are kept apart", () => {
  const rust = read("../../src-tauri/src/commands/auth.rs");
  assert.match(rust, /launcher is out of date/);
  assert.match(rust, /Please update the launcher/);
});
