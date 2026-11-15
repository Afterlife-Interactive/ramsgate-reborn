import { useCallback, useEffect, useState } from "react";
import { SettingsIcon } from "../../components/icons";
import { Button } from "../../components/Button";
import { usePolicy } from "../../policy/PolicyContext";
import {
  getCrashDumpChoice,
  getGameLanguage,
  getGameLanguages,
  getLogPaths,
  openLogFolder,
  setCrashDumpChoice,
  setGameLanguage,
  uploadLastSession,
  type CrashDumpChoice,
} from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import type { LogPaths } from "../../api/types";
import type { GameLanguageOption } from "../../api/tauri";
import { THEMES, useTheme } from "../../theme/ThemeContext";
import { useOfflineMode } from "../../offline/OfflineModeContext";
import { OfflineRatesSection } from "../../offline/OfflineRatesSection";

type UploadState = { status: "idle" } | { status: "uploading" } | { status: "done"; count: number } | { status: "error"; message: string };

export function SettingsTab() {
  const { mode } = useOfflineMode();
  if (mode === "offline") {
    return (
      <div className="mx-auto max-w-xl px-8 py-10">
        <h1 className="display text-[30px] leading-none text-text">Settings</h1>
        <p className="mt-1 text-[13px] text-text-muted">Offline mode. Switch to Online on the Play tab for the online settings.</p>
        <OfflineRatesSection />
      </div>
    );
  }
  return <OnlineSettings />;
}

function OnlineSettings() {
  const { policy, channelChoice, setChannelChoice } = usePolicy();
  const { theme, setTheme } = useTheme();
  const canPickChannel = policy?.testChannelEligible === true;
  const [channelBusy, setChannelBusy] = useState(false);
  const isTester = policy?.roles.includes("tester") ?? false;
  const [paths, setPaths] = useState<LogPaths | null>(null);
  const [pathsError, setPathsError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ status: "idle" });
  const [languages, setLanguages] = useState<GameLanguageOption[]>([]);
  const [language, setLanguage] = useState("");
  const [languageError, setLanguageError] = useState<string | null>(null);

  const [dumpChoice, setDumpChoice] = useState<CrashDumpChoice>("ask");
  const [dumpError, setDumpError] = useState<string | null>(null);

  useEffect(() => {
    void getGameLanguages().then(setLanguages).catch(() => {});
    void getGameLanguage().then(setLanguage).catch(() => {});
    void getCrashDumpChoice().then(setDumpChoice).catch(() => {});
  }, []);

  const refreshPaths = useCallback(async () => {
    try {
      setPaths(await getLogPaths());
      setPathsError(null);
    } catch (err) {
      setPathsError(sanitizeError(err instanceof Error ? err.message : String(err)));
    }
  }, []);

  useEffect(() => {
    void refreshPaths();
  }, [refreshPaths]);

  const handleCopyPath = useCallback(() => {
    if (!paths) return;
    void navigator.clipboard.writeText(paths.sessionsRoot).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [paths]);

  const handleOpenFolder = useCallback(() => {
    void openLogFolder().catch(() => {});
  }, []);

  const handleUpload = useCallback(async () => {
    setUpload({ status: "uploading" });
    try {
      const count = await uploadLastSession();
      setUpload({ status: "done", count });
      void refreshPaths();
    } catch (err) {
      setUpload({ status: "error", message: sanitizeError(err instanceof Error ? err.message : String(err)) });
    }
  }, [refreshPaths]);

  return (
    <div className="max-w-[560px] px-12 pb-6 pt-4">
      <h1 className="display text-[30px] leading-none text-text">Settings</h1>
      <p className="mt-1 text-[13px] text-text-muted">Look and logs.</p>

      <section className="glass mt-7 rounded-2xl p-5">
        <p className="text-[13px] font-medium text-text">Theme</p>
        <p className="mt-0.5 text-xs text-text-muted">Changes the art and colours.</p>
        <div className="mt-4 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => {
            const active = t.id === theme.id;
            return (
              <button
                key={t.id}
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(t.id)}
                className={`group relative h-24 overflow-hidden rounded-xl text-left ring-1 transition-[box-shadow] ${
                  active ? "ring-2 ring-glow" : "ring-white/10 hover:ring-white/30"
                }`}
              >
                <img src={t.art} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover object-[70%_45%] transition-transform duration-500 group-hover:scale-105" />
                <span className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/30 to-transparent" />
                <span className="relative flex h-full flex-col justify-end p-3">
                  <span className="text-[13px] font-semibold text-white">{t.name}</span>
                  <span className="truncate text-[11px] text-white/70">{t.blurb}</span>
                </span>
                {active && (
                  <span className="absolute right-2.5 top-2.5 grid h-5 w-5 place-items-center rounded-full bg-glow text-[11px] font-bold text-black" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="glass mt-4 rounded-2xl p-5">
        <label htmlFor="game-language" className="text-[13px] font-medium text-text">Game language</label>
        <p className="mt-0.5 text-xs text-text-muted">The text language in Dauntless. Applies the next time you press Play. Leave it unset to keep the game's own setting.</p>
        <select
          id="game-language"
          value={language}
          onChange={(e) => {
            const code = e.target.value;
            setLanguageError(null);
            void setGameLanguage(code).then(() => setLanguage(code)).catch((err) => setLanguageError(sanitizeError(err instanceof Error ? err.message : String(err))));
          }}
          className="mt-3 w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-[13px] text-text"
        >
          <option value="">Game default</option>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
        {languageError && <p className="mt-2 text-[13px] text-danger">{languageError}</p>}
      </section>

      {canPickChannel && (
        <section className="glass mt-4 overflow-hidden rounded-2xl">
          <div className="px-6 py-4">
            <p className="text-[13px] font-medium text-text">Client runtime</p>
            <p className="mt-0.5 text-xs text-text-muted">Stable is what everyone plays. Beta is the test build, for accounts on the test list.</p>
            <div className="mt-3 flex gap-2">
              {(["stable", "beta"] as const).map((choice) => (
                <Button
                  key={choice}
                  variant={channelChoice === choice ? "primary" : "secondary"}
                  disabled={channelBusy}
                  onClick={() => {
                    setChannelBusy(true);
                    void setChannelChoice(choice).finally(() => setChannelBusy(false));
                  }}
                >
                  {choice === "stable" ? "Stable" : "Beta"}
                </Button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="mt-4 overflow-hidden glass rounded-2xl">
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-raised text-text-faint">
            <SettingsIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text">Logs</p>
            <p className="mt-0.5 text-xs text-text-muted">Every time you press Play, the launcher keeps a log.</p>
          </div>
        </div>

        <div className="px-6 py-4">
          {pathsError ? (
            <p className="text-[13px] text-danger">{pathsError}</p>
          ) : (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint">Log folder</p>
              <p className="mt-1 truncate font-mono text-[11px] text-text-muted" title={paths?.sessionsRoot}>
                {paths?.sessionsRoot ?? "Loading…"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" className="w-auto px-4" onClick={handleCopyPath} disabled={!paths}>
                  {copied ? "Copied" : "Copy path"}
                </Button>
                <Button variant="secondary" className="w-auto px-4" onClick={handleOpenFolder} disabled={!paths}>
                  Open folder
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-border px-6 py-4">
          <label htmlFor="crash-dumps" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint">Crash dumps</label>
          <p className="mt-1 text-[13px] text-text-muted">
            When Dauntless crashes it can save a snapshot of its memory. It helps us find the cause, but unlike the logs we
            can't take personal details out of it, so it is only sent if you allow it. Sent dumps are deleted after 3 days.
          </p>
          <select
            id="crash-dumps"
            value={dumpChoice}
            onChange={(e) => {
              const choice = e.target.value as CrashDumpChoice;
              setDumpError(null);
              void setCrashDumpChoice(choice).then(() => setDumpChoice(choice)).catch((err) => setDumpError(sanitizeError(err instanceof Error ? err.message : String(err))));
            }}
            className="mt-3 w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-[13px] text-text"
          >
            <option value="ask">Ask me after a crash</option>
            <option value="always">Always send</option>
            <option value="never">Never send</option>
          </select>
          {dumpError && <p className="mt-2 text-[13px] text-danger">{dumpError}</p>}
        </div>

        <div className="border-t border-border px-6 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint">Last session</p>
          <p className="mt-1 text-[13px] text-text-muted">
            {paths?.latestSessionDir ? "Your last session is ready to send." : "Nothing yet. Press Play first."}
          </p>

          {isTester ? (
            <>
              <Button
                variant="secondary"
                className="mt-3 w-auto px-4"
                onClick={() => void handleUpload()}
                disabled={upload.status === "uploading" || !paths?.latestSessionDir}
              >
                {upload.status === "uploading" ? "Uploading…" : "Upload last session"}
              </Button>
              {upload.status === "done" && (
                <p className="mt-2 text-[13px] text-online">
                  Uploaded {upload.count} file{upload.count === 1 ? "" : "s"}.
                </p>
              )}
              {upload.status === "error" && <p className="mt-2 text-[13px] text-danger">{upload.message}</p>}
            </>
          ) : (
            <p className="mt-3 text-[13px] text-text-faint">Only tester accounts can send logs.</p>
          )}
        </div>
      </section>
    </div>
  );
}
