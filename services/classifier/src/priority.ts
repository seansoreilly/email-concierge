import { PRIORITY_MAX, PRIORITY_MIN } from "@email-concierge/shared/types.ts";

/** Rounds to the nearest integer and clamps to the Priority range (PRIORITY_MIN-PRIORITY_MAX), shared by JevClassifier and HaikuClassifier. */
export function clampPriority(value: number): number {
  const rounded = Math.round(value);
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, rounded));
}
