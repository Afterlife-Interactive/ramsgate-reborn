import type { ReactNode } from "react";
import { SupportLink } from "./SupportLink";

interface BannerProps {
  tone?: "danger" | "muted";
  children: ReactNode;
}

export function Banner({ tone = "danger", children }: BannerProps) {
  const tones = {
    danger: "border-danger/30 bg-danger-muted text-danger",
    muted: "border-border bg-surface-raised text-text-muted",
  };

  return (
    <div role={tone === "danger" ? "alert" : undefined} className={`rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed ${tones[tone]}`}>
      {children}
      {tone === "danger" && (
        <>
          {" "}
          <SupportLink />
        </>
      )}
    </div>
  );
}
