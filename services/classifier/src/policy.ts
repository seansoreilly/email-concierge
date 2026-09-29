import type {
  Classification,
  PlannedAction,
} from "@email-concierge/shared/types.ts";

/** Priority at or above this always keeps the email in the inbox. */
export const KEEP_MIN_PRIORITY = 5;
/** Archive requires priority at or below this. */
export const ARCHIVE_MAX_PRIORITY = 3;
/** Non-heuristic archive requires every confidence at or above this. */
export const ARCHIVE_MIN_CONFIDENCE = 0.9;

/**
 * Shadow-mode inbox policy v1. Pure. Conservative by design: a missed
 * important email costs far more than clutter, so anything not explicitly
 * safe to archive is kept.
 */
export function decideAction(classification: Classification): PlannedAction {
  const c = classification;

  if (
    c.responseState === "To Respond" ||
    c.responseState === "Awaiting Reply"
  ) {
    return { action: "keep", reason: `Response state is ${c.responseState}` };
  }
  if (c.priority >= KEEP_MIN_PRIORITY) {
    return {
      action: "keep",
      reason: `Priority ${c.priority} is at or above ${KEEP_MIN_PRIORITY}`,
    };
  }
  if (c.contentTag !== "Bulk/Marketing") {
    return {
      action: "keep",
      reason: `Content tag is ${c.contentTag}, not Bulk/Marketing`,
    };
  }
  if (c.responseState !== "Done") {
    return {
      action: "keep",
      reason: `Response state is ${c.responseState}, not Done`,
    };
  }
  if (c.priority > ARCHIVE_MAX_PRIORITY) {
    return {
      action: "keep",
      reason: `Priority ${c.priority} is above archive limit ${ARCHIVE_MAX_PRIORITY}`,
    };
  }
  if (c.source === "heuristic") {
    return {
      action: "archive",
      reason: "Bulk/Marketing, Done, low priority (deterministic heuristic)",
    };
  }
  const minConfidence = Math.min(
    c.responseStateConfidence,
    c.contentTagConfidence,
    c.priorityConfidence,
  );
  if (minConfidence >= ARCHIVE_MIN_CONFIDENCE) {
    return {
      action: "archive",
      reason: `Bulk/Marketing, Done, low priority, all confidences >= ${ARCHIVE_MIN_CONFIDENCE}`,
    };
  }
  return {
    action: "keep",
    reason: `Confidence ${minConfidence} below ${ARCHIVE_MIN_CONFIDENCE} for non-heuristic classification`,
  };
}
