import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FirstThemePicker, ThemeBackdrop } from "../theme/ThemeContext";

interface WindowFrameProps {
  children: ReactNode;
  /** Adds an invisible strip along the top for dragging the window. Leave off when a header already handles it. */
  dragStrip?: boolean;
}

function run(action: "minimize" | "close") {
  try {
    void getCurrentWindow()[action]();
  } catch {
    // Not running inside the app window (plain browser): nothing to do.
  }
}

/**
 * The launcher has no native title bar. This draws the theme's art behind everything, a thin edge around the
 * window, and two round minimize / close buttons in the top-right corner. Dragging is done with
 * `data-tauri-drag-region`.
 */
export function WindowFrame({ children, dragStrip = false }: WindowFrameProps) {
  return (
    <div className="relative h-full overflow-hidden rounded-[12px] border border-border-strong bg-bg">
      <ThemeBackdrop />
      <div className="relative h-full">{children}</div>
      <FirstThemePicker />

      {dragStrip && <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-40 h-10 pr-24" />}

      <div className="absolute right-3 top-3 z-50 flex gap-1.5">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => run("minimize")}
          className="grid h-7 w-7 place-items-center rounded-full bg-black/30 text-on-ink-muted backdrop-blur transition-colors hover:bg-white/15 hover:text-on-ink"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => run("close")}
          className="grid h-7 w-7 place-items-center rounded-full bg-black/30 text-on-ink-muted backdrop-blur transition-colors hover:bg-[oklch(0.6_0.2_25)] hover:text-white"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
