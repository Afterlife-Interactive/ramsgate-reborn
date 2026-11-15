import { invoke } from "@tauri-apps/api/core";
import type { AdminAccount } from "./admin";

// Admin launcher build only. Same native bridge as api/admin.ts; the server checks the admin role on every route.

export type CatalogTab = "all" | "weapons" | "armour" | "lanterns" | "parts" | "cells" | "cosmetics" | "materials" | "currency" | "other";

export interface CatalogItem {
  id: string;
  name: string;
  tab: CatalogTab;
}

export interface GrantEntry {
  catalogId: string;
  quantity: number;
}

export interface OwnedItem {
  catalogId: string;
  name: string;
  tab: string;
  quantity: number;
}

export interface TrackInfo {
  progressionId: string;
  progress: number;
  max: number;
}

export interface AuditRecord {
  id: string;
  actorUserId: string;
  actorName: string;
  targetName: string;
  targetUserId?: string;
  action: string;
  newState?: unknown;
  reason?: string;
  createdAt: string;
}

function adminRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  return invoke<T>("native_admin_request", { method, path, body: body ?? null });
}

const player = (userId: string) => `/launcher/v1/admin/players/${encodeURIComponent(userId)}`;

export async function searchPlayers(search: string): Promise<AdminAccount[]> {
  const result = await adminRequest<{ accounts: AdminAccount[] }>(
    "GET",
    `/launcher/v1/admin/players?limit=20&search=${encodeURIComponent(search)}`,
  );
  return result.accounts;
}

export function searchCatalog(tab: CatalogTab, search: string): Promise<{ items: CatalogItem[]; counts: Record<string, number> }> {
  return adminRequest("GET", `/launcher/v1/admin/catalog?tab=${tab}&search=${encodeURIComponent(search)}`);
}

export function grantToPlayer(userId: string, grants: GrantEntry[], reason?: string): Promise<{ granted: number; liveRefreshRequested: boolean }> {
  return adminRequest("POST", `${player(userId)}/grant`, { grants, reason });
}

export function grantPreset(userId: string, preset: "gear" | "cells" | "materials"): Promise<{ granted: number }> {
  return adminRequest("POST", `${player(userId)}/preset`, { preset });
}

export function maxPlayer(userId: string, force = false): Promise<{ ok: boolean }> {
  return adminRequest("POST", `${player(userId)}/max`, { force });
}

export function getInventory(userId: string): Promise<{ items: OwnedItem[]; currencies: OwnedItem[] }> {
  return adminRequest("GET", `${player(userId)}/inventory`);
}

export function setCurrency(userId: string, catalogId: string, amount: number): Promise<unknown> {
  return adminRequest("POST", `${player(userId)}/currency`, { catalogId, amount });
}

export async function getTracks(userId: string): Promise<TrackInfo[]> {
  return (await adminRequest<{ tracks: TrackInfo[] }>("GET", `${player(userId)}/tracks`)).tracks;
}

export function setTrack(userId: string, progressionId: string, progress: number): Promise<unknown> {
  return adminRequest("POST", `${player(userId)}/tracks`, { progressionId, progress });
}

export function setAccountStatus(userId: string, status: "active" | "disabled" | "banned", reason?: string): Promise<unknown> {
  return adminRequest("POST", `${player(userId)}/access`, { status, reason });
}

export function deletePlayer(userId: string, confirmation: string, reason: string): Promise<unknown> {
  return adminRequest("POST", `${player(userId)}/delete`, { confirmation, reason });
}

export async function listOnline(): Promise<{ userId: string; displayName: string }[]> {
  return (await adminRequest<{ players: { userId: string; displayName: string }[] }>("GET", "/launcher/v1/admin/online")).players;
}

export async function listAudit(): Promise<AuditRecord[]> {
  return (await adminRequest<{ records: AuditRecord[] }>("GET", "/launcher/v1/admin/audit?limit=50")).records;
}
