import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { launcherApi } from "../api/client";
import { TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthShell } from "../components/AuthShell";

const USERNAME_PATTERN = /^[A-Za-z0-9]+$/;

type UsernameCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "unavailable"; reason: string };

function usernameFormatError(username: string): string | null {
  if (username.length < 3 || username.length > 16) return "Username must be 3–16 characters.";
  if (!USERNAME_PATTERN.test(username)) return "Letters and numbers only.";
  return null;
}

// Shown when an account (typically a fresh Discord sign-in) has no username yet.
export function SetUsernameScreen() {
  const { setUsername, logout } = useAuth();

  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<UsernameCheck>({ state: "idle" });

  async function checkAvailability() {
    const username = value.trim();
    if (usernameFormatError(username)) {
      setCheck({ state: "idle" });
      return;
    }

    setCheck({ state: "checking" });
    try {
      const result = await launcherApi.checkUsername(username);
      setCheck(
        result.available ? { state: "available" } : { state: "unavailable", reason: result.reason ?? "That username is taken." },
      );
    } catch {
      setCheck({ state: "idle" });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const formatError = usernameFormatError(value.trim());
    if (formatError) {
      setError(formatError);
      return;
    }
    if (check.state === "unavailable") {
      setError(check.reason);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await setUsername(value.trim());
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const hint =
    check.state === "checking"
      ? "Checking…"
      : check.state === "available"
        ? "✓ Available"
        : "Letters and numbers. Friends use it to invite you.";

  const hintClass = check.state === "available" ? "text-online" : "text-text-faint";

  return (
    <AuthShell>
      <div className="mb-7">
        <h1 className="display text-[32px] leading-none text-text">Pick a name</h1>
        <p className="mt-3 text-sm text-text-muted">It shows in game, and friends use it to invite you.</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <Banner>{error}</Banner>}

        <div className="flex flex-col gap-1">
          <TextField
            label="Username"
            autoComplete="username"
            placeholder="e.g. LanternHunter7"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setCheck({ state: "idle" });
            }}
            onBlur={checkAvailability}
            disabled={submitting}
            error={check.state === "unavailable" ? check.reason : undefined}
          />
          {check.state !== "unavailable" && <p className={`text-[12px] ${hintClass}`}>{hint}</p>}
        </div>

        <Button type="submit" loading={submitting} className="slant-btn mt-1 w-full py-3.5">
          Set username
        </Button>

        <button
          type="button"
          className="rounded text-[13px] text-text-muted transition-colors duration-150 hover:text-text"
          onClick={() => logout()}
        >
          Cancel and sign out
        </button>
      </form>
    </AuthShell>
  );
}
