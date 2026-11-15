// RR-38 offline mode: the one-way rule as the player reads it, and the list of native commands the offline half may
// call. The offline half of the launcher only talks to its own native commands (offline_*), which have no network
// code; it never calls the account server. A test checks that every invoke in src/offline uses one of these names.

export const ONE_WAY_NOTICE_TITLE = "Offline play stays on this PC";

export const ONE_WAY_NOTICE: readonly string[] = [
  "Offline mode has its own separate save on this PC. It never connects to the online servers. The only thing that can come from your online account is a read-only copy of your save, which you load yourself from this panel; it only ever goes down, never back up.",
  "Everything you do offline (levels, items, Rams, coins) stays on this PC and can never be moved to your online account.",
  "Offline mode makes its own copy of the Ramsgate Reborn game you already installed. It does not include any Phoenix Labs game files or data, and it never changes your online game folder.",
];

export const OFFLINE_COMMANDS = [
  "offline_get_mode",
  "offline_accept_notice",
  "offline_set_mode",
  "offline_overview",
  "offline_status",
  "offline_start",
  "offline_stop",
  "offline_restart",
  "offline_play",
  "offline_install",
  "offline_install_state",
  "offline_get_rates",
  "offline_save_rates",
  "offline_reset_rates",
  "offline_apply_rates",
  "offline_import_save",
  "offline_open_log_folder",
] as const;

export type OfflineCommand = (typeof OFFLINE_COMMANDS)[number];
