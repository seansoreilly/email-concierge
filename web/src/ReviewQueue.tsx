import type { CorrectionRequest, EmailRecord } from "@email-concierge/shared";
import {
  ContentTag,
  EmailRecord as EmailRecordSchema,
  PRIORITY_MAX,
  PRIORITY_MIN,
  ResponseState,
} from "@email-concierge/shared";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import { useEffect, useMemo, useState } from "react";
import { apiUrlFor } from "./env";
import {
  confidenceLevel,
  formatReceived,
  initials,
  minConfidence,
  parseFrom,
  sortByConfidence,
  sourceLabel,
} from "./queue-logic";

type LoadState = "loading" | "ready" | "error";

/** Where a reviewed email sits, tracked client-side only: the API has no
 *  concept of approve/reject/send yet, so this never leaves the browser. */
type QueueStatus = "needs-review" | "approved" | "sent" | "rejected";

type ListFilter = "all" | "high-confidence" | "needs-attention";

const PRIORITY_OPTIONS: number[] = Array.from(
  { length: PRIORITY_MAX - PRIORITY_MIN + 1 },
  (_, i) => PRIORITY_MIN + i,
);

async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error("No active session. Please sign in again.");
  }
  return token;
}

/** Shared plumbing for authenticated API calls: attaches the bearer token,
 *  checks the HTTP status, and JSON-decodes the response. Callers are
 *  responsible for validating the shape of the decoded JSON themselves. */
async function authenticatedJsonRequest(
  url: string,
  options?: RequestInit,
): Promise<unknown> {
  const token = await getIdToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }

  return (await response.json()) as unknown;
}

/** A plausible starting reply, since the backend doesn't generate or store
 *  drafted reply text yet - this only exists client-side to make the
 *  drafted-reply panel editable. */
function defaultDraftReply(record: EmailRecord, signerName: string): string {
  const { name } = parseFrom(record.from);
  const firstName = name.split(" ")[0] || "there";
  const signer = signerName.split(" ")[0] || signerName;
  return `Hi ${firstName},\n\nThanks for the note — I'll take a look and get back to you shortly.\n\nBest,\n${signer}`;
}

interface SidebarProps {
  userName: string;
  counts: Record<QueueStatus, number>;
  activeQueue: QueueStatus;
  onSelectQueue: (queue: QueueStatus) => void;
  onSignOut: () => void;
}

const QUEUE_ORDER: { status: QueueStatus; label: string }[] = [
  { status: "needs-review", label: "Needs review" },
  { status: "approved", label: "Approved" },
  { status: "sent", label: "Sent" },
  { status: "rejected", label: "Rejected" },
];

function Sidebar({
  userName,
  counts,
  activeQueue,
  onSelectQueue,
  onSignOut,
}: SidebarProps): JSX.Element {
  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-mark">E</span>
        <span>Concierge</span>
      </div>
      <p className="sidebar-section-label">Queues</p>
      <ul className="sidebar-queues">
        {QUEUE_ORDER.map(({ status, label }) => (
          <li key={status}>
            <button
              type="button"
              className="sidebar-queue-btn"
              data-active={status === activeQueue}
              onClick={() => onSelectQueue(status)}
            >
              <span>{label}</span>
              <span className="sidebar-queue-count">{counts[status]}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer">
        <span className="sidebar-avatar">{initials(userName)}</span>
        <div className="sidebar-user">
          <span className="sidebar-user-name">{userName}</span>
          <span className="sidebar-user-role">Reviewer</span>
        </div>
        <button type="button" className="btn-ghost" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </nav>
  );
}

interface EmailListProps {
  title: string;
  emails: EmailRecord[];
  selectedId: string | null;
  onSelect: (messageId: string) => void;
  filter: ListFilter;
  onFilterChange: (filter: ListFilter) => void;
}

/** Filtering lives in the parent (ReviewQueue) so that queue-switching,
 *  approve/reject next-selection, and the detail-pane fallback all agree
 *  on which emails are actually visible - this component only renders. */
function EmailList({
  title,
  emails,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
}: EmailListProps): JSX.Element {
  return (
    <div className="email-list-pane">
      <div className="email-list-header">
        <h1 className="email-list-title">{title}</h1>
        <span className="email-list-count">{emails.length} emails</span>
      </div>
      <div className="filter-chips">
        <button
          type="button"
          className="filter-chip"
          data-active={filter === "all"}
          onClick={() => onFilterChange("all")}
        >
          All
        </button>
        <button
          type="button"
          className="filter-chip"
          data-active={filter === "high-confidence"}
          onClick={() => onFilterChange("high-confidence")}
        >
          High confidence
        </button>
        <button
          type="button"
          className="filter-chip"
          data-active={filter === "needs-attention"}
          onClick={() => onFilterChange("needs-attention")}
        >
          Needs attention
        </button>
      </div>
      <ul className="email-list">
        {emails.length === 0 ? (
          <li className="email-list-empty">Nothing here.</li>
        ) : (
          emails.map((record) => {
            const { name } = parseFrom(record.from);
            const match = Math.round(minConfidence(record) * 100);
            return (
              <li key={record.messageId}>
                <button
                  type="button"
                  className="email-list-item"
                  data-active={record.messageId === selectedId}
                  onClick={() => onSelect(record.messageId)}
                >
                  <div className="email-list-item-top">
                    <span className="email-list-item-from">{name}</span>
                    <span className="email-list-item-time">
                      {formatReceived(record.receivedAt)}
                    </span>
                  </div>
                  <div className="email-list-item-subject">
                    {record.subject || "(no subject)"}
                  </div>
                  <p className="email-list-item-snippet">{record.snippet}</p>
                  <div className="email-list-item-meta">
                    <span className="tag-chip">
                      {record.classification.contentTag}
                    </span>
                    <span
                      className="match-chip"
                      data-level={confidenceLevel(match / 100)}
                    >
                      {match}% match
                    </span>
                  </div>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

interface CorrectionBarProps {
  record: EmailRecord;
  onSaved: (updated: EmailRecord) => void;
}

/** Compact classification-correction control - the one thing this app
 *  actually persists to the backend. Kept in the detail header since the
 *  new layout has no other place for it. */
function CorrectionBar({ record, onSaved }: CorrectionBarProps): JSX.Element {
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
      const json = await authenticatedJsonRequest(
        apiUrlFor(`emails/${record.messageId}/correction`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      onSaved(EmailRecordSchema.parse(json));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Save failed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="correction-bar">
      <select
        aria-label="Response"
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
      <select
        aria-label="Tag"
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
      <select
        aria-label="Priority"
        value={priority}
        onChange={(e) => setPriority(Number(e.target.value))}
      >
        {PRIORITY_OPTIONS.map((option) => (
          <option key={option} value={option}>
            P{option}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn-ghost"
        onClick={() => void handleSave()}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save correction"}
      </button>
      {error ? <span className="correction-error">{error}</span> : null}
    </div>
  );
}

interface EmailDetailProps {
  record: EmailRecord;
  draftReply: string;
  onDraftChange: (messageId: string, text: string) => void;
  onSaved: (updated: EmailRecord) => void;
  onApproveAndSend: (messageId: string) => void;
  onReject: (messageId: string) => void;
}

function EmailDetail({
  record,
  draftReply,
  onDraftChange,
  onSaved,
  onApproveAndSend,
  onReject,
}: EmailDetailProps): JSX.Element {
  const { name, email } = parseFrom(record.from);
  const match = Math.round(minConfidence(record) * 100);

  return (
    <div className="detail-pane">
      <div className="detail-header">
        <div>
          <h1 className="detail-subject">{record.subject || "(no subject)"}</h1>
          <div className="detail-from">
            {name} · {email}
          </div>
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="btn-outline"
            onClick={() => onReject(record.messageId)}
          >
            Reject
          </button>
          <button
            type="button"
            className="btn-solid"
            onClick={() => onApproveAndSend(record.messageId)}
          >
            Approve &amp; send
          </button>
        </div>
      </div>

      <CorrectionBar record={record} onSaved={onSaved} />

      <div className="original-message">
        <div className="original-message-header">
          <span className="email-list-item-from">{initials(name)}</span>
          <span>
            {name} wrote · {formatReceived(record.receivedAt)}
          </span>
        </div>
        <p className="original-message-body">{record.bodyText}</p>
      </div>

      <div className="draft-panel">
        <div className="draft-panel-header">
          <span className="draft-panel-title">Drafted reply</span>
          <span className="draft-panel-note">
            {sourceLabel(record.classification.source)}
          </span>
          <span
            className="draft-panel-match"
            data-level={confidenceLevel(match / 100)}
          >
            {match}%
          </span>
        </div>
        <textarea
          className="draft-textarea"
          value={draftReply}
          onChange={(e) => onDraftChange(record.messageId, e.target.value)}
          rows={8}
        />
        <div className="draft-panel-tools">
          <button
            type="button"
            className="btn-outline"
            disabled
            title="Not implemented yet"
          >
            Shorter
          </button>
          <button
            type="button"
            className="btn-outline"
            disabled
            title="Not implemented yet"
          >
            Warmer
          </button>
          <button
            type="button"
            className="btn-outline"
            disabled
            title="Not implemented yet"
          >
            More formal
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReviewQueue(): JSX.Element {
  const [state, setState] = useState<LoadState>("loading");
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userName, setUserName] = useState("Reviewer");

  const [statusByEmail, setStatusByEmail] = useState<Map<string, QueueStatus>>(
    new Map(),
  );
  const [draftByEmail, setDraftByEmail] = useState<Map<string, string>>(
    new Map(),
  );
  const [activeQueue, setActiveQueue] = useState<QueueStatus>("needs-review");
  const [listFilter, setListFilter] = useState<ListFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [json, session] = await Promise.all([
          authenticatedJsonRequest(apiUrlFor("emails")),
          fetchAuthSession(),
        ]);
        const parsed = EmailRecordSchema.array().parse(json);
        const initialSort = sortByConfidence(parsed);

        if (!cancelled) {
          const idPayload = session.tokens?.idToken?.payload;
          const name =
            (typeof idPayload?.name === "string" && idPayload.name) ||
            (typeof idPayload?.email === "string" && idPayload.email) ||
            "Reviewer";

          setEmails(initialSort);
          setDraftByEmail(
            new Map(
              initialSort.map((record) => [
                record.messageId,
                defaultDraftReply(record, name),
              ]),
            ),
          );
          setSelectedId(initialSort[0]?.messageId ?? null);
          setUserName(name);
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

  const queueEmails = useMemo(
    () =>
      emails.filter(
        (e) =>
          (statusByEmail.get(e.messageId) ?? "needs-review") === activeQueue,
      ),
    [emails, statusByEmail, activeQueue],
  );

  /** The queue's emails further narrowed by the confidence chip - this is
   *  what's actually on screen, so it drives the list, next-selection after
   *  an action, and the detail-pane fallback alike. */
  const visibleEmails = useMemo(() => {
    if (listFilter === "high-confidence") {
      return queueEmails.filter(
        (e) => confidenceLevel(minConfidence(e)) === "high",
      );
    }
    if (listFilter === "needs-attention") {
      return queueEmails.filter(
        (e) => confidenceLevel(minConfidence(e)) !== "high",
      );
    }
    return queueEmails;
  }, [queueEmails, listFilter]);

  const counts = useMemo(() => {
    const result: Record<QueueStatus, number> = {
      "needs-review": 0,
      approved: 0,
      sent: 0,
      rejected: 0,
    };
    for (const record of emails) {
      const status = statusByEmail.get(record.messageId) ?? "needs-review";
      result[status] += 1;
    }
    return result;
  }, [emails, statusByEmail]);

  function handleSaved(updated: EmailRecord): void {
    setEmails((current) =>
      current.map((email) =>
        email.messageId === updated.messageId ? updated : email,
      ),
    );
  }

  function handleDraftChange(messageId: string, text: string): void {
    setDraftByEmail((current) => new Map(current).set(messageId, text));
  }

  /** Moves an email to a new queue and selects the next item so the detail
   *  pane doesn't go blank right after the action that just emptied it. */
  function moveToQueue(messageId: string, status: QueueStatus): void {
    setStatusByEmail((current) => new Map(current).set(messageId, status));
    setSelectedId((current) => {
      if (current !== messageId) return current;
      const remaining = visibleEmails.filter((e) => e.messageId !== messageId);
      return remaining[0]?.messageId ?? null;
    });
  }

  async function handleSignOut(): Promise<void> {
    await signOut();
  }

  const selectedRecord =
    visibleEmails.find((e) => e.messageId === selectedId) ??
    visibleEmails[0] ??
    null;

  const activeQueueLabel =
    QUEUE_ORDER.find((q) => q.status === activeQueue)?.label ?? "";

  return (
    <div className="app-shell">
      {state === "loading" ? (
        <p className="queue-status">Loading emails…</p>
      ) : null}
      {state === "error" ? (
        <p className="queue-status is-error">{error}</p>
      ) : null}

      {state === "ready" ? (
        <>
          <Sidebar
            userName={userName}
            counts={counts}
            activeQueue={activeQueue}
            onSelectQueue={(queue) => {
              setActiveQueue(queue);
              setSelectedId(null);
            }}
            onSignOut={() => void handleSignOut()}
          />
          <EmailList
            title={activeQueueLabel}
            emails={visibleEmails}
            selectedId={selectedRecord?.messageId ?? null}
            onSelect={setSelectedId}
            filter={listFilter}
            onFilterChange={setListFilter}
          />
          {selectedRecord ? (
            <EmailDetail
              key={selectedRecord.messageId}
              record={selectedRecord}
              draftReply={draftByEmail.get(selectedRecord.messageId) ?? ""}
              onDraftChange={handleDraftChange}
              onSaved={handleSaved}
              onApproveAndSend={(id) => moveToQueue(id, "sent")}
              onReject={(id) => moveToQueue(id, "rejected")}
            />
          ) : (
            <div className="detail-pane detail-empty">
              Nothing to review right now.
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
