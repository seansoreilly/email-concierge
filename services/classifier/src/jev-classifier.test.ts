import { describe, expect, it } from "vitest";
import { JevClassifier } from "./jev-classifier.ts";
import { JevResponseError } from "./types.ts";

const SAMPLE_EMAIL = {
  from: "sarah.chen@example.com",
  subject: "Can you review the Q3 roadmap doc before Friday?",
  bodyText: "Hey, wanted to check if you had a chance to look at the doc...",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Legend/probabilities keyed by index ("0".."8"), not by label - confirmed via a live smoke
// test against the real decisions endpoint (score 6.64 came back with legend {"7": "9", ...}).
const PRIORITY_LEGEND = {
  "0": "2",
  "1": "3",
  "2": "4",
  "3": "5",
  "4": "6",
  "5": "7",
  "6": "8",
  "7": "9",
  "8": "10",
};

function validDecisionsBody() {
  return {
    id: "dec_123",
    model: "typesafe/jev-1.13",
    provider: "typesafe",
    answers: {
      response_state: {
        type: "choice",
        choice: "To Respond",
        confidence: 0.91,
        probabilities: {
          "To Respond": 0.91,
          "Awaiting Reply": 0.03,
          FYI: 0.03,
          Done: 0.03,
        },
      },
      content_tag: {
        type: "choice",
        choice: "Work",
        confidence: 0.85,
        probabilities: { Work: 0.85, Personal: 0.15 },
      },
      priority: {
        type: "score",
        score: 6.64, // index-scaled: rounds to index 7 -> legend["7"] -> "9"
        confidence: 0.72,
        probabilities: { "5": 0.08, "6": 0.27, "7": 0.5, "8": 0.14 },
        legend: PRIORITY_LEGEND,
      },
    },
    usage: { input_tokens: 120, output_tokens: 40, cost: 0.0001 },
  };
}

describe("JevClassifier - response parsing (mocked HTTP, no live network)", () => {
  it("parses a well-formed decisions response into a Classification, resolving priority via the index legend", async () => {
    const fetchImpl = async () => jsonResponse(200, validDecisionsBody());
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    const result = await classifier.classify(SAMPLE_EMAIL);

    expect(result).toEqual({
      responseState: "To Respond",
      responseStateConfidence: 0.91,
      contentTag: "Work",
      contentTagConfidence: 0.85,
      priority: 9, // score 6.64 rounds to index 7 -> legend["7"] -> "9"
      priorityConfidence: 0.72,
      source: "jev",
    });
  });

  it("resolves the lowest legend index to priority 2", async () => {
    const body = validDecisionsBody();
    body.answers.priority.score = 0; // index 0 -> legend["0"] -> "2"
    const fetchImpl = async () => jsonResponse(200, body);
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    const result = await classifier.classify(SAMPLE_EMAIL);

    expect(result.priority).toBe(2);
  });

  it("resolves the highest legend index to priority 10", async () => {
    const body = validDecisionsBody();
    body.answers.priority.score = 8; // index 8 -> legend["8"] -> "10"
    const fetchImpl = async () => jsonResponse(200, body);
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    const result = await classifier.classify(SAMPLE_EMAIL);

    expect(result.priority).toBe(10);
  });

  it("falls back to treating score as label-scaled and clamps when legend is absent", async () => {
    const body = validDecisionsBody();
    // @ts-expect-error - deliberately omitting legend to exercise the fallback path
    body.answers.priority.legend = undefined;
    body.answers.priority.score = 12.4; // no legend - treated as already label-scaled, then clamped
    const fetchImpl = async () => jsonResponse(200, body);
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    const result = await classifier.classify(SAMPLE_EMAIL);

    expect(result.priority).toBe(10);
  });

  it("throws JevResponseError when the response is missing the answers field", async () => {
    const fetchImpl = async () => jsonResponse(200, { id: "dec_123" });
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    await expect(classifier.classify(SAMPLE_EMAIL)).rejects.toBeInstanceOf(
      JevResponseError,
    );
  });

  it("throws JevResponseError when a choice answer has an unrecognized value", async () => {
    const body = validDecisionsBody();
    body.answers.response_state.choice = "Not A Real State";
    const fetchImpl = async () => jsonResponse(200, body);
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    await expect(classifier.classify(SAMPLE_EMAIL)).rejects.toBeInstanceOf(
      JevResponseError,
    );
  });

  it("throws JevResponseError on a non-2xx HTTP response", async () => {
    const fetchImpl = async () =>
      new Response("Internal Server Error", { status: 500 });
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    await expect(classifier.classify(SAMPLE_EMAIL)).rejects.toBeInstanceOf(
      JevResponseError,
    );
  });

  it("throws JevResponseError when the response body is not valid JSON", async () => {
    const fetchImpl = async () =>
      new Response("not json", { status: 200, headers: {} });
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    await expect(classifier.classify(SAMPLE_EMAIL)).rejects.toBeInstanceOf(
      JevResponseError,
    );
  });

  it("throws JevResponseError when no API key is configured", async () => {
    const classifier = new JevClassifier({ apiKey: undefined });

    await expect(classifier.classify(SAMPLE_EMAIL)).rejects.toBeInstanceOf(
      JevResponseError,
    );
  });

  it("sends one batched call carrying all three questions", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, validDecisionsBody());
    };
    const classifier = new JevClassifier({ apiKey: "test-key", fetchImpl });

    await classifier.classify(SAMPLE_EMAIL);

    expect(capturedBody?.model).toBe("typesafe/jev-1.13");
    const questions = capturedBody?.questions as Record<string, unknown>;
    expect(Object.keys(questions)).toEqual([
      "response_state",
      "content_tag",
      "priority",
    ]);
    const priorityQuestion = questions.priority as {
      type: string;
      criteria: string[];
    };
    expect(priorityQuestion.type).toBe("score");
    expect(priorityQuestion.criteria).toHaveLength(9);
  });
});
