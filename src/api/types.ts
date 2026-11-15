// Mirrors Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md — the /launcher/v1 contract
// this client is built against, and src/security/launcherErrors.ts on the backend
// for the exact LauncherErrorCode union (SERVER_UNAVAILABLE is the one exception:
// client-synthesized on fetch failure, never sent by the server).

export type LauncherErrorCode =
  | "AUTH_VALIDATION_FAILED"
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_EMAIL_TAKEN"
  | "AUTH_DISPLAY_NAME_TAKEN"
  | "AUTH_ACCOUNT_DISABLED"
  | "AUTH_ACCOUNT_BANNED"
  | "AUTH_APPROVAL_PENDING"
  | "AUTH_APPROVAL_REJECTED"
  | "AUTH_USERNAME_REQUIRED"
  | "AUTH_REFRESH_INVALID"
  | "AUTH_UNAUTHORIZED"
  | "AUTH_RATE_LIMITED"
  | "AUTH_DISCORD_NOT_CONFIGURED"
  | "AUTH_DISCORD_CANCELLED"
  | "AUTH_DISCORD_ALREADY_LINKED"
  | "AUTH_PASSWORD_DISABLED"
  | "GAME_EXCHANGE_CODE_EXPIRED"
  | "GAME_BUILD_UNSUPPORTED"
  | "NOT_FOUND"
  | "INTERNAL"
  | "SERVER_UNAVAILABLE"
  | "UNKNOWN";

export interface LauncherAccount {
  userId: string;
  displayName: string;
  email: string;
  discordLinked: boolean;
  status: "active" | "banned" | "disabled";
  approvalStatus: "pending" | "approved" | "rejected";
  /** True for a fresh Discord account with no chosen username yet — the launcher
   *  must show the set-username step before the account can play. */
  needsUsername: boolean;
}

export interface UsernameAvailabilityResponse {
  available: boolean;
  reason?: string;
}

export interface ServerInstances {
  ramsgate: number;
  trainingDojo: number;
  hunts: number;
  maxHunts: number;
}

export interface ServerStatusResponse {
  online: boolean;
  supportedBuildChangelist: number;
  /** Players currently connected to the game. Older servers do not send it. */
  playersOnline?: number;
  /** Running game server instances; null when the director cannot be reached. */
  instances?: ServerInstances | null;
  /** "ok" when all is well. Older servers do not send it. */
  health?: "ok" | "degraded" | "down";
  /** Plain sentence to show when health is not "ok". */
  healthMessage?: string | null;
  /** A message the owner set on the server, for example "Hub restarting, back in a minute." */
  ownerMessage?: string | null;
}

export interface LauncherPolicy {
  policyVersion: string;
  roles: string[];
  channel: "stable" | "beta" | "dev";
  testChannelEligible?: boolean;
  managedFeatureIds: string[];
  logUpload: { auto: boolean };
}

export interface LogPaths {
  sessionsRoot: string;
  latestSessionDir: string | null;
}
