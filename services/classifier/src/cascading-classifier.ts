import type { Classification } from "@email-concierge/shared/types.ts";
import { classifyByHeuristic } from "./heuristic-filter.ts";
import type { Classifier, ClassifierInput } from "./types.ts";

interface CascadingClassifierOptions {
  primary: Classifier;
  fallback: Classifier;
}

/** Tries the heuristic pre-filter, then the primary classifier (Jev), falling back to the secondary (Haiku) on any error. */
export class CascadingClassifier implements Classifier {
  private readonly primary: Classifier;
  private readonly fallback: Classifier;

  constructor(options: CascadingClassifierOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
  }

  async classify(email: ClassifierInput): Promise<Classification> {
    const heuristicResult = classifyByHeuristic(email);
    if (heuristicResult) {
      return heuristicResult;
    }

    try {
      return await this.primary.classify(email);
    } catch {
      // Primary (Jev) errored or timed out - fall back to the secondary (Haiku) so a
      // TypeSafe AI outage doesn't take down classification entirely.
      return await this.fallback.classify(email);
    }
  }
}
