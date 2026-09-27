/** Rounds to the nearest integer and clamps to the Priority range (2-10), shared by JevClassifier and HaikuClassifier. */
export function clampPriority(value: number): number {
  const rounded = Math.round(value);
  return Math.min(10, Math.max(2, rounded));
}
