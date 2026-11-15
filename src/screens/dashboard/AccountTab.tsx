import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/Button";
import { DISCORD_ONLY } from "../../lib/buildConfig";
import { PlaytimeCard } from "./PlaytimeCard";

export function AccountTab() {
  const { account, logout } = useAuth();

  return (
    <div className="max-w-[560px] px-12 pb-6 pt-4">
      <h1 className="display text-[30px] leading-none text-text">Account</h1>
      <p className="mt-1 text-[13px] text-text-muted">Who you're signed in as.</p>

      <div className="mt-7 overflow-hidden glass rounded-2xl">
        <div className="flex items-center gap-4 p-6">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-accent-muted text-lg font-semibold text-accent-hover">
            {(account?.displayName ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-medium text-text">{account?.displayName}</p>
            <p className="truncate text-[13px] text-text-muted">{DISCORD_ONLY ? "Signed in with Discord" : account?.email}</p>
          </div>
        </div>

        {!DISCORD_ONLY && (
          <div className="flex items-center justify-between border-t border-border px-6 py-4">
            <div>
              <p className="text-[13px] font-medium text-text">Discord</p>
              <p className="mt-0.5 text-xs text-text-muted">
                {account?.discordLinked ? "Linked" : "Not linked"}
              </p>
            </div>
            <Button variant="secondary" className="w-auto px-4" disabled title="Discord linking isn't wired up yet">
              {account?.discordLinked ? "Unlink" : "Link Discord"}
            </Button>
          </div>
        )}
      </div>

      <PlaytimeCard />

      <Button variant="secondary" className="mt-6 w-full" onClick={() => void logout()}>
        Log out
      </Button>
    </div>
  );
}
