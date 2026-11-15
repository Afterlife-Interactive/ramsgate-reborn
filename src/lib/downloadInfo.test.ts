import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  diskNeededBytes,
  diskNeededGigabytes,
  downloadButtonLabel,
  downloadNeedsLine,
  formatGigabytes,
  foundInstallText,
  shouldOfferFoundInstall,
} from "./downloadInfo.ts";

const GIB = 1073741824;

test("sizes are shown in plain gigabytes", () => {
  assert.equal(formatGigabytes(16 * GIB), "16 GB");
  assert.equal(formatGigabytes(15.6 * GIB), "16 GB");
  assert.equal(formatGigabytes(7.5 * GIB), "7.5 GB");
  assert.equal(formatGigabytes(8 * GIB), "8 GB");
});

test("disk need is twice the archive plus 2 GB, rounded up like the native check", () => {
  assert.equal(diskNeededBytes(16 * GIB), 34 * GIB);
  assert.equal(diskNeededGigabytes(16 * GIB), 35);
  assert.equal(diskNeededGigabytes(16.5 * GIB), 36);
});

test("the button and the line use the manifest size, with a safe fallback", () => {
  assert.equal(downloadButtonLabel({ size: 16 * GIB }), "Download game (16 GB)");
  assert.match(downloadNeedsLine({ size: 16 * GIB }), /16 GB.*about 35 GB of free disk space/);
  for (const bad of [null, undefined, { size: 0 }, { size: Number.NaN }, { size: -5 }]) {
    assert.equal(downloadButtonLabel(bad as never), "Download game");
    assert.equal(downloadNeedsLine(bad as never), "");
  }
});

test("a found install is offered only when nothing is set up and the player has not declined", () => {
  assert.equal(shouldOfferFoundInstall("D:\\Games\\Dauntless", false, false), true);
  assert.equal(shouldOfferFoundInstall(null, false, false), false);
  assert.equal(shouldOfferFoundInstall("  ", false, false), false);
  assert.equal(shouldOfferFoundInstall("D:\\Games\\Dauntless", true, false), false);
  assert.equal(shouldOfferFoundInstall("D:\\Games\\Dauntless", false, true), false);
  assert.match(foundInstallText("D:\\Games\\Dauntless"), /D:\\Games\\Dauntless.*Use this folder\?/);
});

test("the native side only looks, and saves only on the confirm call", () => {
  const rs = readFileSync(new URL("../../src-tauri/src/commands/install.rs", import.meta.url), "utf8");
  const probe = rs.slice(rs.indexOf("fn probe_existing_install"), rs.indexOf("pub async fn find_existing_install"));
  assert.ok(probe.length > 0);
  assert.doesNotMatch(probe, /save_exe_path|remove_|write|create_dir|Command/);
  const find = rs.slice(rs.indexOf("pub async fn find_existing_install"), rs.indexOf("pub async fn use_existing_install"));
  assert.doesNotMatch(find, /save_exe_path/);
  assert.match(rs, /pub async fn use_existing_install[\s\S]*save_exe_path/);
});
