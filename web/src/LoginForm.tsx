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
    <div className="login-screen">
      <div className="login-card">
        <p className="login-eyebrow">Email Concierge</p>
        <h1 className="login-title">Sign in to review the queue</h1>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
