import dragon from "../assets/dragon-color.png";

interface BrandMarkProps {
  /** Rendered height in pixels. */
  height?: number;
  /** "glow" outlines the black silhouette so it reads on the dark themes; "plain" draws it as is. */
  tone?: "glow" | "plain";
}

/** The Ramsgate Reborn dragon. */
export function BrandMark({ height = 34, tone = "glow" }: BrandMarkProps) {
  return (
    <img
      src={dragon}
      alt="Ramsgate Reborn"
      draggable={false}
      style={{
        height,
        width: "auto",
        filter: tone === "glow" ? "drop-shadow(0 0 1px oklch(1 0 0 / 0.9)) drop-shadow(0 0 8px var(--color-glow))" : undefined,
      }}
      className="object-contain"
    />
  );
}
