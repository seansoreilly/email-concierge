import { signIn } from "aws-amplify/auth";
import { type FormEvent, useState } from "react";

interface LoginFormProps {
  onSignedIn: () => void;
}

export function LoginForm({ onSignedIn }: LoginFormProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const { isSignedIn, nextStep } = await signIn({
        username: email,
        password,
      });

      if (isSignedIn) {
        onSignedIn();
        return;
      }

      if (
        nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"
      ) {
        setError(
          "Your account requires a password reset. Please contact the admin.",
        );
        return;
      }

      setError(
        `Additional sign-in step required (${nextStep.signInStep}). Please contact the admin.`,
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Sign-in failed. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}
    >
      <h1 style={{ fontSize: "1.25rem" }}>Email Concierge - Sign in</h1>
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <label htmlFor="email">
          Email
          <input
            id="email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: "0.5rem", marginTop: "0.25rem" }}
          />
        </label>
        <label htmlFor="password">
          Password
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: "0.5rem", marginTop: "0.25rem" }}
          />
        </label>
        {error ? <p style={{ color: "#b00020" }}>{error}</p> : null}
        <button
          type="submit"
          disabled={submitting}
          style={{ padding: "0.5rem" }}
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
