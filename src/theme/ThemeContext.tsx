import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BrandMark } from "../components/BrandMark";
import { Button } from "../components/Button";
import { nextThemeIndex } from "../ui/themePickerKeys";
import { renamedThemeId } from "../ui/themeAlias";
import tideArt from "../assets/art/theme-classic.webp";
import verdantArt from "../assets/art/theme-jade.webp";
import nightshadeArt from "../assets/art/theme-dusk.webp";
import cinderArt from "../assets/art/theme-ember.webp";
import koshaiArt from "../assets/art/theme-koshai.webp";
import rezaArt from "../assets/art/theme-reza.webp";
import frostbiteArt from "../assets/art/theme-frostbite.webp";
import draskArt from "../assets/art/theme-drask.webp";
import kharabakArt from "../assets/art/theme-kharabak.webp";
import embermaneArt from "../assets/art/theme-embermane.webp";
import phaelanxArt from "../assets/art/theme-phaelanx.webp";
import riftstalkerArt from "../assets/art/theme-riftstalker.webp";
import valomyrArt from "../assets/art/theme-valomyr.webp";
import sahvytArt from "../assets/art/theme-sahvyt.webp";

export type ThemeId = "nightshade" | "tide" | "verdant" | "cinder" | "koshai" | "reza" | "frostbite"
  | "drask"
  | "kharabak"
  | "embermane"
  | "phaelanx"
  | "riftstalker"
  | "valomyr"
  | "sahvyt";

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  blurb: string;
  art: string;
}

// Each theme is one piece of art plus a palette (index.css, [data-theme=...]). The art is drawn full-bleed behind
// every screen; the palette tints glass panels, the accent and the Play ring to match it.
export const THEMES: ThemeInfo[] = [
  { id: "nightshade", name: "Shrowd", blurb: "Purple", art: nightshadeArt },
  { id: "tide", name: "Gnasher", blurb: "Orange", art: tideArt },
  { id: "verdant", name: "Skarn", blurb: "Green", art: verdantArt },
  { id: "cinder", name: "Hellion", blurb: "Gold", art: cinderArt },
  { id: "koshai", name: "Koshai", blurb: "Green", art: koshaiArt },
  { id: "reza", name: "Rezakiri", blurb: "Pink", art: rezaArt },
  { id: "frostbite", name: "Pangar", blurb: "Ice blue", art: frostbiteArt },
  { id: "drask", name: "Drask", blurb: "Lime", art: draskArt },
  { id: "kharabak", name: "Kharabak", blurb: "Magenta", art: kharabakArt },
  { id: "embermane", name: "Embermane", blurb: "Red", art: embermaneArt },
  { id: "phaelanx", name: "Phaelanx", blurb: "Flame", art: phaelanxArt },
  { id: "riftstalker", name: "Riftstalker", blurb: "Violet", art: riftstalkerArt },
  { id: "valomyr", name: "Valomyr", blurb: "Deep blue", art: valomyrArt },
  { id: "sahvyt", name: "Sahvyt", blurb: "Olive", art: sahvytArt },
];

const STORAGE_KEY = "rr-theme";
const DEFAULT_THEME: ThemeId = "nightshade";

function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

function loadSavedTheme(): ThemeId | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // A renamed id (see themeAlias.ts) is loaded and saved again under its new id.
    const renamed = renamedThemeId(stored);
    if (renamed) localStorage.setItem(STORAGE_KEY, renamed);
    const saved = renamed ?? stored;
    return isThemeId(saved) ? saved : null;
  } catch {
    return null;
  }
}

interface ThemeValue {
  theme: ThemeInfo;
  /** False until the player has picked a theme on this PC; the first-launch picker shows until then. */
  chosen: boolean;
  /** Shows a theme without saving it (the first-launch picker's preview). */
  previewTheme: (id: ThemeId) => void;
  setTheme: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [saved] = useState(loadSavedTheme);
  const [themeId, setThemeId] = useState<ThemeId>(saved ?? DEFAULT_THEME);
  const [chosen, setChosen] = useState(saved !== null);
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];

  useEffect(() => {
    document.documentElement.dataset.theme = theme.id;
  }, [theme.id]);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeId(id);
    setChosen(true);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Storage unavailable: the choice lasts until the launcher closes.
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, chosen, previewTheme: setThemeId, setTheme }}>{children}</ThemeContext.Provider>;
}

const PICKER_COLUMNS = 2;

/**
 * Shown the first time the launcher opens on a PC, so not everyone ends up on the same theme. The list sits on a
 * glass card like the sign-in form; the window behind it shows the theme being looked at, so the art, accent and
 * glow change live while the player moves through the list. Nothing is saved until Continue.
 */
export function FirstThemePicker() {
  const { theme, chosen, previewTheme, setTheme } = useTheme();
  const listRef = useRef<HTMLDivElement>(null);
  const index = Math.max(0, THEMES.findIndex((t) => t.id === theme.id));

  // Start on the selected theme so the arrow keys and Enter work straight away.
  useEffect(() => {
    if (chosen) return;
    listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
  }, [chosen]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
  }, [theme.id]);

  if (chosen) return null;

  function onListKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      setTheme(theme.id);
      return;
    }
    const next = nextThemeIndex(index, event.key, THEMES.length, PICKER_COLUMNS);
    if (next === null) return;
    event.preventDefault();
    previewTheme(THEMES[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="theme-picker-title"
      className="absolute inset-0 z-40 bg-bg"
    >
      <ThemeBackdrop />

      <div
        data-tauri-drag-region
        className="relative flex h-full flex-col px-12 pb-10 pt-9 [@media(max-height:660px)]:pb-5 [@media(max-height:660px)]:pt-5"
      >
        <div className="flex items-center gap-3">
          <BrandMark height={40} />
          <div>
            <p className="display text-[17px] leading-none text-text">Ramsgate Reborn</p>
            <p className="mt-1 text-[11px] text-text-faint">A Dauntless 1.12 server</p>
          </div>
        </div>

        <main data-tauri-drag-region className="flex min-h-0 flex-1 items-center pt-6 [@media(max-height:660px)]:pt-3">
          <div className="glass flex max-h-full w-full max-w-[440px] flex-col rounded-3xl p-7 shadow-[0_30px_60px_-30px] shadow-black/70 [@media(max-height:660px)]:p-6">
            <h1 id="theme-picker-title" className="display text-[30px] leading-none text-text">
              Choose a theme
            </h1>
            <p className="mt-2.5 text-sm text-text-muted">Sets the art and colours. You can change it later in Settings.</p>

            <div
              ref={listRef}
              role="radiogroup"
              aria-labelledby="theme-picker-title"
              onKeyDown={onListKey}
              className="-mx-1 mt-5 [@media(max-height:660px)]:mt-4 grid min-h-0 grid-cols-2 gap-1 overflow-y-auto p-1"
            >
              {THEMES.map((t) => {
                const active = t.id === theme.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-theme-id={t.id}
                    tabIndex={active ? 0 : -1}
                    onClick={() => previewTheme(t.id)}
                    onDoubleClick={() => setTheme(t.id)}
                    className={`flex h-10 items-center gap-2.5 rounded-xl pl-1 pr-2.5 text-left transition-colors duration-150 focus-visible:outline-offset-0 ${
                      active ? "bg-accent-muted ring-1 ring-glow" : "hover:bg-white/8"
                    }`}
                  >
                    <img
                      src={t.art}
                      alt=""
                      draggable={false}
                      className="h-8 w-11 shrink-0 rounded-lg object-cover object-[70%_45%]"
                    />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[13px] font-semibold text-text">{t.name}</span>
                      <span className="block truncate text-[11px] text-text-faint">
                        {t.id === DEFAULT_THEME ? `${t.blurb}, default` : t.blurb}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <Button className="mt-5 w-full shrink-0 py-3 [@media(max-height:660px)]:mt-4" onClick={() => setTheme(theme.id)}>
              Continue
            </Button>
          </div>
        </main>
      </div>

      <div aria-hidden className="pointer-events-none absolute bottom-10 right-12 text-right [@media(max-height:660px)]:bottom-5">
        <p className="display text-[44px] leading-none text-white [text-shadow:0_2px_18px_rgb(0_0_0/0.55)]">{theme.name}</p>
        <p className="mt-2 text-[13px] text-white/80 [text-shadow:0_1px_8px_rgb(0_0_0/0.6)]">{theme.blurb}</p>
      </div>
    </div>
  );
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

/** The current theme's art, full-bleed, with a scrim that keeps the left side readable. */
export function ThemeBackdrop() {
  const { theme } = useTheme();
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {THEMES.map((t) => (
        <img
          key={t.id}
          src={t.art}
          alt=""
          draggable={false}
          className={`absolute inset-0 h-full w-full object-cover object-[70%_45%] transition-opacity duration-700 ${t.id === theme.id ? "opacity-100" : "opacity-0"}`}
        />
      ))}
      <div className="backdrop-scrim absolute inset-0" />
    </div>
  );
}
