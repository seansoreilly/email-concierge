// Renders two static HTML pages that reproduce the review queue's markup
// and CSS exactly (see web/src/ReviewQueue.tsx + web/src/styles.css),
// populated ONLY with the 13 synthetic fixtures from shared/fixtures/emails.ts.
// This exists because the live app's list API has no fixture-only filter
// (services/api-lambda/src/index.ts does an unfiltered ScanCommand), so any
// screenshot of the real deployed app risks mixing in real inbox rows. These
// pages never touch DynamoDB, Cognito, or the live app - just fixture data
// through the same HTML/CSS the real app renders.
import { readFileSync, writeFileSync } from "node:fs";
import { records, sortByConfidence } from "./build-data.mjs";

function confidenceLevel(value) {
  if (value < 0.5) return "low";
  if (value < 0.8) return "mid";
  return "high";
}

function sourceLabel(source) {
  switch (source) {
    case "jev":
      return "Classified by Jev";
    case "haiku":
      return "Classified by Haiku (fallback)";
    case "heuristic":
      return "Sorted by rule";
    case "human":
      return "Corrected by you";
    default:
      return "";
  }
}

function formatReceived(receivedAt) {
  const date = new Date(receivedAt);
  const now = new Date("2026-09-27T12:00:00Z");
  const startOfDay = (d) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (daysAgo === 0)
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  if (daysAgo === 1) return "Yest";
  if (daysAgo > 1 && daysAgo < 7)
    return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
      date,
    );
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function minConfidence(r) {
  const c = r.classification;
  return Math.min(
    c.responseStateConfidence,
    c.contentTagConfidence,
    c.priorityConfidence,
  );
}

const sorted = sortByConfidence(records);

function listItemHtml(r, activeId) {
  const match = Math.round(minConfidence(r) * 100);
  const snippet = r.bodyText.split("\n").find((l) => l.trim().length > 0) ?? "";
  return `
    <li>
      <button type="button" class="email-list-item" data-active="${r.messageId === activeId}">
        <div class="email-list-item-top">
          <span class="email-list-item-from">${esc(r.from)}</span>
          <span class="email-list-item-time">${esc(formatReceived(r.receivedAt))}</span>
        </div>
        <div class="email-list-item-subject">${esc(r.subject)}</div>
        <p class="email-list-item-snippet">${esc(snippet)}</p>
        <div class="email-list-item-meta">
          <span class="tag-chip">${esc(r.classification.contentTag)}</span>
          <span class="match-chip" data-level="${confidenceLevel(match / 100)}">${match}% match</span>
        </div>
      </button>
    </li>`;
}

function detailHtml(r, draftSigner) {
  const match = Math.round(minConfidence(r) * 100);
  const firstName = r.from.split("@")[0] ?? "there";
  return `
    <div class="detail-pane">
      <div class="detail-header">
        <div>
          <h1 class="detail-subject">${esc(r.subject)}</h1>
          <div class="detail-from">${esc(r.from)} · ${esc(r.from)}</div>
        </div>
        <div class="detail-actions">
          <button type="button" class="btn-outline">Reject</button>
          <button type="button" class="btn-solid">Approve &amp; send</button>
        </div>
      </div>
      <div class="correction-bar">
        <select aria-label="Response" disabled><option>${esc(r.classification.responseState)}</option></select>
        <select aria-label="Tag" disabled><option>${esc(r.classification.contentTag)}</option></select>
        <select aria-label="Priority" disabled><option>P${r.classification.priority}</option></select>
        <button type="button" class="btn-ghost">Save correction</button>
      </div>
      <div class="original-message">
        <div class="original-message-header">
          <span class="email-list-item-from">${esc(initials(r.from))}</span>
          <span>${esc(r.from)} wrote · ${esc(formatReceived(r.receivedAt))}</span>
        </div>
        <p class="original-message-body">${esc(r.bodyText)}</p>
      </div>
      <div class="draft-panel">
        <div class="draft-panel-header">
          <span class="draft-panel-title">Drafted reply</span>
          <span class="draft-panel-note">${esc(sourceLabel(r.classification.source))}</span>
          <span class="draft-panel-match" data-level="${confidenceLevel(match / 100)}">${match}%</span>
        </div>
        <textarea class="draft-textarea" rows="8">Hi ${esc(firstName)},

Thanks for the note — I'll take a look and get back to you shortly.

Best,
${esc(draftSigner)}</textarea>
        <div class="draft-panel-tools">
          <button type="button" class="btn-outline" disabled title="Not implemented yet">Shorter</button>
          <button type="button" class="btn-outline" disabled title="Not implemented yet">Warmer</button>
          <button type="button" class="btn-outline" disabled title="Not implemented yet">More formal</button>
        </div>
      </div>
    </div>`;
}

function pageHtml(activeId, draftSigner) {
  const css = readFileSync(
    new URL("../../../web/src/styles.css", import.meta.url),
    "utf8",
  );
  const active = records.find((r) => r.messageId === activeId);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>${css}
/* mockup-only: hide dark-mode media query so captures are deterministic regardless of the renderer's OS theme */
</style>
</head>
<body>
<div class="app-shell" style="height:900px">
  <div class="sidebar">
    <div class="sidebar-brand"><span class="sidebar-mark">E</span> Concierge</div>
    <div class="sidebar-section-label">Queues</div>
    <ul class="sidebar-queues">
      <li><button type="button" class="sidebar-queue-btn" data-active="true">Needs review <span class="sidebar-queue-count">${records.length}</span></button></li>
      <li><button type="button" class="sidebar-queue-btn">Approved <span class="sidebar-queue-count">0</span></button></li>
      <li><button type="button" class="sidebar-queue-btn">Sent <span class="sidebar-queue-count">0</span></button></li>
      <li><button type="button" class="sidebar-queue-btn">Rejected <span class="sidebar-queue-count">0</span></button></li>
    </ul>
    <div class="sidebar-footer">
      <span class="sidebar-avatar">RV</span>
      <div class="sidebar-user"><span class="sidebar-user-name">reviewer@example.com</span><span class="sidebar-user-role">Reviewer</span></div>
      <button type="button" class="btn-ghost">Sign out</button>
    </div>
  </div>
  <div class="email-list-pane">
    <div class="email-list-header">
      <h1 class="email-list-title">Needs review</h1>
      <span class="email-list-count">${records.length} emails</span>
    </div>
    <div class="filter-chips">
      <button type="button" class="filter-chip" data-active="true">All</button>
      <button type="button" class="filter-chip">High confidence</button>
      <button type="button" class="filter-chip">Needs attention</button>
    </div>
    <ul class="email-list">
      ${sorted.map((r) => listItemHtml(r, activeId)).join("\n")}
    </ul>
  </div>
  ${detailHtml(active, draftSigner)}
</div>
</body></html>`;
}

writeFileSync(
  new URL("./detail.html", import.meta.url),
  pageHtml("fixture-001", "J. Reviewer"),
);
writeFileSync(
  new URL("./awaitingreply.html", import.meta.url),
  pageHtml("fixture-008", "J. Reviewer"),
);
console.log("Wrote detail.html and awaitingreply.html");
