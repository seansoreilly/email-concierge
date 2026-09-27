import type { EmailRecord } from "@email-concierge/shared";

export interface ConfidenceField {
  name: string;
  value: number;
}

/** The three independent confidences, in the order the gauge displays them. */
export function confidenceFields(record: EmailRecord): ConfidenceField[] {
  const c = record.classification;
  return [
    { name: "Response", value: c.responseStateConfidence },
    { name: "Tag", value: c.contentTagConfidence },
    { name: "Priority", value: c.priorityConfidence },
  ];
}

/** Lowest of the three per-field confidences - the value the review queue sorts by. */
export function minConfidence(record: EmailRecord): number {
  return Math.min(...confidenceFields(record).map((f) => f.value));
}

export function confidenceLevel(value: number): "low" | "mid" | "high" {
  if (value < 0.5) return "low";
  if (value < 0.8) return "mid";
  return "high";
}

export function sourceLabel(
  source: EmailRecord["classification"]["source"],
): string {
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

/** Compact relative timestamp for the list row: time-of-day today, "Yest"
 *  yesterday, weekday name within the last week, else a short date. */
export function formatReceived(
  receivedAt: string,
  now: Date = new Date(),
): string {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) {
    return receivedAt;
  }

  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round(
    (startOfDay(now) - startOfDay(date)) / (24 * 60 * 60 * 1000),
  );

  if (daysAgo === 0) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  if (daysAgo === 1) {
    return "Yest";
  }
  if (daysAgo > 1 && daysAgo < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
      date,
    );
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Splits a "from" header into a display name and address, tolerating a
 *  bare address (fixture data) or the RFC 5322 "Name <addr>" form (real Gmail). */
export function parseFrom(from: string): { name: string; email: string } {
  const match = from.match(/^\s*(.*?)\s*<(.+)>\s*$/);
  if (match) {
    const name = match[1] ?? "";
    const email = match[2] ?? from;
    const cleanedName = name.replace(/^"|"$/g, "");
    return { name: cleanedName || email, email };
  }
  return { name: from, email: from };
}

/** Up to two initials from a display name, for the avatar badge. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

/** Lowest-confidence-first - the review queue's initial sort order. */
export function sortByConfidence(records: EmailRecord[]): EmailRecord[] {
  return [...records].sort((a, b) => minConfidence(a) - minConfidence(b));
}
