import { fetchAuthSession } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { useEffect, useState } from "react";
import { LoginForm } from "./LoginForm";
import { ReviewQueue } from "./ReviewQueue";

type AuthStatus = "checking" | "signedIn" | "signedOut";

export function App(): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [redirectError, setRedirectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkSession(): Promise<void> {
      try {
        const session = await fetchAuthSession();
        if (!cancelled) {
          setStatus(session.tokens?.idToken ? "signedIn" : "signedOut");
        }
      } catch {
        if (!cancelled) {
          setStatus("signedOut");
        }
      }
    }

    void checkSession();

    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedIn") {
        setRedirectError(null);
        setStatus("signedIn");
      } else if (payload.event === "signedOut") {
        setStatus("signedOut");
      } else if (payload.event === "signInWithRedirect_failure") {
        // On the very first Google sign-in, the pre-sign-up trigger links
        // the identity mid-request; Cognito's own provisioning step then
        // collides with that link and this event fires once even for the
        // legitimate user - retrying (a second click) succeeds. A real
        // rejection (wrong Google account) also lands here, so show
        // whatever Cognito/Amplify reports rather than assuming which case
        // this is.
        const message =
          payload.data.error?.message ??
          "Google sign-in didn't complete. If this is your first time signing in with Google, try again.";
        setRedirectError(message);
        setStatus("signedOut");
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (status === "checking") {
    return (
      <div className="app-loading">
        <span className="mark">
          <span className="mark-glyph">Concierge</span>
          <span>checking session…</span>
        </span>
      </div>
    );
  }

  if (status === "signedOut") {
    return (
      <LoginForm
        onSignedIn={() => setStatus("signedIn")}
        redirectError={redirectError}
      />
    );
  }

  return <ReviewQueue onSignedOut={() => setStatus("signedOut")} />;
}
