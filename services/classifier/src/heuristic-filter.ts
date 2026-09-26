import type { Classification } from "@email-concierge/shared/types.ts";
import type { ClassifierInput } from "./types.ts";

const NEWSLETTER_KEYWORDS = ["newsletter", "digest", "weekly", "roundup"];

/**
 * Skips obvious bulk mail before any model call, based on List-Unsubscribe / Precedence headers.
 * Returns null when the email doesn't look like bulk mail, so the caller falls through to a model.
 */
export function classifyByHeuristic(
  email: ClassifierInput,
): Classification | null {
  const headers = email.headers;
  if (!headers) {
    return null;
  }

  // Require List-Unsubscribe, not Precedence:bulk alone - a bare "Precedence: bulk" (e.g. an
  // internal workspace digest) is too weak a signal on its own and misfires on legitimate FYI mail.
  const isBulk = Boolean(headers.listUnsubscribe);
  if (!isBulk) {
    return null;
  }

  const haystack = `${email.subject} ${email.from}`.toLowerCase();
  const looksLikeNewsletter = NEWSLETTER_KEYWORDS.some((keyword) =>
    haystack.includes(keyword),
  );

  return {
    responseState: "Done",
    responseStateConfidence: 1,
    contentTag: looksLikeNewsletter ? "Newsletter" : "Bulk/Marketing",
    contentTagConfidence: 1,
    priority: 2,
    priorityConfidence: 1,
    source: "heuristic",
  };
}
