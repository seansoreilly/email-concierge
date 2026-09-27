import { fetchAuthSession } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { useEffect, useState } from "react";
import { LoginForm } from "./LoginForm";
import { ReviewQueue } from "./ReviewQueue";

type AuthStatus = "checking" | "signedIn" | "signedOut";

export function App(): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>("checking");

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
        setStatus("signedIn");
      } else if (payload.event === "signedOut") {
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
    return <LoginForm onSignedIn={() => setStatus("signedIn")} />;
  }

  return <ReviewQueue onSignedOut={() => setStatus("signedOut")} />;
}
