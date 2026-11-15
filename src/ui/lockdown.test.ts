// Right-click menu and browser shortcuts. Run with: node --test src/ui/  (Node 22.6+ strips the types; no packages needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { isEditable, isBlockedShortcut, installLockdown } from "./lockdown.ts";

const ctx = (target: any) => {
  let prevented = false;
  return { target, preventDefault: () => { prevented = true; }, get prevented() { return prevented; } };
};
const keyEv = (init: any) => {
  let prevented = false;
  return { ...init, preventDefault: () => { prevented = true; }, get prevented() { return prevented; } };
};
const handlers = () => installLockdown({ addEventListener() {} }, true);

test("the right-click menu is suppressed on ordinary elements", () => {
  for (const t of [{ tagName: "DIV" }, { tagName: "BUTTON" }, { tagName: "A" }, { tagName: "IMG" }, { tagName: "INPUT", type: "checkbox" }, { tagName: "BODY" }]) {
    const e = ctx(t);
    handlers().onContextMenu(e);
    assert.equal(e.prevented, true, t.tagName);
  }
});

test("text inputs, textareas and contenteditable keep their menu", () => {
  for (const t of [
    { tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "password" }, { tagName: "INPUT" },
    { tagName: "TEXTAREA" }, { tagName: "DIV", isContentEditable: true },
    { tagName: "SPAN", closest: () => ({ tagName: "DIV" }) },
  ]) {
    const e = ctx(t);
    handlers().onContextMenu(e);
    assert.equal(e.prevented, false, JSON.stringify(t));
  }
});

test("null target is treated as not editable", () => {
  assert.equal(isEditable(null), false);
  const e = ctx(null);
  handlers().onContextMenu(e);
  assert.equal(e.prevented, true);
});

test("browser shortcuts are blocked", () => {
  const blocked = [
    { key: "F5" }, { key: "F12" }, { key: "r", ctrlKey: true }, { key: "R", ctrlKey: true, shiftKey: true },
    { key: "p", ctrlKey: true }, { key: "s", ctrlKey: true }, { key: "u", ctrlKey: true },
    { key: "I", ctrlKey: true, shiftKey: true }, { key: "r", metaKey: true },
  ];
  for (const k of blocked) {
    assert.equal(isBlockedShortcut(k), true, JSON.stringify(k));
    const e = keyEv(k);
    handlers().onKeyDown(e);
    assert.equal(e.prevented, true);
  }
});

test("copy, paste, cut, select all, undo and plain typing are left alone", () => {
  for (const k of [
    { key: "c", ctrlKey: true }, { key: "v", ctrlKey: true }, { key: "x", ctrlKey: true }, { key: "a", ctrlKey: true },
    { key: "z", ctrlKey: true }, { key: "r" }, { key: "s" }, { key: "Enter" }, { key: "Tab" }, { key: "F1" },
    { key: "i", ctrlKey: true }, { key: "r", ctrlKey: true, altKey: true },
  ]) {
    assert.equal(isBlockedShortcut(k), false, JSON.stringify(k));
    const e = keyEv(k);
    handlers().onKeyDown(e);
    assert.equal(e.prevented, false);
  }
});

test("install adds capture listeners when enabled and nothing when disabled (debug build)", () => {
  const seen: string[] = [];
  const doc = { addEventListener: (t: string) => { seen.push(t); } };
  installLockdown(doc, false);
  assert.deepEqual(seen, []);
  installLockdown(doc, true);
  assert.deepEqual(seen, ["contextmenu", "keydown"]);
});
