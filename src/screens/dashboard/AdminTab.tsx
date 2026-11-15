import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Banner } from "../../components/Banner";
import { GrantItems } from "./GrantItems";
import { AuditLog, OnlinePlayers } from "./AdminLogs";
import {
  getCrashText,
  getServerStatus,
  listAccounts,
  listCrashes,
  runServerAction,
  setApproval,
  type AdminAccount,
  type ApprovalStatus,
  type CrashReport,
  type ServerAction,
  type ServerStatus,
} from "../../api/admin";

const FILTERS: { id: ApprovalStatus; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
];

const ACTIONS: { id: ServerAction; label: string; detail: string }[] = [
  { id: "restart-game-servers", label: "Restart game servers", detail: "Ends every running hunt and Ramsgate session." },
  { id: "restart-all", label: "Restart everything", detail: "Restarts the backend, director and game servers. Everyone is disconnected." },
  { id: "apply-update", label: "Apply staged update", detail: "Installs the uploaded build, then restarts everything." },
];

function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong.";
}

function ago(iso: string | undefined): string {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function uptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  return hours >= 1 ? `${hours} h ${Math.floor((seconds % 3600) / 60)} min` : `${Math.floor(seconds / 60)} min`;
}

function SignUps() {
  const [filter, setFilter] = useState<ApprovalStatus>("pending");
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await listAccounts(filter));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [filter]);

  useEffect(() => {
    setAccounts(null);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function decide(account: AdminAccount, approval: ApprovalStatus) {
    setBusyId(account.userId);
    try {
      await setApproval(account.userId, approval);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="glass rounded-2xl p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-text">Sign-up requests</h2>
          <p className="mt-0.5 text-xs text-text-muted">Players sign in with Discord, then wait here until you approve them.</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-surface-raised p-1" role="tablist">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                filter === id ? "bg-accent-muted text-text" : "text-text-muted hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="mt-4"><Banner>{error}</Banner></div>}

      <div className="mt-4 divide-y divide-border">
        {accounts === null && !error && <p className="py-6 text-center text-[13px] text-text-muted">Loading…</p>}
        {accounts?.length === 0 && (
          <p className="py-6 text-center text-[13px] text-text-muted">No {filter} accounts.</p>
        )}
        {accounts?.map((account) => (
          <div key={account.userId} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-text">
                {account.discordUsername || "Unknown Discord user"}
                {account.roles.includes("admin") && (
                  <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Admin</span>
                )}
              </p>
              <p className="truncate text-[11px] text-text-faint">
                {account.usernameSet ? `In-game: ${account.displayName} · ` : ""}Requested {ago(account.createdAt)} · last seen {ago(account.lastLoginAt)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {account.approvalStatus !== "approved" && (
                <Button size="sm" loading={busyId === account.userId} onClick={() => void decide(account, "approved")}>
                  Approve
                </Button>
              )}
              {account.approvalStatus !== "rejected" && !account.roles.includes("admin") && (
                <Button variant="secondary" size="sm" disabled={busyId === account.userId} onClick={() => void decide(account, "rejected")}>
                  {account.approvalStatus === "approved" ? "Revoke" : "Reject"}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Light({ on, label, value, neutral = false }: { on: boolean; label: string; value?: string; neutral?: boolean }) {
  return (
    <div className="glass rounded-2xl-raised px-3.5 py-3">
      <p className="text-[11px] uppercase tracking-wider text-text-faint">{label}</p>
      <p className="mt-1 flex items-center gap-2 text-[13px] font-medium text-text">
        <span className={`h-1.5 w-1.5 rounded-full ${neutral ? "bg-text-faint" : on ? "bg-online" : "bg-danger"}`} />
        {value ?? (on ? "Running" : "Down")}
      </p>
    </div>
  );
}

function ServerControl() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ServerAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getServerStatus());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function run(action: ServerAction) {
    setConfirming(null);
    setNotice(null);
    try {
      await runServerAction(action);
      setNotice("Started. The server can be unreachable for up to a minute while it restarts.");
      setTimeout(() => void load(), 20_000);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section className="glass rounded-2xl p-6">
      <h2 className="text-[15px] font-semibold text-text">Server</h2>
      <p className="mt-0.5 text-xs text-text-muted">Live state of the test stack, and the commands that are safe to run from here.</p>

      {error && <div className="mt-4"><Banner>{error}</Banner></div>}
      {notice && <div className="mt-4"><Banner tone="muted">{notice}</Banner></div>}

      {status && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Light on={status.ramsgate > 0} label="Ramsgate" />
            <Light on={status.trainingDojo > 0} label="Training dojo" />
            <Light on={status.hunts <= status.maxHunts} label="Hunts" value={`${status.hunts} of ${status.maxHunts}`} />
            <Light on label="Players online" value={String(status.onlinePlayers)} />
            <Light on={status.director} label="Director" />
            <Light on={status.mongo} label="Database" />
            <Light on label="Backend" value={`Up ${uptime(status.backend?.uptimeSeconds ?? 0)}`} />
            <Light on={status.stagedUpdate} neutral={!status.stagedUpdate} label="Staged update" value={status.stagedUpdate ? "Ready" : "None"} />
          </div>
          {status.lastAction && (
            <p className="mt-3 text-[11px] text-text-faint">
              Last action: {status.lastAction.message} ({ago(status.lastAction.at)})
            </p>
          )}
        </>
      )}

      <div className="mt-5 flex flex-col gap-2 border-t border-border pt-5">
        {ACTIONS.map(({ id, label, detail }) => (
          <div key={id} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-text">{label}</p>
              <p className="text-[11px] text-text-faint">{detail}</p>
            </div>
            {confirming === id ? (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => void run(id)}>Confirm</Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm" className="shrink-0"
                disabled={!status || (id === "apply-update" && !status.stagedUpdate)}
                onClick={() => setConfirming(id)}
              >
                {label.split(" ")[0]}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Crashes() {
  const [reports, setReports] = useState<CrashReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ title: string; text: string } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReports(await listCrashes());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function view(report: CrashReport, key: string, name?: string) {
    setLoadingKey(key);
    try {
      const text = await getCrashText(report, name);
      setOpen({ title: report.kind === "server" ? `${report.label} server crash` : `${report.displayName || "Player"} · ${name ?? "launcher.log"}`, text });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoadingKey(null);
    }
  }

  return (
    <section className="glass rounded-2xl p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-text">Crash reports and game logs</h2>
          <p className="mt-0.5 text-xs text-text-muted">Game logs are sent after every play session; server crashes are recorded automatically.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>Refresh</Button>
      </div>

      {error && <div className="mt-4"><Banner>{error}</Banner></div>}

      <div className="mt-4 divide-y divide-border">
        {reports === null && !error && <p className="py-6 text-center text-[13px] text-text-muted">Loading…</p>}
        {reports?.length === 0 && <p className="py-6 text-center text-[13px] text-text-muted">No crashes reported. Good.</p>}
        {reports?.map((report) => {
          const key = report.kind === "server" ? `s-${report.id}` : `c-${report.userId}-${report.sessionId}`;
          return (
            <div key={key} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-text">
                  {report.kind === "server"
                    ? `Game server crash · ${report.label}${report.port ? ` (port ${report.port})` : ""}`
                    : `Player log · ${report.displayName || "unknown player"}`}
                </p>
                <p className="truncate text-[11px] text-text-faint">
                  {ago(report.receivedAt)} · exit code {report.exitCode ?? "unknown"}
                  {report.kind === "server" && report.uptimeSeconds != null ? ` · ran ${Math.round(report.uptimeSeconds / 60)} min` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {report.kind === "server" ? (
                  <Button variant="secondary" size="sm" loading={loadingKey === key} onClick={() => void view(report, key)}>View log</Button>
                ) : (
                  report.files?.filter((f) => f.endsWith(".log")).slice(0, 3).map((f) => (
                    <Button key={f} variant="secondary" size="sm" loading={loadingKey === `${key}-${f}`} onClick={() => void view(report, `${key}-${f}`, f)}>
                      {f.startsWith("runtime-") ? "Runtime log" : "Launcher log"}
                    </Button>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {open && (
        <div className="mt-4 border border-border-strong bg-surface-raised">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <p className="truncate text-[12px] font-semibold text-text">{open.title}</p>
            <button className="text-[12px] font-semibold text-text-muted hover:text-text" onClick={() => setOpen(null)}>Close</button>
          </div>
          <pre className="max-h-72 select-text overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-relaxed text-text-muted">{open.text || "(empty)"}</pre>
        </div>
      )}
    </section>
  );
}

export default function AdminTab() {
  return (
    <div className="max-w-4xl px-12 pb-6 pt-4">
      <h1 className="display text-[30px] leading-none text-text">Admin</h1>
      <p className="mt-1 text-[13px] text-text-muted">Approve new players and run the server.</p>
      <div className="mt-7 flex flex-col gap-6">
        <OnlinePlayers />
        <SignUps />
        <GrantItems />
        <ServerControl />
        <Crashes />
        <AuditLog />
      </div>
    </div>
  );
}
