import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { PolicyProvider } from "./policy/PolicyContext";
import { LoginScreen } from "./screens/LoginScreen";
import { RegisterScreen } from "./screens/RegisterScreen";
import { SetUsernameScreen } from "./screens/SetUsernameScreen";
import { DashboardShell } from "./screens/DashboardShell";
import { Button } from "./components/Button";
import { AuthShell } from "./components/AuthShell";
import { checkLauncherUpdate, installLauncherUpdate, releaseLauncherUpdate, type LauncherUpdate } from "./api/updates";
import { isGameRunning } from "./api/tauri";
import { isLauncherOutdatedMessage, LAUNCHER_OUTDATED_EVENT } from "./lib/launcherOutdated";
import { isLaunching } from "./lib/launchState";
import { sanitizeError } from "./lib/sanitize";
import { DISCORD_ONLY } from "./lib/buildConfig";
import { WindowFrame } from "./components/WindowFrame";
import { ThemeProvider } from "./theme/ThemeContext";
import { ScaleResetOnStart } from "./ui/ScaleResetOnStart";
import { ReconnectingNotice } from "./components/ReconnectingNotice";
import { OfflineModeProvider, useOfflineMode } from "./offline/OfflineModeContext";
import { OneWayNotice } from "./offline/ModeSwitch";
import { OfflineShell } from "./offline/OfflineShell";
import { SupportLink } from "./components/SupportLink";

const DEV = import.meta.env.DEV;

function AppShell() {
  const { status, authError, retrySavedSession, forgetSavedSession, cancelDiscordLogin } = useAuth();
  const offline = useOfflineMode();
  const [showRegister, setShowRegister] = useState(false);
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdate | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // "Later" hides the popup for that version until the launcher is restarted.
  const [postponedVersion, setPostponedVersion] = useState<string | null>(null);
  const [gameBusy, setGameBusy] = useState(false);

  // Is a game starting or running? Looked at every few seconds, so the popup never lands on top of a launch.
  useEffect(() => {
    let alive = true;
    const look = () => {
      void isGameRunning()
        .catch(() => false)
        .then((running) => { if (alive) setGameBusy(running || isLaunching()); });
    };
    look();
    const timer = setInterval(look, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  // The update the banner offers. Once one is known no further checks are made: each would open another native
  // handle to the same update and replace the one on screen.
  const knownUpdateRef = useRef<LauncherUpdate | null>(null);
  const keepUpdate = (update: LauncherUpdate) => {
    if (knownUpdateRef.current) { releaseLauncherUpdate(update); return; }
    knownUpdateRef.current = update;
    setLauncherUpdate(update);
  };

  useEffect(() => {
    // Check for a launcher self-update on app START, regardless of auth status. Previously this was
    // gated behind status === "signedIn", so a persistent/saved session (or a launcher that can't
    // reach the account server, or is stuck at login) would never self-update. The updater is
    // independent of login, so run it as soon as the app mounts.
    let cancelled = false;
    void checkLauncherUpdate()
      .then((update) => {
        if (!cancelled) {
          if (update) {
            if (DEV) console.log("[updater] new version available:", update.version);
            keepUpdate(update);
          } else {
            if (DEV) console.log("[updater] already on latest");
          }
        } else if (update) {
          releaseLauncherUpdate(update); // the screen was torn down while the check ran
        }
      })
      .catch((err) => {
        if (DEV) console.warn("[updater] check failed:", err);
      });
    return () => { cancelled = true; };
  }, []);

  // Keep looking while the launcher stays open, so a published update shows up within about a minute instead of only
  // after a restart: every minute, and straight away when the window comes back to the front. Independent of auth
  // status. One check at a time; a failed or unreachable check is silently ignored.
  useEffect(() => {
    let checking = false;
    const check = () => {
      if (checking || knownUpdateRef.current) return;
      checking = true;
      void checkLauncherUpdate()
        .then((update) => {
          if (update) {
            if (DEV) console.log("[updater] periodic check found new version:", update.version);
            keepUpdate(update);
          }
        })
        .catch(() => {})
        .finally(() => { checking = false; });
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };

    const interval = setInterval(check, 60 * 1000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // A launcher below the server's minimum is refused with a "please update the launcher" text. Fetch the update and
  // install it straight away (once per run; a failed install shows its error in the update dialog).
  const autoUpdateStartedRef = useRef(false);
  const autoUpdate = () => {
    if (autoUpdateStartedRef.current || gameBusy) return;
    autoUpdateStartedRef.current = true;
    void (async () => {
      const update = knownUpdateRef.current ?? (await checkLauncherUpdate());
      if (!update) { autoUpdateStartedRef.current = false; return; }
      if (!knownUpdateRef.current) keepUpdate(update);
      setPostponedVersion(null);
      setInstallingUpdate(true);
      setUpdateError(null);
      try {
        await installLauncherUpdate(update);
      } catch (err) {
        setInstallingUpdate(false);
        setUpdateError(sanitizeError(err instanceof Error ? err.message : String(err)) || "The update could not be installed. Try again.");
        autoUpdateStartedRef.current = false;
      }
    })();
  };
  const autoUpdateRef = useRef(autoUpdate);
  autoUpdateRef.current = autoUpdate;
  useEffect(() => {
    if (isLauncherOutdatedMessage(authError)) autoUpdateRef.current();
  }, [authError]);
  useEffect(() => {
    const onOutdated = () => autoUpdateRef.current();
    window.addEventListener(LAUNCHER_OUTDATED_EVENT, onOutdated);
    return () => window.removeEventListener(LAUNCHER_OUTDATED_EVENT, onOutdated);
  }, []);

  // The Discord sign-in link expires after 5 minutes; don't leave the screen waiting past that.
  useEffect(() => {
    if (status !== "awaitingDiscord") return;
    const timer = setTimeout(() => cancelDiscordLogin("Discord did not send you back to the launcher. Check that the browser tab finished, then try again."), 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [status, cancelDiscordLogin]);

  // Not while a game is starting or running, and not for a version the player already put off.
  const showUpdate = launcherUpdate !== null && !gameBusy && postponedVersion !== launcherUpdate.version;
  const updateBanner = launcherUpdate && showUpdate ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-5" role="dialog" aria-modal="true">
      <div className="glass w-full max-w-md rounded-2xl border-border-strong p-6 shadow-[0_18px_40px_-16px] shadow-black/60">
        <p className="text-[15px] font-semibold text-text">A new version of Ramsgate Reborn is available</p>
        <p className="mt-2 text-[13px] text-text-muted">
          {updateError ?? `Version ${launcherUpdate.version} is ready. Updating downloads it, installs it and restarts the launcher.`}
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="secondary" disabled={installingUpdate} onClick={() => setPostponedVersion(launcherUpdate.version)}>
            Later
          </Button>
          <Button
            disabled={installingUpdate}
            onClick={() => {
              setInstallingUpdate(true);
              setUpdateError(null);
              void installLauncherUpdate(launcherUpdate).catch((err) => {
                setInstallingUpdate(false);
                const message = sanitizeError(err instanceof Error ? err.message : String(err));
                if (DEV) console.error("[updater] install failed:", err);
                setUpdateError(message);
              });
            }}
          >
            {installingUpdate ? "Updating…" : "Update now"}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  // RR-38: offline play needs no online sign-in. Signed in, the offline panel lives on the dashboard's Play tab.
  if (offline.mode === "offline" && status !== "signedIn" && status !== "checking" && status !== "awaitingDiscord") {
    return <>{updateBanner}<OfflineShell /><BackOnline onBack={() => offline.requestMode("online")} /></>;
  }

  if (status === "checking") {
    return (
      <AuthShell>
        <p className="display text-[28px] leading-none text-text">Signing you in</p>
        <div className="mt-6 h-1 w-44 overflow-hidden bg-border">
          <div className="h-full w-1/2 animate-[loading-slide_1.4s_ease-in-out_infinite] bg-accent" />
        </div>
        <p className="mt-3 text-xs text-text-muted">One momentâ€¦</p>
      </AuthShell>
    );
  }

  if (status === "awaitingDiscord") {
    return (
      <AuthShell>
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-faint">Step 2 of 2</p>
        <h1 className="display mt-2 text-[32px] leading-none text-text">Waiting for Discord</h1>
        <p className="mt-3 text-sm leading-relaxed text-text-muted">
          Finish in the browser window that just opened, then come back.
        </p>
        <Button className="mt-6 w-full" variant="secondary" onClick={() => cancelDiscordLogin()}>
          Cancel
        </Button>
      </AuthShell>
    );
  }

  if (status === "restoreFailed") {
    return (
      <>
        {updateBanner}
        <AuthShell>
          <h1 className="display text-[30px] leading-none text-text">Can't reach the server</h1>
          <p className="mt-3 text-sm leading-relaxed text-text-muted">
            {authError ?? "You're still signed in. Try again in a moment."}
          </p>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button onClick={() => void retrySavedSession()}>Retry</Button>
            <Button variant="secondary" onClick={() => void forgetSavedSession()}>Sign in again</Button>
          </div>
        </AuthShell>
      </>
    );
  }

  if (status === "awaitingUsername") {
    return <SetUsernameScreen />;
  }

  if (status === "pendingApproval") {
    return (
      <>
        {updateBanner}
        <AuthShell>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-faint">Almost there</p>
          <h1 className="display mt-2 text-[32px] leading-none text-text">Waiting for approval</h1>
          <p className="mt-3 text-sm leading-relaxed text-text-muted">
            Your account is waiting for approval. A staff member needs to look at it. This can take a little while.
          </p>
          <p className="mt-3 text-sm text-text-muted">
            Need a hand? <SupportLink />
          </p>
          <Button className="mt-6 w-full" variant="secondary" onClick={() => void forgetSavedSession()}>
            Back to sign in
          </Button>
        </AuthShell>
      </>
    );
  }

  if (status === "signedIn") {
    return <>{updateBanner}<DashboardShell /></>;
  }

  return showRegister && !DISCORD_ONLY ? (
    <>{updateBanner}<RegisterScreen onBackToLogin={() => setShowRegister(false)} /></>
  ) : (
    <>{updateBanner}<LoginScreen onCreateAccount={() => setShowRegister(true)} /><PlayOfflineLink onClick={() => offline.requestMode("offline")} /></>
  );
}

function PlayOfflineLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-5 left-5 z-40 rounded-full border border-border-strong bg-surface px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted transition-colors hover:border-accent hover:text-text"
    >
      Play offline
    </button>
  );
}

function BackOnline({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="fixed bottom-5 left-5 z-40 rounded-full border border-border-strong bg-surface px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted transition-colors hover:border-accent hover:text-text"
    >
      Back to online sign-in
    </button>
  );
}

function FramedApp() {
  const { status } = useAuth();
  const { mode } = useOfflineMode();
  // Once signed in, the dashboard header is the drag area; every other screen gets a drag strip along the top.
  return (
    <WindowFrame dragStrip={status !== "signedIn" && mode !== "offline"}>
      <AppShell />
      <ReconnectingNotice />
      <OneWayNotice />
    </WindowFrame>
  );
}

export default function App() {
  return (
    <div className="h-full bg-bg">
      <ThemeProvider>
        <ScaleResetOnStart />
        <AuthProvider>
          <PolicyProvider>
            <OfflineModeProvider>
              <FramedApp />
            </OfflineModeProvider>
          </PolicyProvider>
        </AuthProvider>
      </ThemeProvider>
    </div>
  );
}
