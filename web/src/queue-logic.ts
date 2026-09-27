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

export function formatReceived(receivedAt: string): string {
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

/** Lowest-confidence-first - the review queue's initial sort order. */
export function sortByConfidence(records: EmailRecord[]): EmailRecord[] {
  return [...records].sort((a, b) => minConfidence(a) - minConfidence(b));
}
