import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { launcherApi } from "../api/client";
import { TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthShell } from "../components/AuthShell";

interface RegisterScreenProps {
  onBackToLogin: () => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

export function RegisterScreen({ onBackToLogin }: RegisterScreenProps) {
  const { register } = useAuth();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameCheck, setUsernameCheck] = useState<UsernameCheck>({ state: "idle" });

  // Availability probe on blur — best-effort; the authoritative uniqueness check is on submit.
  async function checkAvailability() {
    const value = username.trim();
    if (usernameFormatError(value)) {
      setUsernameCheck({ state: "idle" });
      return;
    }

    setUsernameCheck({ state: "checking" });
    try {
      const result = await launcherApi.checkUsername(value);
      setUsernameCheck(
        result.available ? { state: "available" } : { state: "unavailable", reason: result.reason ?? "That username is taken." },
      );
    } catch {
      setUsernameCheck({ state: "idle" });
    }
  }

  function validate(): string | null {
    const formatError = usernameFormatError(username.trim());
    if (formatError) return formatError;

    if (usernameCheck.state === "unavailable") {
      return usernameCheck.reason;
    }

    if (!EMAIL_PATTERN.test(email)) {
      return "Enter a valid email address.";
    }

    if (password.length < 8) {
      return "Password must be at least 8 characters.";
    }

    if (password !== confirmPassword) {
      return "Passwords don't match.";
    }

    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const validationError = validate();

    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      await register(username.trim(), email, password);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const hint =
    usernameCheck.state === "checking"
      ? "Checking…"
      : usernameCheck.state === "available"
        ? "✓ Available"
        : "Letters and numbers. Friends use it to invite you.";

  const hintClass =
    usernameCheck.state === "available" ? "text-online" : "text-text-faint";

  return (
    <AuthShell>
      <div className="mb-7">
        <h1 className="display text-[32px] leading-none text-text">Create account</h1>
        <p className="mt-3 text-sm text-text-muted">Pick a name. An admin approves new accounts.</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <Banner>{error}</Banner>}

        <div className="flex flex-col gap-1">
          <TextField
            label="Username"
            autoComplete="username"
            placeholder="e.g. LanternHunter7"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameCheck({ state: "idle" });
            }}
            onBlur={checkAvailability}
            disabled={submitting}
            error={usernameCheck.state === "unavailable" ? usernameCheck.reason : undefined}
          />
          {usernameCheck.state !== "unavailable" && <p className={`text-[12px] ${hintClass}`}>{hint}</p>}
        </div>

        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />

        <TextField
          label="Password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
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

        <TextField
          label="Confirm password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={submitting}
        />

        <Button type="submit" loading={submitting} className="slant-btn mt-1 w-full py-3.5">
          Create account
        </Button>

        <button
          type="button"
          className="rounded text-[13px] text-text-muted transition-colors duration-150 hover:text-text"
          onClick={onBackToLogin}
        >
          Already have an account? <span className="font-semibold text-text underline underline-offset-4">Sign in</span>
        </button>
      </form>
    </AuthShell>
  );
}
