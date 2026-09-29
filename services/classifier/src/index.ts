import { CascadingClassifier } from "./cascading-classifier.ts";
import { HaikuClassifier } from "./haiku-classifier.ts";
import { JevClassifier } from "./jev-classifier.ts";

export { CascadingClassifier } from "./cascading-classifier.ts";
export { HaikuClassifier } from "./haiku-classifier.ts";
export { classifyByHeuristic } from "./heuristic-filter.ts";
export { JevClassifier } from "./jev-classifier.ts";
export {
  ARCHIVE_MAX_PRIORITY,
  ARCHIVE_MIN_CONFIDENCE,
  decideAction,
  KEEP_MIN_PRIORITY,
} from "./policy.ts";
export { clampPriority } from "./priority.ts";
export type { Classifier, ClassifierInput } from "./types.ts";
export { JevResponseError } from "./types.ts";

/** Default production wiring: Jev primary, Haiku fallback, heuristic pre-filter for bulk mail. */
export function createDefaultClassifier(): CascadingClassifier {
  return new CascadingClassifier({
    primary: new JevClassifier(),
    fallback: new HaikuClassifier(),
  });
}
