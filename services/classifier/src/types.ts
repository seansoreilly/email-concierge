import type { Classification } from "@email-concierge/shared/types.ts";

export interface ClassifierInput {
  subject: string;
  bodyText: string;
  from: string;
  /** Optional raw email headers, used by the heuristic pre-filter. */
  headers?: {
    listUnsubscribe?: string;
    precedence?: string;
  };
}

export interface Classifier {
  classify(email: ClassifierInput): Promise<Classification>;
}

/** Thrown by JevClassifier when the OpenRouter response doesn't match the expected shape, so CascadingClassifier can fall back to Haiku cleanly. */
export class JevResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JevResponseError";
  }
}
