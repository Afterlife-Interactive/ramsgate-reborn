import { invoke } from "@tauri-apps/api/core";

// Admin launcher build only. Calls go through the native side, which uses the signed-in session; the server
// still requires the admin role on that account for every one of these routes.

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ServerAction = "restart-game-servers" | "restart-all" | "apply-update";

export interface AdminAccount {
  userId: string;
  displayName: string;
  discordUsername: string;
  discordId: string;
  approvalStatus: ApprovalStatus;
  status: "active" | "disabled" | "banned";
  roles: string[];
  usernameSet: boolean;
  createdAt: string;
  lastLoginAt?: string;
  approvalUpdatedAt?: string;
}

export interface ServerStatus {
  ramsgate: number;
  trainingDojo: number;
  hunts: number;
  maxHunts: number;
  director: boolean;
  backendProcess: boolean;
  mongo: boolean;
  stagedUpdate: boolean;
  lastAction: { action: string; requester: string; at: string; ok: boolean; message: string } | null;
  backend: { pid: number; uptimeSeconds: number };
  onlinePlayers: number;
  observedAt: string;
}

function adminRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  return invoke<T>("native_admin_request", { method, path, body: body ?? null });
}

export async function listAccounts(approvalStatus?: ApprovalStatus): Promise<AdminAccount[]> {
  const query = approvalStatus ? `?approvalStatus=${approvalStatus}&limit=100` : "?limit=100";
  const result = await adminRequest<{ accounts: AdminAccount[] }>("GET", `/launcher/v1/admin/players${query}`);
  return result.accounts;
}

export function setApproval(userId: string, approvalStatus: ApprovalStatus): Promise<unknown> {
  return adminRequest("POST", `/launcher/v1/admin/players/${encodeURIComponent(userId)}/access`, { approvalStatus });
}

export function getServerStatus(): Promise<ServerStatus> {
  return adminRequest<ServerStatus>("GET", "/launcher/v1/admin/server/status");
}

export function runServerAction(action: ServerAction): Promise<unknown> {
  return adminRequest("POST", `/launcher/v1/admin/server/${action}`);
}

export interface CrashReport {
  kind: "client" | "server";
  receivedAt: string;
  // client reports
  userId?: string;
  sessionId?: string;
  displayName?: string;
  startedAt?: string;
  exitCode?: number | null;
  files?: string[];
  // server crashes
  id?: string;
  label?: string;
  port?: number | null;
  signal?: string | null;
  uptimeSeconds?: number | null;
}

export async function listCrashes(): Promise<CrashReport[]> {
  const result = await adminRequest<{ reports: CrashReport[] }>("GET", "/launcher/v1/admin/crashes");
  return result.reports;
}

export async function getCrashText(report: CrashReport, name?: string): Promise<string> {
  const query =
    report.kind === "server"
      ? `kind=server&id=${encodeURIComponent(report.id ?? "")}`
      : `kind=client&userId=${encodeURIComponent(report.userId ?? "")}&sessionId=${encodeURIComponent(report.sessionId ?? "")}&name=${encodeURIComponent(name ?? "launcher.log")}`;
  const result = await adminRequest<{ text: string }>("GET", `/launcher/v1/admin/crashes/file?${query}`);
  return result.text;
}
