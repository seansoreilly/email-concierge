import type { CorrectionRequest, EmailRecord } from "@email-concierge/shared";
import {
  ContentTag,
  EmailRecord as EmailRecordSchema,
  ResponseState,
} from "@email-concierge/shared";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import { useEffect, useState } from "react";
import { apiUrlFor } from "./env";

interface ReviewQueueProps {
  onSignedOut: () => void;
}

// Priority is a contractually-fixed int range (shared/types.ts: z.number().int().min(2).max(10)).
const PRIORITY_MIN = 2;
const PRIORITY_MAX = 10;

type LoadState = "loading" | "ready" | "error";

const PRIORITY_OPTIONS: number[] = Array.from(
  { length: PRIORITY_MAX - PRIORITY_MIN + 1 },
  (_, i) => PRIORITY_MIN + i,
);

/** Lowest of the three per-field confidences - the value the review queue sorts by. */
function minConfidence(record: EmailRecord): number {
  const { responseStateConfidence, contentTagConfidence, priorityConfidence } =
    record.classification;
  return Math.min(
    responseStateConfidence,
    contentTagConfidence,
    priorityConfidence,
  );
}

function confidenceColor(confidence: number): string {
  if (confidence < 0.5) return "#b00020";
  if (confidence < 0.8) return "#b8860b";
  return "#2e7d32";
}

async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error("No active session. Please sign in again.");
  }
  return token;
}

interface CorrectionFormProps {
  record: EmailRecord;
  onSaved: (updated: EmailRecord) => void;
}

function CorrectionForm({ record, onSaved }: CorrectionFormProps): JSX.Element {
  const [responseState, setResponseState] = useState(
    record.classification.responseState,
  );
  const [contentTag, setContentTag] = useState(
    record.classification.contentTag,
  );
  const [priority, setPriority] = useState(record.classification.priority);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);

    const body: CorrectionRequest = { responseState, contentTag, priority };

    try {
      const token = await getIdToken();
      const response = await fetch(
        apiUrlFor(`emails/${record.messageId}/correction`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`);
      }

      const json: unknown = await response.json();
      const parsed = EmailRecordSchema.safeParse(json);

      if (parsed.success) {
        onSaved(parsed.data);
      } else {
        // API returned something unexpected (e.g. still-stubbed handler) -
        // merge the correction locally so the UI still reflects the human edit.
        onSaved({
          ...record,
          classification: {
            ...record.classification,
            responseState,
            contentTag,
            priority,
            source: "human",
            responseStateConfidence: 1,
            contentTagConfidence: 1,
            priorityConfidence: 1,
          },
        });
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Save failed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        alignItems: "center",
        flexWrap: "wrap",
        marginTop: "0.5rem",
      }}
    >
      <label>
        Response
        <select
          value={responseState}
          onChange={(e) =>
            setResponseState(
              e.target.value as (typeof ResponseState.options)[number],
            )
          }
          style={{ marginLeft: "0.25rem" }}
        >
          {ResponseState.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label>
        Tag
        <select
          value={contentTag}
          onChange={(e) =>
            setContentTag(e.target.value as (typeof ContentTag.options)[number])
          }
          style={{ marginLeft: "0.25rem" }}
        >
          {ContentTag.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label>
        Priority
        <select
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
          style={{ marginLeft: "0.25rem" }}
        >
          {PRIORITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => void handleSave()} disabled={saving}>
        {saving ? "Saving..." : "Save correction"}
      </button>
      {error ? <span style={{ color: "#b00020" }}>{error}</span> : null}
    </div>
  );
}

interface EmailRowProps {
  record: EmailRecord;
  onSaved: (updated: EmailRecord) => void;
}

function EmailRow({ record, onSaved }: EmailRowProps): JSX.Element {
  const confidence = minConfidence(record);

  return (
    <li
      style={{
        border: "1px solid #ccc",
        borderRadius: 6,
        padding: "0.75rem 1rem",
        marginBottom: "0.75rem",
        listStyle: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <div>
          <strong>{record.subject || "(no subject)"}</strong>
          <div style={{ color: "#555", fontSize: "0.9rem" }}>{record.from}</div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            whiteSpace: "nowrap",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: "50%",
              backgroundColor: confidenceColor(confidence),
            }}
          />
          <span>{Math.round(confidence * 100)}% confident</span>
        </div>
      </div>
      <p style={{ color: "#333" }}>{record.snippet}</p>
      <div style={{ fontSize: "0.85rem", color: "#555" }}>
        <span>{record.classification.responseState}</span>
        {" | "}
        <span>{record.classification.contentTag}</span>
        {" | "}
        <span>Priority {record.classification.priority}</span>
        {" | "}
        <span>source: {record.classification.source}</span>
        {record.isFixture ? <span> | fixture</span> : null}
        {" | "}
        <span>draft {record.draftCreated ? "created" : "not created"}</span>
      </div>
      <CorrectionForm record={record} onSaved={onSaved} />
    </li>
  );
}

export function ReviewQueue({ onSignedOut }: ReviewQueueProps): JSX.Element {
  const [state, setState] = useState<LoadState>("loading");
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const token = await getIdToken();
        const response = await fetch(apiUrlFor("emails"), {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          throw new Error(`Failed to load emails (${response.status})`);
        }

        const json: unknown = await response.json();
        const parsed = EmailRecordSchema.array().parse(json);
        // Sort once, lowest-confidence-first, at load time. A later correction
        // updates the record in place (see handleSaved) without re-sorting, so
        // a saved row doesn't jump position under the user's cursor.
        const initialSort = [...parsed].sort(
          (a, b) => minConfidence(a) - minConfidence(b),
        );

        if (!cancelled) {
          setEmails(initialSort);
          setState("ready");
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load emails.",
          );
          setState("error");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  function handleSaved(updated: EmailRecord): void {
    // Update in place; don't re-sort so the row doesn't jump under the user's cursor.
    setEmails((current) =>
      current.map((email) =>
        email.messageId === updated.messageId ? updated : email,
      ),
    );
  }

  async function handleSignOut(): Promise<void> {
    await signOut();
    onSignedOut();
  }

  return (
    <div
      style={{ maxWidth: 800, margin: "2rem auto", fontFamily: "sans-serif" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h1 style={{ fontSize: "1.25rem" }}>Review Queue</h1>
        <button type="button" onClick={() => void handleSignOut()}>
          Sign out
        </button>
      </div>

      {state === "loading" ? <p>Loading emails...</p> : null}
      {state === "error" ? <p style={{ color: "#b00020" }}>{error}</p> : null}

      {state === "ready" ? (
        emails.length === 0 ? (
          <p>No emails to review.</p>
        ) : (
          <ul style={{ padding: 0 }}>
            {emails.map((record) => (
              <EmailRow
                key={record.messageId}
                record={record}
                onSaved={handleSaved}
              />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
