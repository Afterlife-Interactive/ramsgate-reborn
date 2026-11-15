// Plain text for the download button and the "found it" suggestion. No hard-coded game size: it is read from the
// manifest the server sends. The disk figure mirrors the launcher's own check (archive plus unpacked game plus 2 GB).

const GIB = 1073741824;

export interface SizedOffer {
  size: number;
}

function validSize(size: unknown): size is number {
  return typeof size === "number" && Number.isFinite(size) && size > 0;
}

/** "16 GB", or "7.5 GB" for smaller ones. */
export function formatGigabytes(bytes: number): string {
  const gb = bytes / GIB;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${(Math.round(gb * 10) / 10).toString()} GB`;
}

/** Free space needed while installing, in bytes. Same rule as the native free-space check. */
export function diskNeededBytes(archiveBytes: number): number {
  return archiveBytes * 2 + 2 * GIB;
}

/** Rounded up to a whole GB, like the native error message ("about N GB free"). */
export function diskNeededGigabytes(archiveBytes: number): number {
  return Math.floor(diskNeededBytes(archiveBytes) / GIB) + 1;
}

export function downloadButtonLabel(offer: SizedOffer | null | undefined): string {
  if (!offer || !validSize(offer.size)) return "Download game";
  return `Download game (${formatGigabytes(offer.size)})`;
}

/** The line under the button. Empty when the size is not known. */
export function downloadNeedsLine(offer: SizedOffer | null | undefined): string {
  if (!offer || !validSize(offer.size)) return "";
  return `The download is ${formatGigabytes(offer.size)}. You need about ${diskNeededGigabytes(offer.size)} GB of free disk space while it installs.`;
}

/** Offer a found install only when nothing is set up and the player has not said no. */
export function shouldOfferFoundInstall(found: string | null, located: boolean, dismissed: boolean): boolean {
  return found !== null && found.trim() !== "" && !located && !dismissed;
}

export function foundInstallText(folder: string): string {
  return `We found Dauntless at ${folder}. Use this folder?`;
}
