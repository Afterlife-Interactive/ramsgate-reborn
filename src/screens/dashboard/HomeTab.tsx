import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAuth } from "../../auth/AuthContext";
import { usePolicy } from "../../policy/PolicyContext";
import { listen } from "@tauri-apps/api/event";
import { stillRunning, RUNNING_POLL_MS } from "../../launch/runningPhase";
import { getInstallStatus, pickInstallPath, isGameRunning, launchedGameState, secureLaunch, setLauncherMinimized, queuePoll, queueLeave, checkRuntimeUpdate, installRuntimeUpdate, getGameManifest, forgetWrongGameFolder, downloadGame, drClaim, drChoiceStatus, drSkip, pickDrKeyFile, setDrKey, type DrClaimStatus, type InstallStatus, type GameManifest, type GameDownloadProgress } from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import { downloadButtonLabel, downloadNeedsLine } from "../../lib/downloadInfo";
import { announceIfLauncherOutdated } from "../../lib/launcherOutdated";
import { isWrongFolderMessage, OWN_DOWNLOAD_REFUSED_TEXT, WRONG_FOLDER_BUTTON } from "../../lib/wrongFolder";
import { viewFor, exhaustedView, viewForClaimCode, showClaimNotice, DR_TEXT, type DrChoiceAnswer, type DrChoiceView } from "../../lib/drChoice";
import { DrChoiceScreen } from "./DrChoiceScreen";
import { DR_PLAY_HOLD_LABEL, playHoldFor } from "../../lib/drPlayGuard";
import { DrReclaimButton } from "./DrReclaimButton";
import { StartFreshButton } from "./StartFreshButton";
import { homePrimary, isDrGateMessage, DR_GATE_TEXT, type GameState } from "../../lib/drHomeState";
import { DrQueuePanel } from "./DrQueuePanel";
import { setLaunching } from "../../lib/launchState";
import { PlayIcon } from "../../components/icons";
import { RegionReporter } from "../../components/RegionReporter";
import { Banner } from "../../components/Banner";
import { SupportLink } from "../../components/SupportLink";
import { launcherApi } from "../../api/client";
import { ModeSwitch } from "../../offline/ModeSwitch";
import type { ServerStatusResponse } from "../../api/types";

// Quiet when all is fine. Shows the owner's message and/or a plain line when the servers look unhealthy.
function StatusBanner({ server }: { server: ServerStatusResponse | null | "down" }) {
  if (server === null) return null;
  const lines: string[] = [];
  let tone: "danger" | "muted" = "muted";
  if (server === "down") {
    lines.push("Can't reach the server right now.");
    tone = "danger";
  } else {
    if (server.ownerMessage) lines.push(server.ownerMessage);
    if (server.health === "down" || server.online === false) tone = "danger";
    if (server.health && server.health !== "ok" && server.healthMessage) lines.push(server.healthMessage);
  }
  if (lines.length === 0) return null;
  return (
    <div className="mb-4">
      <Banner tone={tone}>{lines.join(" ")}</Banner>
    </div>
  );
}

function gameRootPath(exePath: string): string {
  return exePath
    .replace(/\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping\.exe$/i, "")
    .replace(/\\Binaries\\Win64\\Dauntless-Win64-Shipping\.exe$/i, "")
    .replace(/\\Dauntless-Win64-Shipping\.exe$/i, "");
}

type PlayPhase =
  | { status: "idle" }
  | { status: "locating" }
  | { status: "verifying" }
  | { status: "checkingStatus" }
  | { status: "updatingRuntime" }
  | { status: "queued"; position: number; length: number }
  | { status: "requestingSession" }
  | { status: "launching" }
  | { status: "running" }
  | { status: "error"; message: string };

// How often a waiting launcher asks again. The backend drops a place not asked about for 20 s.
const QUEUE_POLL_MS = 5000;

function gigabytes(bytes: number): string {
  return (bytes / 1073741824).toFixed(2);
}

function formatSpeed(bytesPerSecond: number): string {
  const mb = bytesPerSecond / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

function formatTimeLeft(seconds: number): string {
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} h left` : `about ${hours} h ${rest} min left`;
}

function phaseLabel(phase: PlayPhase): string | null {
  switch (phase.status) {
    case "verifying": return "Checking your game…";
    case "checkingStatus": return "Checking…";
    case "updatingRuntime": return "Updating…";
    case "locating": return "Choose your game folder…";
    case "queued": return `In line: ${phase.position} of ${phase.length}`;
    case "requestingSession": return "Connecting…";
    case "launching": return "Starting Dauntless…";
    default: return null;
  }
}

export function HomeTab() {
  const { account } = useAuth();
  const { policy, refreshPolicy } = usePolicy();
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [phase, setPhase] = useState<PlayPhase>({ status: "idle" });
  const [regionPingKey, setRegionPingKey] = useState(0);
  const [launcherVersion, setLauncherVersion] = useState<string>("");
  const [gameOffer, setGameOffer] = useState<GameManifest | null>(null);
  const [download, setDownload] = useState<GameDownloadProgress | null>(null);
  // Set when the server refused the saved game folder (not the Ramsgate Reborn game): the download is offered next to it.
  const [wrongFolder, setWrongFolder] = useState(false);
  const [drState, setDrState] = useState<DrClaimStatus | "checking" | "error" | null>(null);
  // Set only by the player pressing the Replace choice in this session; never remembered.
  const [drConfirming, setDrConfirming] = useState(false);
  // The one-time choice: asked once when this tab opens (and again only when the player presses "Check again").
  const [drChoice, setDrChoice] = useState<DrChoiceView | "loading">("loading");
  const drChoiceBlocks = drChoice === "loading" || (drChoice.kind === "screen" && drChoice.blocksPlay);
  // A failed check is re-checked twice, a few seconds apart. Only then does the player get "Retry" and "Start fresh"
  // with Play released, so a backend hiccup can never trap anyone for long.
  const [drGate, setDrGate] = useState(false);
  const loadDrChoice = useCallback(() => {
    setDrGate(false);
    const check = (): Promise<DrChoiceView> =>
      drChoiceStatus().then((reply) => viewFor(reply)).catch((): DrChoiceView => viewFor(null));
    const isFail = (v: DrChoiceView) => v.kind === "notice" && v.state === "dr_try_again_later";
    const wait = () => new Promise<void>((r) => setTimeout(r, 3000));
    check()
      .then(async (v) => { for (let i = 0; i < 2 && isFail(v) && mountedRef.current; i++) { await wait(); v = await check(); } return v; })
      .then((view) => { if (mountedRef.current) setDrChoice(isFail(view) ? exhaustedView() : view); });
  }, []);
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  const startFresh = useCallback(() => {
    setSkipping(true);
    setSkipError(null);
    drSkip()
      .then((reply) => { if (mountedRef.current) { setDrGate(false); setDrChoice(viewFor(reply)); } })
      .catch(() => { if (mountedRef.current) setSkipError(DR_TEXT.startFreshFailed); })
      .finally(() => { if (mountedRef.current) setSkipping(false); });
  }, []);
  useEffect(() => {
    if (account) loadDrChoice();
  }, [account, loadDrChoice]);
  const onDrChoiceAnswer = useCallback((answer: DrChoiceAnswer) => {
    const view = viewFor(answer);
    setDrChoice(view);
    if (view.state === "dr_already_transferred") void runDrClaimRef.current?.();
  }, []);
  const runDrClaimRef = useRef<(() => Promise<unknown>) | null>(null);
  const [gameVersion, setGameVersion] = useState<string>("");
  const [server, setServer] = useState<ServerStatusResponse | null | "down">(null);
  const mountedRef = useRef(true);
  const playLockRef = useRef(false);
  // Set by Leave queue (or leaving this tab); wakeQueueRef cuts the wait between polls short.
  const leaveQueueRef = useRef(false);
  const wakeQueueRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      leaveQueueRef.current = true;
      wakeQueueRef.current?.();
    };
  }, []);

  // While the hunt servers are near full, Play waits in the backend's queue. True when the game may
  // start, false when the player left the queue.
  const waitInQueue = useCallback(async (): Promise<boolean> => {
    leaveQueueRef.current = false;
    for (;;) {
      const answer = await queuePoll();
      if (leaveQueueRef.current) break;
      if (answer.kind === "go") return true;
      setPhase({ status: "queued", position: answer.position, length: answer.length });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, QUEUE_POLL_MS);
        wakeQueueRef.current = () => { clearTimeout(timer); resolve(); };
      });
      wakeQueueRef.current = null;
      if (leaveQueueRef.current) break;
    }
    await queueLeave();
    return false;
  }, []);

  const handleLeaveQueue = useCallback(() => {
    leaveQueueRef.current = true;
    wakeQueueRef.current?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      launcherApi.status().then(
        (status) => { if (!cancelled) setServer(status); },
        () => { if (!cancelled) setServer("down"); },
      );
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // RR-81: while the game is marked running, poll so the Play button comes back on its own when the game closes,
  // instead of waiting for "Check status" or a launcher restart. A failed check keeps the phase and is retried.
  const isRunningPhase = phase.status === "running";
  useEffect(() => {
    if (!isRunningPhase) return;
    let cancelled = false;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      stillRunning(launchedGameState, isGameRunning)
        .then(
          (running) => {
            if (cancelled || running || !mountedRef.current) return;
            getInstallStatus().then((fresh) => { if (mountedRef.current) setInstall(fresh); }, () => {});
            setPhase((p) => (p.status === "running" ? { status: "idle" } : p));
          },
          () => {},
        )
        .finally(() => { inFlight = false; });
    }, RUNNING_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isRunningPhase]);

  const refreshInstall = useCallback(async () => {
    setPhase({ status: "verifying" });
    try {
      const status = await getInstallStatus();
      // Coming back to this tab while the launched game is still open keeps it shown as running.
      const launched = await launchedGameState().catch(() => "none" as const);
      if (mountedRef.current) {
        setInstall(status);
        setPhase({ status: launched === "running" ? "running" : "idle" });
      }
    } catch {
      if (mountedRef.current) {
        setPhase({ status: "error", message: "We couldn't check your game files. Try again in a moment." });
      }
    }
  }, []);

  useEffect(() => {
    refreshInstall();
  }, [refreshInstall]);

  // The server decides whether a Dauntless Revived account is already moved, so nothing is remembered on disk. The
  // check runs when this tab opens and again right before Play. A second call within a minute reuses the answer, so
  // one launch never asks twice and the hourly limit is not used up.
  const drState_wait = useRef(false);
  // "fetching": the server is getting the save from Dauntless Revived. Ask again every few seconds (quietly, no button) until it
  // answers something else; "wait" is the hourly limit and is retried more slowly. Gives up after about 5 minutes.
  const drPollRef = useRef(false);
  const pollDrUntilReady = useCallback(async () => {
    if (drPollRef.current) return;
    drPollRef.current = true;
    try {
      for (let i = 0; i < 60 && mountedRef.current; i++) {
        await new Promise((r) => setTimeout(r, drState_wait.current ? 20_000 : 5_000));
        if (!mountedRef.current) return;
        const status = await drClaim().catch((): "error" => "error");
        drState_wait.current = status === "wait";
        if (status === "fetching" || status === "wait") continue;
        if (mountedRef.current) setDrState(status);
        return;
      }
      if (mountedRef.current) setDrState("error");
    } finally {
      drPollRef.current = false;
    }
  }, []);
  const drClaimRef = useRef<{ at: number; promise: Promise<DrClaimStatus | "error"> } | null>(null);
  // An account that has claimed its Dauntless Revived data never asks again: remembered here per account (only the fact "claimed").
  const drClaimedKey = account ? `rr.dr.claimed.${account.userId}` : null;
  const runDrClaim = useCallback((force = true) => {
    try {
      if (!force && drClaimedKey && localStorage.getItem(drClaimedKey) === "1") {
        if (mountedRef.current) setDrState("already");
        return Promise.resolve<DrClaimStatus | "error">("already");
      }
    } catch { /* storage unavailable: ask the server */ }
    const last = drClaimRef.current;
    if (!force && last && Date.now() - last.at < 60_000) return last.promise;
    setDrState("checking");
    setDrConfirming(false);
    const promise = drClaim()
      .then((status): DrClaimStatus | "error" => status)
      .catch((): "error" => "error")
      .then((status) => {
        if (mountedRef.current) setDrState(status);
        if ((status === "ported" || status === "already") && drClaimedKey) {
          try { localStorage.setItem(drClaimedKey, "1"); } catch { /* ignore */ }
        }
        if (status === "fetching" || status === "wait") {
          drState_wait.current = status === "wait";
          void pollDrUntilReady();
        }
        return status;
      });
    drClaimRef.current = { at: Date.now(), promise };
    return promise;
  }, [drClaimedKey]);

  // "Have a Dauntless Revived account key?": the player picks the key file or pastes the key. It stays in the launcher process
  // (memory only) and goes only to the claim request, together with any keys found on this PC.
  const [drKeyPaste, setDrKeyPaste] = useState<string | null>(null);
  const [drKeyNote, setDrKeyNote] = useState<string | null>(null);
  const chooseDrKeyFile = useCallback(async () => {
    setDrKeyNote(null);
    const result = await pickDrKeyFile().catch((): "invalid" => "invalid");
    if (result === "cancelled") return;
    if (result === "invalid") { setDrKeyNote("That file doesn't look like a Dauntless Revived account key."); return; }
    setDrKeyPaste(null);
    void runDrClaim();
  }, [runDrClaim]);
  const submitDrKey = useCallback(async () => {
    setDrKeyNote(null);
    const result = await setDrKey(drKeyPaste ?? "").catch((): "invalid" => "invalid");
    if (result !== "ok") { setDrKeyNote("That doesn't look like a Dauntless Revived account key."); return; }
    setDrKeyPaste(null);
    void runDrClaim();
  }, [drKeyPaste, runDrClaim]);
  const drKeyLink = (
    <div className="mt-2 text-[13px] text-text-muted">
      <p>
        Have a Dauntless Revived account key?{" "}
        <button onClick={() => void chooseDrKeyFile()} className="underline">Select it here</button>
        {drKeyPaste === null && (
          <>
            {" "}or <button onClick={() => setDrKeyPaste("")} className="underline">paste it</button>
          </>
        )}
      </p>
      {drKeyPaste !== null && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={drKeyPaste}
            onChange={(e) => setDrKeyPaste(e.target.value)}
            placeholder="Paste your key"
            className="w-[28ch] rounded border border-border bg-transparent px-2 py-1 text-[13px] text-text"
          />
          <button onClick={() => void submitDrKey()} className="underline">Use this key</button>
          <button onClick={() => setDrKeyPaste(null)} className="underline">Cancel</button>
        </div>
      )}
      {drKeyNote && <p className="mt-1 text-danger">{drKeyNote}</p>}
    </div>
  );

  const replaceWithDr = useCallback(() => {
    setDrState("checking");
    setDrConfirming(false);
    const promise = drClaim(true)
      .then((status): DrClaimStatus | "error" => status)
      .catch((): "error" => "error")
      .then((status) => {
        if (mountedRef.current) setDrState(status);
        if (status === "fetching" || status === "wait") {
          drState_wait.current = status === "wait";
          void pollDrUntilReady();
        }
        return status;
      });
    drClaimRef.current = { at: Date.now(), promise };
  }, []);

  runDrClaimRef.current = () => runDrClaim();
  // The claim waits for the choice: nothing is asked of the Dauntless Revived account while the choice is still open.
  useEffect(() => {
    if (drChoice === "loading" || drChoice.kind === "screen") return;
    void runDrClaim(false);
  }, [runDrClaim, drChoice]);

  // Installed client version: when the installed runtime matches the published one, that is its version.
  // Anything else (not installed, outdated, offline) just leaves it out.
  const installedOk = install?.located === true && !install.error;
  const channelName = policy?.channel ?? "stable";
  useEffect(() => {
    if (!installedOk) { setGameVersion(""); return; }
    checkRuntimeUpdate(channelName)
      .then((r) => { if (mountedRef.current) setGameVersion(!r.available && r.version ? r.version : ""); })
      .catch(() => { if (mountedRef.current) setGameVersion(""); });
  }, [installedOk, channelName]);

  useEffect(() => {
    getVersion().then((v) => { if (mountedRef.current) setLauncherVersion(v); }).catch(() => {});
  }, []);

  // Does the server offer the game files? Only worth showing while no installation is set.
  useEffect(() => {
    getGameManifest().then((offer) => { if (mountedRef.current) setGameOffer(offer); }).catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<GameDownloadProgress>("game-download-progress", (event) => {
      if (mountedRef.current) setDownload(event.payload);
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  const handleDownload = useCallback(async () => {
    setPhase({ status: "locating" });
    try {
      const finished = await downloadGame();
      if (!mountedRef.current) return;
      if (finished) setInstall(await getInstallStatus());
      setPhase({ status: "idle" });
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : undefined) || "The game download didn't finish. Check your connection and free disk space, then press Download game again. It picks up where it left off." });
      }
    } finally {
      if (mountedRef.current) setDownload(null);
    }
  }, []);

  // The saved folder was refused as not the Ramsgate Reborn game: forget it (no files are touched), then run the normal download.
  const handleDownloadInstead = useCallback(async () => {
    setPhase({ status: "locating" });
    try {
      const forgotten = await forgetWrongGameFolder();
      if (!mountedRef.current) return;
      if (!forgotten) {
        setPhase({ status: "error", message: OWN_DOWNLOAD_REFUSED_TEXT });
        return;
      }
      setWrongFolder(false);
      setInstall(await getInstallStatus());
    } catch {
      if (mountedRef.current) setPhase({ status: "error", message: "We couldn't clear the saved game folder. Try again in a moment." });
      return;
    }
    await handleDownload();
  }, [handleDownload]);

  const handleLocate = useCallback(async () => {
    setPhase({ status: "locating" });
    try {
      const status = await pickInstallPath();
      if (mountedRef.current) {
        setInstall(status);
        setPhase({ status: "idle" });
      }
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : undefined) || "We couldn't use that folder. Choose the folder that contains Archon." });
      }
    }
  }, []);

  const handleRepair = useCallback(async () => {
    if (!install || !install.located || !install.error || phase.status !== "idle" && phase.status !== "error") return;
    setPhase({ status: "updatingRuntime" });
    try {
      await installRuntimeUpdate(policy?.channel ?? "stable");
      const refreshed = await getInstallStatus();
      if (mountedRef.current) {
        setInstall(refreshed);
        setPhase({ status: "idle" });
      }
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : undefined) || "We couldn't fix your game files. Try Repair again, or download the game into a new empty folder." });
      }
    }
  }, [install, phase.status, policy]);

  const handlePlay = useCallback(async () => {
    if (!install || !account || playLockRef.current || phase.status !== "idle" || drChoiceBlocks) return;
    playLockRef.current = true;
    setLaunching(true);
    // To the taskbar as soon as Play is pressed; restored below if the launch fails.
    let launched = false;
    void setLauncherMinimized(true).catch(() => {});

    try {
      // Ask the server about the Dauntless Revived account first. The answer never stops the launch: a claim that
      // was accepted is applied when the game creates the character.
      await runDrClaim(false);

      // Flags/channel are re-synced from the account's policy immediately before launch —
      // the runtime caches several of them for the process lifetime, so this has to happen
      // before spawn, not just periodically in the background.
      const freshPolicy = await refreshPolicy();
      const channel = freshPolicy?.channel ?? "stable";

      // Project-owned runtime updates happen before the native launch boundary.
      // Rust then re-hashes the executable, rotates the secure session, requests
      // the one-time ticket, and spawns without exposing credentials to JS.
      setPhase({ status: "verifying" });
      let verified = await getInstallStatus();
      if (!verified.located) {
        setInstall(verified);
        setPhase({ status: "error", message: "We can't find Dauntless where it was before. Choose the folder it's in now, or download it again." });
        return;
      }
      if (verified.error) {
        setPhase({ status: "updatingRuntime" });
        await installRuntimeUpdate(channel);
        verified = await getInstallStatus();
      }
      if (!verified.located || verified.error || !verified.exeSha256) {
        setInstall(verified);
        setPhase({ status: "error", message: verified.error ?? "We couldn't check your game files. Try Play again in a moment." });
        return;
      }
      setInstall(verified);

      const runtime = await checkRuntimeUpdate(channel);
      if (runtime.available) {
        setPhase({ status: "updatingRuntime" });
        await installRuntimeUpdate(channel);
        const refreshed = await getInstallStatus();
        if (!refreshed.located || refreshed.error) {
          setInstall(refreshed);
          setPhase({ status: "error", message: refreshed.error ?? "The game update didn't finish. Check your connection and press Play again." });
          return;
        }
        setInstall(refreshed);
      }

      if (!(await waitInQueue())) {
        if (mountedRef.current) setPhase({ status: "idle" });
        return;
      }

      setPhase({ status: "requestingSession" });
      setRegionPingKey((key) => key + 1);
      await secureLaunch(channel);
      launched = true;
      if (mountedRef.current) setPhase({ status: "running" });
    } catch (err) {
      if (mountedRef.current) {
        const text = sanitizeError(typeof err === "string" ? err : err instanceof Error ? err.message : undefined);
        if (isWrongFolderMessage(text)) setWrongFolder(true);
        if (isDrGateMessage(text)) { setDrGate(true); setPhase({ status: "idle" }); return; }
        announceIfLauncherOutdated(text);
        setPhase({ status: "error", message: text || "Dauntless didn't start. Make sure it isn't already open and that your antivirus hasn't removed any game files, then press Play again." });
      }
    } finally {
      if (!launched) void setLauncherMinimized(false).catch(() => {});
      playLockRef.current = false;
      setLaunching(false);
    }
  }, [install, account, phase.status, refreshPolicy, waitInQueue, drChoiceBlocks, runDrClaim]);

  const progressLabel = phaseLabel(phase);
  const isTester = policy?.roles.includes("tester") ?? false;
  const buildLabel = isTester ? "Tester build" : "";

  const located = install?.located === true;
  const hasError = install?.error != null;

  // Play stays off while a Dauntless Revived transfer is queued, being fetched or not ready, and while that check
  // has not succeeded: entering the game early can lock out the transfer. It comes back when the copy is ready, the
  // player chose Start fresh, or the account has no Dauntless Revived link at all (never blocked).
  const playHold = playHoldFor(drChoice, drState, drGate);
  const gameState: GameState = download !== null ? "downloading" : !located ? "missing" : wrongFolder ? "wrong_folder" : hasError ? "needs_repair" : "ready";
  const primary = homePrimary({ game: gameState, choice: drChoice, claimState: drState, gate: drGate });
  const canPlay = located && !hasError && install?.exeSha256 != null && phase.status === "idle" && !drChoiceBlocks && playHold === null;
  const canLocate = phase.status === "idle" || phase.status === "error";
  const gameRunning = phase.status === "running";
  const canRepair = located && hasError && !gameRunning && (phase.status === "idle" || phase.status === "error");
  const busy = phase.status !== "idle" && phase.status !== "error" && phase.status !== "running" && phase.status !== "checkingStatus";

  const pill =
    "flex h-11 shrink-0 items-center justify-center gap-2 rounded-full px-6 text-[14px] font-semibold transition-[background-color,filter] disabled:cursor-not-allowed disabled:opacity-40";
  const ghost = `${pill} bg-white/10 text-text ring-1 ring-white/15 hover:bg-white/16`;
  const solid = `${pill} bg-accent text-on-ink hover:bg-accent-hover`;

  const serverOnline = server !== null && server !== "down" && server.online;
  const queued = phase.status === "queued" ? phase : null;
  const heroTitle = gameRunning
    ? "In the hunt"
    : queued
    ? "You're in line"
    : canPlay
    ? "Ready to hunt"
    : busy && located && !hasError
    ? "Getting ready"
    : located
    ? "Needs a check"
    : install?.savedMissing
    ? "We can't find your game"
    : "Let's find your game";
  const percent = download && download.total > 0 ? Math.min(100, (download.received / download.total) * 100) : 0;

  return (
    <div className="relative flex min-h-full flex-col justify-between gap-8 px-12 pb-4 pt-6">
      {drChoice !== "loading" && drChoice.kind === "screen" && <DrChoiceScreen onAnswer={onDrChoiceAnswer} />}
      <section className="max-w-[520px]">
        <StatusBanner server={server} />
        <div className="mb-4"><ModeSwitch /></div>
        <p className="text-[13px] text-text-muted">Welcome, {account?.displayName ?? "Slayer"}</p>
        <h1 className="display mt-1 text-[56px] leading-[1.02] text-text">{heroTitle}</h1>
        <p className="mt-3 max-w-[44ch] text-[14px] leading-relaxed text-text-muted">
          {gameRunning
            ? "Dauntless is open. Alt-tab back in."
            : queued
            ? "Hang tight. Keep the launcher open."
            : located && hasError
            ? sanitizeError(install?.error)
            : located
            ? "Everything checks out. See you in Ramsgate."
            : install?.savedMissing
            ? "Dauntless isn't where it was before. It may have been moved or deleted. Choose the folder it's in now."
            : "Ramsgate Reborn needs the Dauntless game files in the right version. Download them here, or choose the Ramsgate Reborn game folder if you already have it. It's the one that contains Archon."}
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-5">
          {(canPlay || (located && playHold !== null) || queued || phase.status === "requestingSession" || phase.status === "launching" || (busy && located && !hasError && !download)) && !gameRunning && (
            // The Play sigil: a round button that breathes while ready, spins while working, and shows the queue place.
            <button
              onClick={handlePlay}
              disabled={!canPlay}
              aria-label={queued ? `In queue, ${queued.position} of ${queued.length}` : "Play"}
              className={`relative grid h-[124px] w-[124px] shrink-0 place-items-center rounded-full bg-accent text-on-ink transition-[filter,transform] duration-200 enabled:hover:scale-[1.03] enabled:hover:brightness-110 disabled:cursor-default ${
                canPlay ? "sigil-idle" : ""
              }`}
            >
              <span aria-hidden className="absolute inset-[-7px] rounded-full ring-1 ring-glow/40" />
              {!canPlay && playHold === null && (
                <span
                  aria-hidden
                  className="sigil-spin absolute inset-[-7px] rounded-full border-2 border-transparent border-t-glow border-r-glow/40"
                />
              )}
              {queued ? (
                <span className="flex flex-col items-center leading-none">
                  <span className="display text-[34px] tabular-nums">{queued.position}</span>
                  <span className="mt-1 text-[11px] font-medium text-on-ink/80">of {queued.length}</span>
                </span>
              ) : canPlay ? (
                <span className="flex flex-col items-center gap-1.5">
                  <PlayIcon className="h-7 w-7" />
                  <span className="text-[13px] font-semibold tracking-wide">Play</span>
                </span>
              ) : playHold !== null ? (
                <span className="px-3 text-center text-[12px] font-semibold leading-tight text-on-ink/90">{DR_PLAY_HOLD_LABEL[playHold]}</span>
              ) : (
                <span className="text-[12px] font-medium text-on-ink/85">Starting…</span>
              )}
            </button>
          )}

          <div className="flex min-w-0 flex-col gap-3">
            {queued && (
              <>
                <p className="max-w-[34ch] text-[14px] leading-relaxed text-text">
                  Servers are busy. You're <span className="font-semibold text-glow">{queued.position} of {queued.length}</span> in line, and the
                  game opens on its own when it's your turn.
                </p>
                {/* Stays clickable while Play is busy waiting. */}
                <button onClick={handleLeaveQueue} className={`${ghost} w-fit`}>
                  Leave queue
                </button>
              </>
            )}

            {located && <RegionReporter pingKey={regionPingKey} />}

            {located && wrongFolder && canLocate && !gameRunning && download === null && (
              <div className="flex flex-wrap gap-3">
                <button onClick={handleDownloadInstead} disabled={busy} className={solid}>{WRONG_FOLDER_BUTTON}</button>
              </div>
            )}

            {canRepair && !gameRunning && (
              <button onClick={handleRepair} disabled={busy} className={solid}>
                {busy ? "Repairing…" : "Repair"}
              </button>
            )}

            {!located && canLocate && !gameRunning && download === null && (
              <div className="flex flex-wrap gap-3">
                {gameOffer && (
                  <button onClick={handleDownload} disabled={busy} className={solid}>
                    {downloadButtonLabel(gameOffer)}
                  </button>
                )}
                <button onClick={handleLocate} disabled={busy} className={gameOffer ? ghost : solid}>
                  {install?.savedMissing ? "Choose folder" : gameOffer ? "I already have it" : "Locate game"}
                </button>
              </div>
            )}

            {!located && canLocate && !gameRunning && download === null && gameOffer && downloadNeedsLine(gameOffer) && (
              <p className="max-w-[44ch] text-[12px] leading-relaxed text-text-faint">{downloadNeedsLine(gameOffer)}</p>
            )}

            {(gameRunning || phase.status === "checkingStatus") && (
              <button
                onClick={async () => {
                  setPhase({ status: "checkingStatus" });
                  try {
                    const running = await stillRunning(launchedGameState, isGameRunning);
                    if (!mountedRef.current) return;
                    if (running) {
                      setPhase({ status: "running" });
                    } else {
                      const fresh = await getInstallStatus();
                      if (mountedRef.current) setInstall(fresh);
                      await new Promise((r) => setTimeout(r, 2000));
                      if (mountedRef.current) setPhase({ status: "idle" });
                    }
                  } catch {
                    if (mountedRef.current) setPhase({ status: "idle" });
                  }
                }}
                disabled={busy}
                className={`${ghost} w-fit`}
              >
                {busy ? "Checking…" : "Check status"}
              </button>
            )}

            {primary === "dr_gate" && (
              <div className="max-w-[44ch] text-[13px] text-text-muted">
                <p className="text-text">{DR_GATE_TEXT}</p>
                <div className="mt-2 flex flex-wrap items-start gap-4">
                  <button onClick={() => { setDrChoice("loading"); loadDrChoice(); }} className="underline">{DR_TEXT.tryAgainButton}</button>
                  <StartFreshButton onConfirm={startFresh} busy={skipping} error={skipError} />
                </div>
              </div>
            )}
            {drChoice !== "loading" && primary === "dr_queue" && typeof drChoice !== "string" && drChoice.kind === "notice" && (
              // The line panel sits beside the headline (over the artwork), not under it, so it is in view without scrolling.
              <div className="absolute right-12 top-3 z-10 w-[320px] rounded-2xl bg-black/70 backdrop-blur-sm">
                <DrQueuePanel
                  notCopiedText={drChoice.text}
                  onReady={() => { setDrChoice("loading"); loadDrChoice(); }}
                  onAnswer={onDrChoiceAnswer}
                />
              </div>
            )}
            {drChoice !== "loading" && primary === "dr_notice" && typeof drChoice !== "string" && drChoice.kind === "notice" && (
              <div className="max-w-[44ch] text-[13px] text-text-muted">
                <p>{drChoice.text}</p>
                {drChoice.state === "dr_has_progress" && !drChoice.exhausted && <DrReclaimButton onStarted={() => { setDrChoice("loading"); loadDrChoice(); }} />}
                {drChoice.retry && (
                  <button onClick={() => { setDrChoice("loading"); loadDrChoice(); }} className="mt-1 underline">{DR_TEXT.tryAgainButton}</button>
                )}
                {drChoice.exhausted && (
                  <>
                    <span className="ml-4 mt-1 inline-block align-top"><StartFreshButton onConfirm={startFresh} busy={skipping} error={skipError} /></span>
                  </>
                )}
              </div>
            )}
            {primary === "dr_claim" && showClaimNotice(drChoice) && (drState === "not_copied_yet" || drState === "transfers_ended" || drState === "try_later" || drState === "declined") && (() => {
              const v = viewForClaimCode(drState);
              return v && v.kind === "notice" ? (
                <div className="max-w-[44ch] text-[13px] text-text-muted">
                  <p>{v.text}</p>
                  {v.retry && <button onClick={() => void runDrClaim()} className="mt-1 underline">{DR_TEXT.tryAgainButton}</button>}
                </div>
              ) : null;
            })()}
            {primary === "dr_claim" && drState === "ported" && (
              <p className="text-[13px] text-text">Your progress is ready. Fully close the game if it is open, then press Play so it is applied.</p>
            )}
            {primary === "dr_claim_fetching" && (
              <p className="animate-pulse text-[13px] text-text-muted [animation-duration:1.5s]">Fetching your Dauntless Revived save…</p>
            )}
            {primary === "dr_claim" && drState === "not_found" && (
              <div className="max-w-[44ch] text-[13px] text-text-muted">
                <p>No Dauntless Revived account found for the keys on this PC. Check your key file in Documents\Dauntless Revived\Account Keys, or start fresh.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={() => void runDrClaim()} className="underline">Check again</button>
                  <button onClick={() => setDrState(null)} className="underline">Start fresh</button>
                </div>
                {drKeyLink}
              </div>
            )}
            {primary === "dr_claim" && (drState === "no_match" || drState === "no_key") && (
              <div className="max-w-[44ch] text-[13px] text-text-muted">
                <p>
                  We couldn't find your Dauntless Revived account. Open the Dauntless Revived Discord bot, run /key link, then{" "}
                  <button onClick={() => void runDrClaim()} className="underline">retry</button>.
                </p>
                {drKeyLink}
              </div>
            )}
            {primary === "dr_claim" && drState === "has_progress" && !drConfirming && (
              <div className="max-w-[44ch] text-[13px] text-text-muted">
                <p>This Ramsgate Reborn account already has progress. Which would you like to keep?</p>
                <DrReclaimButton onStarted={() => void runDrClaim()} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={() => setDrState(null)} className="underline">Keep my Ramsgate Reborn progress</button>
                  <button onClick={() => setDrConfirming(true)} className="underline">Replace it with my Dauntless Revived progress</button>
                </div>
              </div>
            )}
            {primary === "dr_claim" && drState === "has_progress" && drConfirming && (
              <div className="max-w-[44ch] text-[13px] text-text-muted">
                <p>Your current Ramsgate Reborn progress will be removed from this account. Staff keep a backup, but you can't undo this yourself. Replace it?</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={replaceWithDr} className="underline">Yes, replace it</button>
                  <button onClick={() => setDrConfirming(false)} className="underline">Go back</button>
                </div>
              </div>
            )}
            {primary === "dr_claim" && drState === "in_game" && (
              <p className="text-[13px] text-text-muted">
                Your account is online in the game. Close the game first and <button onClick={() => void runDrClaim()} className="underline">try again</button>.
              </p>
            )}
            {primary === "dr_claim" && drState === "not_ready" && (
              <p className="text-[13px] text-text-muted">Moving Dauntless Revived progress isn't open yet. Check back soon.</p>
            )}
            {primary === "dr_claim" && drState === "error" && (
              <p className="text-[13px] text-text-muted">
                Couldn't check your Dauntless Revived account right now. <button onClick={() => void runDrClaim()} className="underline">Retry</button>
              </p>
            )}
            {progressLabel && !queued && <p className="animate-pulse text-[13px] text-text-muted [animation-duration:1.5s]">{progressLabel}</p>}
            {phase.status === "error" && <p className="max-w-[38ch] text-[13px] text-danger">{phase.message} <SupportLink /></p>}
          </div>
        </div>

        {download !== null && (
          <div className="glass mt-6 max-w-[480px] rounded-2xl p-5">
            {download.phase === "downloading" ? (
              <>
                <div className="flex items-end justify-between gap-4">
                  <p className="display text-[36px] leading-none tabular-nums text-text">
                    {Math.floor(percent)}
                    <span className="text-[20px] text-text-muted">%</span>
                  </p>
                  <p className="pb-1 text-[13px] font-medium tabular-nums text-text">
                    {gigabytes(download.received)} <span className="text-text-muted">of</span> {gigabytes(download.total)} GB
                  </p>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-glow transition-[width] duration-300" style={{ width: `${percent}%` }} />
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] font-medium tabular-nums text-text">
                  <span>{download.bytesPerSecond ? formatSpeed(download.bytesPerSecond) : "Starting…"}</span>
                  {download.bytesPerSecond && download.secondsLeft != null && (
                    <span className="text-text-muted">{formatTimeLeft(download.secondsLeft)}</span>
                  )}
                </div>
                <p className="mt-3 truncate text-[12px] text-text-faint" title={download.folder}>
                  Installing to {download.folder}
                </p>
                <p className="mt-0.5 text-[12px] text-text-faint">Fine to close the launcher. It picks up where it left off.</p>
              </>
            ) : (
              <>
                <div className="flex items-end justify-between gap-4">
                  <p className="display text-[24px] leading-none text-text">
                    {download.phase === "verifying" ? "Checking the download" : download.phase === "unpacking" ? "Unpacking the game" : "Done"}
                  </p>
                  {download.phase === "unpacking" && download.total > 0 && (
                    <p className="pb-0.5 text-[20px] font-semibold tabular-nums text-text">{Math.floor(percent)}%</p>
                  )}
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                  {download.phase === "unpacking" && download.total > 0 ? (
                    <div className="h-full rounded-full bg-glow transition-[width] duration-300" style={{ width: `${percent}%` }} />
                  ) : (
                    <div className="h-full w-full animate-pulse rounded-full bg-glow" />
                  )}
                </div>
                {download.phase === "unpacking" && (
                  <p className="mt-3 truncate text-[12px] text-text-faint" title={download.folder}>
                    Into {download.folder}. Takes a few minutes. Fine to close the launcher.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {/* Status chips along the bottom-left, above the dock. */}
      <section className="flex flex-wrap justify-center gap-3">
        <StatusChip
          label="Server"
          tone={server === null ? "wait" : serverOnline ? "ok" : "bad"}
          value={server === null ? "Checking…" : serverOnline ? `${server.playersOnline ?? "–"} online` : "Unreachable"}
          detail={
            serverOnline
              ? server.instances
                ? `Ramsgate ${server.instances.ramsgate > 0 ? "up" : "down"} · Hunts ${server.instances.hunts}/${server.instances.maxHunts}`
                : "No server details"
              : server === null
              ? "One moment"
              : "Can't reach it right now"
          }
        />
        <StatusChip
          label="Game folder"
          tone={located && !hasError ? "ok" : "bad"}
          value={located ? (hasError ? "Needs repair" : "Verified") : "Not set"}
          detail={located && install?.exePath ? gameRootPath(install.exePath) : "Not picked yet"}
          mono={located && !!install?.exePath}
        />
        <StatusChip
          label="Runtime"
          tone={located && !hasError ? "ok" : "wait"}
          value={located && !hasError ? "Ready" : "Needs setup"}
          detail={`${gameVersion ? `Game ${gameVersion} · ` : ""}${launcherVersion ? `Launcher v${launcherVersion}` : ""}${buildLabel ? `${launcherVersion ? " · " : ""}${buildLabel}` : ""}`}
        />
      </section>
    </div>
  );
}

function StatusChip({ label, value, detail, tone, mono = false }: { label: string; value: string; detail: string; tone: "ok" | "bad" | "wait"; mono?: boolean }) {
  const dot = tone === "ok" ? "bg-online shadow-[0_0_8px] shadow-online" : tone === "bad" ? "bg-danger" : "bg-text-faint";
  return (
    <article className="glass w-[220px] min-w-0 rounded-2xl px-4 py-3 text-center">
      <p className="flex items-center justify-center gap-2 text-[11px] text-text-faint">
        {label}
        <span className={`h-2 w-2 rounded-full ${dot}`} />
      </p>
      <p className="mt-1 text-[15px] font-semibold text-text">{value}</p>
      <p className={`mt-0.5 truncate text-[11px] text-text-muted ${mono ? "font-mono" : ""}`} title={detail}>
        {detail}
      </p>
    </article>
  );
}
