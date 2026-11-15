// The Uninstall confirm in the Game files tab. Run with: node --test src/ui/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { canConfirm, canDismiss, errorText, formatBytes, progressPercent, resultLine, workingLabel, type UninstallStage } from "./uninstall.ts";

const Launcher = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(Launcher, rel), "utf8");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

test("sizes are shown in plain units", () => {
  assert.equal(formatBytes(15 * 1073741824), "15.00 GB");
  assert.equal(formatBytes(5 * 1048576), "5.0 MB");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(12), "12 B");
  assert.equal(formatBytes(-1), "unknown size");
  assert.equal(formatBytes(Number.NaN), "unknown size");
});

test("only a checked folder can be confirmed; nothing can be dismissed mid-delete", () => {
  const ready: UninstallStage = { kind: "ready", path: "D:\\Ramsgate Reborn\\Game", bytes: 1, files: 1, logsBytes: 0 };
  const stages: UninstallStage[] = [
    { kind: "measuring" },
    ready,
    { kind: "refused", reason: "Dauntless is running. Close the game first.", path: null },
    { kind: "working", done: 1, total: 2, phase: "removing" },
    { kind: "failed", message: "x" },
  ];
  assert.deepEqual(stages.map(canConfirm), [false, true, false, false, false]);
  assert.deepEqual(stages.map(canDismiss), [true, true, true, false, true]);
});

test("progress is a real fraction, clamped, and shows counts", () => {
  assert.equal(progressPercent(50, 200), 25);
  assert.equal(progressPercent(5, 0), 0);
  assert.equal(progressPercent(300, 200), 100);
  assert.match(workingLabel({ kind: "working", done: 1500, total: 6000, phase: "removing" }), /1,500 of 6,000 \(25%\)/);
  assert.match(workingLabel({ kind: "working", done: 0, total: 0, phase: "removing" }), /Deleting game files/);
  assert.match(workingLabel({ kind: "working", done: 0, total: 0, phase: "logs" }), /logs/);
});

test("the result line says what was removed and what was kept", () => {
  const line = resultLine({ files: 1234, bytes: 3 * 1073741824, logsDeleted: false });
  assert.match(line, /1,234 files \(3\.00 GB\)/);
  assert.match(line, /settings, login and offline data were kept/);
  assert.ok(!/logs deleted/i.test(line));
  assert.match(resultLine({ files: 1, bytes: 1, logsDeleted: true }), /logs deleted/i);
});

test("errors are always shown as text, never empty", () => {
  assert.equal(errorText("Dauntless is running."), "Dauntless is running.");
  assert.equal(errorText(new Error("boom")), "boom");
  assert.ok(errorText(undefined).length > 10);
  assert.ok(errorText("   ").length > 10);
});

test("the modal is in-app: no browser confirm, the logs box starts unticked, errors are rendered", () => {
  const modal = strip(read("src/screens/dashboard/UninstallModal.tsx"));
  const tab = strip(read("src/screens/dashboard/LibraryTab.tsx"));
  for (const code of [modal, tab]) {
    assert.ok(!/\bconfirm\s*\(/.test(code.replace(/const confirm = async/, "")), "no confirm() call");
    assert.ok(!/window\.(confirm|alert)|\balert\s*\(/.test(code));
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//.test(code), "no network code");
  }
  assert.match(modal, /useState\(false\);\s*\n\s*const mountedRef/, "deleteLogs starts false");
  assert.match(modal, /Also delete launcher logs/);
  assert.match(modal, /Cancel/);
  assert.match(modal, /"Uninstall"/);
  assert.match(modal, /stage\.kind === "failed"/);
  assert.match(modal, /stage\.kind === "refused"/);
  assert.match(modal, /game-uninstall-progress/);
  assert.match(modal, /uninstallGame\(deleteLogs\)/);
});

test("the Uninstall button sits with Locate again in Game files and the result line is shown", () => {
  const tab = read("src/screens/dashboard/LibraryTab.tsx");
  assert.match(tab, /Locate again[\s\S]*Uninstall\s*<\/button>/);
  assert.match(tab, /<UninstallModal/);
  assert.match(tab, /resultLine\(result\)/);
  assert.match(tab, /role="status"/);
});

test("the two new native commands are the only calls the uninstall adds", () => {
  const api = read("src/api/tauri.ts");
  assert.match(api, /invoke<UninstallPreview>\("uninstall_preview"\)/);
  assert.match(api, /invoke<UninstallResult>\("uninstall_game", \{ deleteLogs \}\)/);
  const lib = read("src-tauri/src/lib.rs");
  assert.equal((lib.match(/commands::uninstall::uninstall_game/g) ?? []).length, 2, "registered in both builds");
  assert.equal((lib.match(/commands::uninstall::uninstall_preview/g) ?? []).length, 2);
});

test("the Rust uninstall code has no network, shell or process spawning", () => {
  for (const f of ["src-tauri/src/install/uninstall.rs", "src-tauri/src/commands/uninstall.rs"]) {
    const code = read(f).split("#[cfg(test)]")[0].replace(/\/\/[^\n]*/g, "");
    assert.ok(!/reqwest|TcpStream|UdpSocket|http_client|api_base_url|refresh_native_session|Command::new/.test(code), f);
  }
});
