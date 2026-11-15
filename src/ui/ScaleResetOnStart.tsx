import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { clearLegacyScale } from "./legacyScaleReset";

/** Runs once at startup: drops the old stored UI scale and puts zoom and window size back to 100%. */
export function ScaleResetOnStart() {
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = localStorage;
    } catch {
      storage = null;
    }
    if (!clearLegacyScale(storage)) return;
    void (async () => {
      try {
        await getCurrentWebview().setZoom(1);
        const win = getCurrentWindow();
        await win.setMinSize(new LogicalSize(960, 600));
        await win.setSize(new LogicalSize(1120, 700));
      } catch {
        // Plain browser, not the app window: nothing to put back.
      }
    })();
  }, []);
  return null;
}
