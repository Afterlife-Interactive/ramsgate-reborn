// RR-38: the offline half of the launcher UI cannot reach the network or the online half. Run with: node --test src/offline/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { OFFLINE_COMMANDS, ONE_WAY_NOTICE } from "./oneWay.ts";

const Here = path.dirname(url.fileURLToPath(import.meta.url));
const Launcher = path.resolve(Here, "..", "..");

function offlineSources(): [string, string][] {
  return fs
    .readdirSync(Here)
    .filter((n) => /\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n))
    .map((n) => [n, fs.readFileSync(path.join(Here, n), "utf8")]);
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const ALLOWED_IMPORTS = [/^\.\/[\w.]+$/, /^react$/, /^@tauri-apps\/api\/core$/, /^\.\.\/components\/(Button|BrandMark|icons)$/, /^\.\.\/lib\/sanitize$/];

test("the offline sources are all there", () => {
  const names = offlineSources().map(([n]) => n);
  for (const n of ["api.ts", "rates.ts", "oneWay.ts", "OfflinePanel.tsx", "OfflineRatesSection.tsx", "ModeSwitch.tsx", "OfflineModeContext.tsx", "OfflineShell.tsx"]) {
    assert.ok(names.includes(n), n);
  }
});

test("no network calls and no URLs in the offline UI", () => {
  for (const [n, src] of offlineSources()) {
    const code = stripComments(src);
    for (const bad of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\b(?:https?|wss?):\/\//, /\bwindow\.open\s*\(/]) {
      assert.ok(!bad.test(code), `${n} matches ${bad}`);
    }
  }
});

test("the offline UI imports nothing from the online half (no account API, session, policy, updater, opener)", () => {
  for (const [n, src] of offlineSources()) {
    for (const m of stripComments(src).matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2];
      assert.ok(ALLOWED_IMPORTS.some((r) => r.test(spec)), `${n} imports ${spec}`);
    }
  }
});

test("every native call from the offline UI is an offline_* command; the online save call is not among them", () => {
  let calls = 0;
  for (const [n, src] of offlineSources()) {
    const code = stripComments(src);
    for (const m of code.matchAll(/\b(?:invoke|call)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      assert.ok((OFFLINE_COMMANDS as readonly string[]).includes(m[1]), `${n} calls ${m[1]}`);
      calls++;
    }
    assert.ok(!code.includes("native_"), `${n} names a native_* (online) command`);
    // invoke is only used inside api.ts, through the typed wrapper.
    if (n !== "api.ts") assert.ok(!/\binvoke\b/.test(code), `${n} uses invoke directly`);
  }
  assert.ok(calls >= OFFLINE_COMMANDS.length);
});

test("the command list matches the Rust offline commands and their registration", () => {
  const rust = fs.readFileSync(path.join(Launcher, "src-tauri", "src", "offline", "commands.rs"), "utf8");
  const defined = [...rust.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(defined, [...OFFLINE_COMMANDS].sort());
  const lib = fs.readFileSync(path.join(Launcher, "src-tauri", "src", "lib.rs"), "utf8");
  for (const c of OFFLINE_COMMANDS) {
    // Registered in both the player and the admin build.
    assert.equal(lib.split(`offline::commands::${c},`).length - 1, 2, c);
  }
});

test("the offline UI never downloads, picks files or names the snapshot; the only save path is the injected copy", () => {
  const dash = path.join(Launcher, "src", "screens", "dashboard");
  const wrapper = stripComments(fs.readFileSync(path.join(dash, "OfflineHome.tsx"), "utf8"));
  assert.ok(!/api\/tauri|useAuth|getOnlineSave/.test(wrapper), "the offline Play tab must not touch the online half beyond the save download");
  for (const [n, src] of offlineSources()) {
    const code = stripComments(src);
    assert.ok(!/getOnlineSave|downloadOnlineSave|native_download_online_save|pickSaveFile|offline_pick_save_file|rrsnap|snapshot|online-save-downloads/i.test(code), `${n} reaches the download or the snapshot`);
    assert.ok(!/offline_import(?!_save)/.test(code), `${n} has an old import command`);
  }
  const panel = stripComments(fs.readFileSync(path.join(Here, "OfflinePanel.tsx"), "utf8"));
  assert.match(panel, /importSave\(copy\.fileName\)/, "the panel imports only the file name it was handed");
  assert.match(panel, /Load my online save/);
  const strings = offlineSources().flatMap(([n, src]) => [...src.matchAll(/>([^<>{}]*[A-Za-z]{4}[^<>{}]*)</g)].map((m) => [n, m[1]] as const));
  const quoted = offlineSources().flatMap(([n, src]) => [...src.matchAll(/"([^"\n]{12,})"/g)].map((m) => [n, m[1]] as const));
  for (const [n, t] of [...strings, ...quoted]) {
    assert.ok(!/mongo|database|replica set/i.test(t), `${n}: "${t}" uses database wording`);
  }
});

test("Install offline and Play offline are the only buttons the player needs", () => {
  const panel = fs.readFileSync(path.join(Here, "OfflinePanel.tsx"), "utf8");
  assert.match(panel, /Install offline/);
  assert.match(panel, /Play offline/);
  assert.ok(!/Set up offline mode|Choose component folder|Save slots|Fresh start/.test(panel));
});

test("the one-way notice says it plainly", () => {
  const text = ONE_WAY_NOTICE.join(" ");
  assert.match(text, /never be moved to your online account/);
  assert.match(text, /never connects to the online servers/);
  assert.match(text, /does not include any Phoenix Labs game files or data/);
});

test("the online save download command is registered in both the player and the admin build", () => {
  const lib = fs.readFileSync(path.join(Launcher, "src-tauri", "src", "lib.rs"), "utf8");
  assert.equal(lib.split("commands::online_save_download::native_download_online_save,").length - 1, 2);
});
