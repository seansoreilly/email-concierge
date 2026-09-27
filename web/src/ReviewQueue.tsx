import type { CorrectionRequest, EmailRecord } from "@email-concierge/shared";
import {
  ContentTag,
  EmailRecord as EmailRecordSchema,
  ResponseState,
} from "@email-concierge/shared";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { apiUrlFor } from "./env";

/** CSSProperties doesn't model custom properties; this narrow alias documents
 *  that `--fill` is the one custom property the gauge bar's CSS reads. */
type GaugeFillStyle = CSSProperties & { "--fill": string };

interface ReviewQueueProps {
  onSignedOut: () => void;
}

// Priority is a contractually-fixed int range (shared/types.ts: z.number().int().min(2).max(10)).
const PRIORITY_MIN = 2;
const PRIORITY_MAX = 10;
const PRIORITY_URGENT_THRESHOLD = 8;

type LoadState = "loading" | "ready" | "error";

const PRIORITY_OPTIONS: number[] = Array.from(
  { length: PRIORITY_MAX - PRIORITY_MIN + 1 },
  (_, i) => PRIORITY_MIN + i,
);

interface ConfidenceField {
  name: string;
  value: number;
}

/** The three independent confidences, in the order the gauge displays them. */
function confidenceFields(record: EmailRecord): ConfidenceField[] {
  const c = record.classification;
  return [
    { name: "Response", value: c.responseStateConfidence },
    { name: "Tag", value: c.contentTagConfidence },
    { name: "Priority", value: c.priorityConfidence },
  ];
}

/** Lowest of the three per-field confidences - the value the review queue sorts by. */
function minConfidence(record: EmailRecord): number {
  return Math.min(...confidenceFields(record).map((f) => f.value));
}

function confidenceLevel(value: number): "low" | "mid" | "high" {
  if (value < 0.5) return "low";
  if (value < 0.8) return "mid";
  return "high";
}

function sourceLabel(source: EmailRecord["classification"]["source"]): string {
  switch (source) {
    case "jev":
      return "Classified by Jev";
    case "haiku":
      return "Classified by Haiku (fallback)";
    case "heuristic":
      return "Sorted by rule";
    case "human":
      return "Corrected by you";
  }
}

function formatReceived(receivedAt: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(receivedAt));
  } catch {
    return receivedAt;
  }
}

async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error("No active session. Please sign in again.");
  }
  return token;
}

/** The three-tick confidence instrument - this queue's signature element.
 *  Sorting is driven by the weakest of three independent scores, not one
 *  blended number, so the gauge shows all three and marks the weakest. */
function ConfidenceGauge({ record }: { record: EmailRecord }): JSX.Element {
  const fields = confidenceFields(record);
  const weakest = Math.min(...fields.map((f) => f.value));
  // Only call out the weakest field when it's actually not-high-confidence -
  // a fully-confident row (or an all-1 post-correction row) should read as
  // quiet, not have one of its three ticks arbitrarily bolded by a tie.
  const weakestIsNotable = confidenceLevel(weakest) !== "high";

  return (
    <div className="confidence-gauge">
      <div className="gauge-track">
        {fields.map((field) => {
          const level = confidenceLevel(field.value);
          const isWeakest = weakestIsNotable && field.value === weakest;
          return (
            <div
              className="gauge-row"
              key={field.name}
              data-weakest={isWeakest}
            >
              <span className="gauge-name">{field.name}</span>
              <span className="gauge-bar">
                <span
                  className="gauge-fill"
                  data-level={level}
                  style={
                    {
                      "--fill": `${field.value * 100}%`,
                    } as GaugeFillStyle
                  }
                />
              </span>
              <span className="gauge-value">
                {Math.round(field.value * 100)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
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
    <div className="correction-form">
      <div className="correction-field">
        <label htmlFor={`response-${record.messageId}`}>Response</label>
        <select
          id={`response-${record.messageId}`}
          value={responseState}
          onChange={(e) =>
            setResponseState(
              e.target.value as (typeof ResponseState.options)[number],
            )
          }
        >
          {ResponseState.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <div className="correction-field">
        <label htmlFor={`tag-${record.messageId}`}>Tag</label>
        <select
          id={`tag-${record.messageId}`}
          value={contentTag}
          onChange={(e) =>
            setContentTag(e.target.value as (typeof ContentTag.options)[number])
          }
        >
          {ContentTag.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <div className="correction-field">
        <label htmlFor={`priority-${record.messageId}`}>Priority</label>
        <select
          id={`priority-${record.messageId}`}
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        >
          {PRIORITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="btn-save"
        onClick={() => void handleSave()}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save correction"}
      </button>
      {error ? <span className="correction-error">{error}</span> : null}
    </div>
  );
}

interface EmailRowProps {
  record: EmailRecord;
  onSaved: (updated: EmailRecord) => void;
}

function EmailRow({ record, onSaved }: EmailRowProps): JSX.Element {
  const { responseState, contentTag, priority, source } = record.classification;
  const isUrgent = priority >= PRIORITY_URGENT_THRESHOLD;

  return (
    <li className="email-row">
      <div className="row-priority" data-urgent={isUrgent}>
        {priority}
        <span className="row-priority-label">pri</span>
      </div>
      <div className="row-main">
        <div className="row-top">
          <div>
            <h2 className="row-subject">{record.subject || "(no subject)"}</h2>
            <div className="row-from">{record.from}</div>
          </div>
          <div className="row-received">
            {formatReceived(record.receivedAt)}
          </div>
        </div>

        <p className="row-snippet">{record.snippet}</p>

        <ConfidenceGauge record={record} />

        <div className="row-tags">
          <span className="chip" data-state={responseState}>
            {responseState}
          </span>
          <span className="chip chip-outline">{contentTag}</span>
          <span className="meta-note">{sourceLabel(source)}</span>
          {record.isFixture ? (
            <span className="meta-note">· fixture data</span>
          ) : null}
          {responseState === "To Respond" ? (
            <span
              className="draft-flag"
              data-created={record.draftCreated}
              title="AI-generated draft - not sent. Review and send from Gmail yourself."
            >
              {record.draftCreated
                ? "Draft ready in Gmail — not sent"
                : "No draft yet"}
            </span>
          ) : null}
        </div>

        <CorrectionForm record={record} onSaved={onSaved} />
      </div>
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
    <div className="queue-shell">
      <div className="queue-header">
        <div className="queue-heading">
          <p className="login-eyebrow">Email Concierge</p>
          <h1 className="queue-title">Review queue</h1>
        </div>
        <div className="queue-actions">
          {state === "ready" ? (
            <span className="queue-count">
              {emails.length} to review, weakest confidence first
            </span>
          ) : null}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void handleSignOut()}
          >
            Sign out
          </button>
        </div>
      </div>

      {state === "loading" ? (
        <p className="queue-status">Loading emails…</p>
      ) : null}
      {state === "error" ? (
        <p className="queue-status is-error">{error}</p>
      ) : null}

      {state === "ready" ? (
        emails.length === 0 ? (
          <p className="queue-empty">Nothing to review right now.</p>
        ) : (
          <ul className="queue-list">
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
