import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  size?: "md" | "sm";
  loading?: boolean;
}

export function Button({ variant = "primary", size = "md", loading = false, disabled, className, children, ...rest }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl font-semibold tracking-wide transition-[background-color,border-color,color] duration-150 ease-(--ease-out-quart) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45";

  const sizes = {
    md: "px-5 py-2.5 text-sm",
    sm: "px-3 py-1.5 text-xs",
  };

  const variants = {
    primary: "bg-accent text-on-ink hover:bg-accent-hover",
    secondary: "border border-border-strong bg-surface text-text hover:border-accent hover:bg-surface-raised",
  };

  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className ?? ""}`} disabled={disabled || loading} {...rest}>
      {loading ? "Please wait…" : children}
    </button>
  );
}
