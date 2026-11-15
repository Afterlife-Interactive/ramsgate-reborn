// Download-only copy of the player's own online save (native_download_online_save, online half). GET only: it saves a
// file outside the offline folder and returns its name. It sends nothing from this PC.
import { invoke } from "@tauri-apps/api/core";

export type OnlineSaveDownload =
  | { status: "saved"; fileName: string; size: number }
  | { status: "unavailable"; message: string };

export async function downloadOnlineSave(): Promise<OnlineSaveDownload> {
  return invoke<OnlineSaveDownload>("native_download_online_save");
}
