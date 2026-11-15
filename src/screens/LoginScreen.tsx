import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthShell } from "../components/AuthShell";
import { SupportLink } from "../components/SupportLink";
import { DISCORD_ONLY } from "../lib/buildConfig";

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18.2 18.2 0 0 0-5.6 0L8.6 3a19.6 19.6 0 0 0-4.9 1.4C.6 9 0 13.5.3 18a19.8 19.8 0 0 0 6 3l1.3-2.1c-.7-.3-1.4-.6-2-1l.5-.4a14 14 0 0 0 11.8 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.8 19.8 0 0 0 6-3c.4-5.2-.7-9.7-3.4-13.6ZM8.5 15.3c-1.2 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.1 1 2.1 2.3-.9 2.3-2.1 2.3Zm7 0c-1.2 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.1 1 2.1 2.3-.9 2.3-2.1 2.3Z" />
    </svg>
  );
}

interface LoginScreenProps {
  onCreateAccount: () => void;
}

export function LoginScreen({ onCreateAccount }: LoginScreenProps) {
  const { login, startDiscordLogin, authError } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [discordSubmitting, setDiscordSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A Discord flow can fail asynchronously (deep-link error, or the completion
  // exchange itself failing) after this screen has already unmounted and
  // remounted — authError from context covers that; local `error` covers
  // synchronous form-submit failures this screen caused directly.
  const displayedError = error ?? authError;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      await login(email, password);
      // Entered credentials are intentionally left in state — a successful
      // login unmounts this screen, and a failed one should not lose them.
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDiscord() {
    setError(null);
    setDiscordSubmitting(true);

    try {
      await startDiscordLogin();
    } catch (err) {
      setError(describeAuthError(err));
      setDiscordSubmitting(false);
    }
  }

  const heading = (
    <div className="mb-7">
      <h1 className="display text-[32px] leading-none text-text">Sign in</h1>
      <p className="mt-3 text-sm text-text-muted">
        {DISCORD_ONLY ? "Sign in with Discord. No password needed." : "Good to see you again."}
      </p>
    </div>
  );

  if (DISCORD_ONLY) {
    return (
      <AuthShell>
        {heading}

        <div className="flex flex-col gap-4">
          {displayedError && <Banner>{displayedError}</Banner>}

          <Button type="button" className="slant-btn w-full py-3.5" loading={discordSubmitting} onClick={handleDiscord}>
            <DiscordIcon className="h-4 w-4" />
            Sign in with Discord
          </Button>

          <p className="text-[12px] leading-relaxed text-text-faint">
            First time here? Signing in creates your account. We only use your Discord name.
          </p>
          <p className="text-[12px] text-text-faint">
            Trouble signing in? <SupportLink />
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      {heading}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {displayedError && <Banner>{displayedError}</Banner>}

        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />

        <TextField
          label="Password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          rightAdornment={
            <button
              type="button"
              className="rounded px-1.5 py-1 text-xs font-medium text-text-muted transition-colors duration-150 hover:text-text"
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          }
        />

        <Button type="submit" loading={submitting} className="slant-btn mt-1 w-full py-3.5">
          Sign in
        </Button>

        <div className="flex items-center gap-3 text-xs text-text-faint">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>

        <Button type="button" variant="secondary" className="w-full" loading={discordSubmitting} onClick={handleDiscord}>
          <DiscordIcon className="h-4 w-4" />
          Continue with Discord
        </Button>

        <div className="mt-1 flex items-center justify-between text-[13px]">
          <button type="button" className="font-semibold text-text underline-offset-4 hover:underline" onClick={onCreateAccount}>
            Create account
          </button>
          <span className="cursor-not-allowed text-text-faint" title="Not available yet">
            Forgot password
          </span>
        </div>
      </form>
    </AuthShell>
  );
}
