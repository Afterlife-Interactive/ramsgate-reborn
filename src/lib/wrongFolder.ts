// The server refuses a game folder whose exe is not the Ramsgate Reborn one (an old Dauntless, Steam, Epic or
// Dauntless Revived copy). The launcher turns that into a plain message (native side, commands/auth.rs) that starts
// with this text; the screen looks for it to offer the download button.
export const WRONG_FOLDER_TEXT_START = "This game folder is not the Ramsgate Reborn game";

export function isWrongFolderMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && message.trim().startsWith(WRONG_FOLDER_TEXT_START);
}

export const WRONG_FOLDER_BUTTON = "Download the Ramsgate Reborn game";

// Shown when the rejected game is the one this launcher downloaded itself: forgetting it would only select it again.
export const OWN_DOWNLOAD_REFUSED_TEXT =
  "This is the game the launcher downloaded, so its files may be damaged. Open the Game files tab, uninstall it, then download the game again.";
