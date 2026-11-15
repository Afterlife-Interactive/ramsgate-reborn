import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";

interface AuthShellProps {
  children: ReactNode;
}

/**
 * Layout for every signed-out screen: the theme's art fills the window (WindowFrame), the dragon and name sit
 * in the top-left, and the form floats on a glass card on the left.
 */
export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="flex h-full flex-col px-12 pb-10 pt-9">
      <div className="flex items-center gap-3">
        <BrandMark height={40} />
        <div>
          <p className="display text-[17px] leading-none text-text">Ramsgate Reborn</p>
          <p className="mt-1 text-[11px] text-text-faint">A Dauntless 1.12 server</p>
        </div>
      </div>

      <main className="flex min-h-0 flex-1 items-center">
        <div className="glass w-full max-w-[380px] rounded-3xl p-8 shadow-[0_30px_60px_-30px] shadow-black/70">{children}</div>
      </main>

      <p className="text-[11px] text-text-faint">Unofficial. Not affiliated with Phoenix Labs or Forte Labs.</p>
    </div>
  );
}
