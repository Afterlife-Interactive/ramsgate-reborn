// Keeps the launcher from behaving like a web page: no browser right-click menu (Back, Refresh, Save as, Print, More
// tools) and no browser shortcuts. Text fields keep their menu and their copy/paste. Pure logic, no packages, so it runs
// under `node --test`.

export interface LockdownTarget {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
  closest?: (selector: string) => LockdownTarget | null;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);

/** True for elements the player types into: text inputs, textareas, contenteditable. */
export function isEditable(target: LockdownTarget | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((target.type ?? "").toLowerCase());
  if (target.isContentEditable) return true;
  if (typeof target.closest === "function") {
    const parent = target.closest("[contenteditable=''],[contenteditable='true']");
    if (parent) return true;
  }
  return false;
}

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** True for the browser shortcuts the launcher blocks: F5, Ctrl+R, Ctrl+Shift+R, Ctrl+P, Ctrl+S, Ctrl+U, F12, Ctrl+Shift+I. */
export function isBlockedShortcut(e: KeyLike): boolean {
  const key = e.key.toLowerCase();
  if (key === "f5" || key === "f12") return true;
  const mod = !!(e.ctrlKey || e.metaKey);
  if (!mod || e.altKey) return false;
  if (e.shiftKey) return key === "r" || key === "i";
  return key === "r" || key === "p" || key === "s" || key === "u";
}

export interface EventSource {
  addEventListener(type: string, listener: (e: any) => void, options?: boolean): void;
}

/**
 * Installs the handlers. When `enabled` is false (the dev/debug build) nothing is installed, so the inspector and reload
 * keep working there. Returns the handlers for tests.
 */
export function installLockdown(doc: EventSource, enabled: boolean) {
  const onContextMenu = (e: { target: LockdownTarget | null; preventDefault(): void }) => {
    if (!isEditable(e.target)) e.preventDefault();
  };
  const onKeyDown = (e: KeyLike & { preventDefault(): void }) => {
    if (isBlockedShortcut(e)) e.preventDefault();
  };
  if (enabled) {
    doc.addEventListener("contextmenu", onContextMenu, true);
    doc.addEventListener("keydown", onKeyDown, true);
  }
  return { onContextMenu, onKeyDown };
}
