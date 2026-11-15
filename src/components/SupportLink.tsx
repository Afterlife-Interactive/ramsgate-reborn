import { SUPPORT_LINK_TEXT, SUPPORT_URL } from "../lib/support";

export function SupportLink({ className = "" }: { className?: string }) {
  return (
    <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className={`underline underline-offset-2 hover:no-underline ${className}`}>
      {SUPPORT_LINK_TEXT}
    </a>
  );
}
