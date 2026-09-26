import {
  type Classification,
  ContentTag,
  ResponseState,
} from "@email-concierge/shared/types.ts";
import { z } from "zod";
import { clampPriority } from "./priority.ts";
import type { Classifier, ClassifierInput } from "./types.ts";
import { JevResponseError } from "./types.ts";

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const JEV_MODEL = "typesafe/jev-1.13";

// Confirmed via direct fetch of openrouter.ai's decisions API reference (submit-a-decisions-questions-and-answers-request):
// choice answers carry {type, choice, confidence, probabilities}; score answers carry {type, score, confidence, probabilities, legend}.
const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()),
});

const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()),
  // Confirmed live against the real endpoint: score/probabilities are indices into `criteria`
  // (0..8 here), and `legend` maps each index back to the criterion label ("2".."10") -
  // score is NOT already on the 2-10 priority scale, so it must be resolved via legend.
  legend: z.record(z.string(), z.string()).optional(),
});

const DecisionsResponse = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  answers: z.object({
    response_state: ChoiceAnswer,
    content_tag: ChoiceAnswer,
    priority: ScoreAnswer,
  }),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

interface JevClassifierOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class JevClassifier implements Classifier {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: JevClassifierOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async classify(email: ClassifierInput): Promise<Classification> {
    if (!this.apiKey) {
      throw new JevResponseError(
        "OPENROUTER_API_KEY is not set; cannot call Jev.",
      );
    }

    const state = {
      from: email.from,
      subject: email.subject,
      bodyText: email.bodyText,
    };

    const body = {
      model: JEV_MODEL,
      state,
      questions: {
        response_state: {
          type: "choice",
          instructions:
            "Classify the email's response state: does it need a reply, is it awaiting one, is it just FYI, or is it fully done?",
          criteria: Object.fromEntries(
            ResponseState.options.map((option) => [option, option]),
          ),
        },
        content_tag: {
          type: "choice",
          instructions:
            "Classify the email's content type into exactly one tag.",
          criteria: Object.fromEntries(
            ContentTag.options.map((option) => [option, option]),
          ),
        },
        priority: {
          type: "score",
          instructions:
            "Score how urgent/important this email is on a 2 (lowest) to 10 (highest) scale.",
          criteria: Array.from({ length: 9 }, (_, i) => String(i + 2)),
        },
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(OPENROUTER_DECISIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new JevResponseError(
        `Jev request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new JevResponseError(
        `Jev returned HTTP ${response.status}: ${await response.text().catch(() => "<no body>")}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new JevResponseError("Jev response was not valid JSON.", {
        cause: error,
      });
    }

    const parsed = DecisionsResponse.safeParse(json);
    if (!parsed.success) {
      throw new JevResponseError(
        `Jev response did not match the expected schema: ${parsed.error.message}`,
      );
    }

    return this.toClassification(parsed.data);
  }

  private toClassification(
    data: z.infer<typeof DecisionsResponse>,
  ): Classification {
    const responseStateResult = ResponseState.safeParse(
      data.answers.response_state.choice,
    );
    if (!responseStateResult.success) {
      throw new JevResponseError(
        `Jev returned an unrecognized response_state choice: ${data.answers.response_state.choice}`,
      );
    }

    const contentTagResult = ContentTag.safeParse(
      data.answers.content_tag.choice,
    );
    if (!contentTagResult.success) {
      throw new JevResponseError(
        `Jev returned an unrecognized content_tag choice: ${data.answers.content_tag.choice}`,
      );
    }

    return {
      responseState: responseStateResult.data,
      responseStateConfidence: data.answers.response_state.confidence,
      contentTag: contentTagResult.data,
      contentTagConfidence: data.answers.content_tag.confidence,
      priority: this.resolvePriority(data.answers.priority),
      priorityConfidence: data.answers.priority.confidence,
      source: "jev",
    };
  }

  /** Resolves a Score answer's priority via its index legend when present (score is an index into `criteria`, not the label itself - see the ScoreAnswer comment); falls back to treating score as already label-scaled if legend is absent. */
  private resolvePriority(priorityAnswer: z.infer<typeof ScoreAnswer>): number {
    const legend = priorityAnswer.legend;
    if (legend) {
      const index = String(Math.round(priorityAnswer.score));
      const label = legend[index];
      if (label !== undefined) {
        const asNumber = Number(label);
        if (!Number.isNaN(asNumber)) {
          return clampPriority(asNumber);
        }
      }
    }
    return clampPriority(priorityAnswer.score);
  }
}
