import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { BrandMark } from "../../components/BrandMark";

export function AboutTab() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="max-w-[560px] px-12 pb-6 pt-4">
      <h1 className="display text-[30px] leading-none text-text">About</h1>

      <div className="mt-7 glass rounded-2xl p-6">
        <div className="flex items-center gap-3">
          <BrandMark height={34} />
          <div>
            <p className="text-[15px] font-semibold text-text">Ramsgate Reborn</p>
            <p className="text-xs text-text-muted">{version ? `Launcher v${version}` : "Launcher"}</p>
          </div>
        </div>

        <p className="mt-5 max-w-[60ch] text-[13px] leading-relaxed text-text-muted">
          An unofficial community server for Dauntless 1.12, keeping Ramsgate's lanterns burning.
        </p>

        <p className="mt-3 max-w-[60ch] text-[12px] leading-relaxed text-text-faint">
          Ramsgate Reborn is free software under the GNU AGPL-3.0.
          Here &ldquo;free&rdquo; means open: anyone can read the code, change it and share it, as long as they share their changes too.
        </p>

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-faint">Credits</p>
          <p className="mt-2 max-w-[60ch] text-[12px] leading-relaxed text-text-muted">
            Built and run by ZFXSTATIC (Afterlife Interactive LLC). It started from earlier community projects, with thanks:
          </p>
          <p className="mt-2 max-w-[60ch] text-[12px] leading-relaxed text-text-muted">
            Includes code from Mystic Paradox by Pranav Karande and from Undaunted by gwog, both licensed under the GNU AGPL-3.0.
            Full credits and license terms are in the NOTICE and LICENSE files of the source code.
          </p>
          <p className="mt-2 max-w-[60ch] text-[12px] leading-relaxed text-text-faint">
            &ldquo;Mystic Paradox&apos;s Dauntless 1.12.0 port and related modifications were developed by Pranav Karande. See NOTICE.md for contribution and provenance information.&rdquo;
          </p>
        </div>

        <div className="mt-5 flex gap-4 border-t border-border pt-4 text-[13px]">
          <a href="https://github.com/Afterlife-Interactive/ramsgate-reborn" target="_blank" rel="noopener noreferrer" className="text-accent-hover hover:underline">
            Source code
          </a>
          <a href="https://support.afterlifeinteractive.com/" target="_blank" rel="noopener noreferrer" className="text-accent-hover hover:underline">
            Help and support
          </a>
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer" className="text-accent-hover hover:underline">
            AGPL-3.0 license
          </a>
        </div>
      </div>
    </div>
  );
}
