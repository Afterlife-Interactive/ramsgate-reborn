// Builds for hosted servers sign in with Discord only (no email/password accounts).
export const DISCORD_ONLY = import.meta.env.VITE_DISCORD_ONLY === "true";

// The admin launcher build adds the Admin tab (sign-up approvals and server control). Player builds leave
// this off, so the tab's code is not even bundled. The server enforces the admin role either way.
export const ADMIN_BUILD = import.meta.env.VITE_ADMIN_BUILD === "true";
