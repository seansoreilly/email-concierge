import type { EmailRecord } from "@email-concierge/shared";
import { describe, expect, it } from "vitest";
import {
  confidenceFields,
  confidenceLevel,
  formatReceived,
  initials,
  minConfidence,
  parseFrom,
  sortByConfidence,
  sourceLabel,
} from "./queue-logic";

function buildRecord(overrides: {
  messageId: string;
  responseStateConfidence: number;
  contentTagConfidence: number;
  priorityConfidence: number;
}): EmailRecord {
  return {
    messageId: overrides.messageId,
    threadId: `thread-${overrides.messageId}`,
    from: "sender@example.com",
    subject: "Subject",
    snippet: "Snippet",
    bodyText: "Body",
    receivedAt: "2026-09-27T00:00:00.000Z",
    classification: {
      responseState: "To Respond",
      responseStateConfidence: overrides.responseStateConfidence,
      contentTag: "Work",
      contentTagConfidence: overrides.contentTagConfidence,
      priority: 5,
      priorityConfidence: overrides.priorityConfidence,
      source: "jev",
    },
    appliedLabelIds: [],
    draftCreated: false,
    isFixture: false,
    corrections: [],
  };
}

describe("confidenceFields", () => {
  it("returns the three confidences in gauge display order", () => {
    const record = buildRecord({
      messageId: "1",
      responseStateConfidence: 0.9,
      contentTagConfidence: 0.6,
      priorityConfidence: 0.3,
    });

    expect(confidenceFields(record)).toEqual([
      { name: "Response", value: 0.9 },
      { name: "Tag", value: 0.6 },
      { name: "Priority", value: 0.3 },
    ]);
  });
});

describe("minConfidence", () => {
  it("returns the lowest of the three per-field confidences", () => {
    const record = buildRecord({
      messageId: "1",
      responseStateConfidence: 0.9,
      contentTagConfidence: 0.6,
      priorityConfidence: 0.3,
    });

    expect(minConfidence(record)).toBe(0.3);
  });
});

describe("confidenceLevel", () => {
  it("classifies below 0.5 as low", () => {
    expect(confidenceLevel(0.49)).toBe("low");
  });

  it("classifies 0.5 up to below 0.8 as mid", () => {
    expect(confidenceLevel(0.5)).toBe("mid");
    expect(confidenceLevel(0.79)).toBe("mid");
  });

  it("classifies 0.8 and above as high", () => {
    expect(confidenceLevel(0.8)).toBe("high");
    expect(confidenceLevel(1)).toBe("high");
  });
});

describe("sourceLabel", () => {
  it("labels every classification source", () => {
    expect(sourceLabel("jev")).toBe("Classified by Jev");
    expect(sourceLabel("haiku")).toBe("Classified by Haiku (fallback)");
    expect(sourceLabel("heuristic")).toBe("Sorted by rule");
    expect(sourceLabel("human")).toBe("Corrected by you");
  });
});

describe("formatReceived", () => {
  // Noon UTC falls on the same calendar day in every zone from UTC-11 to
  // UTC+11, so these fixtures are timezone-safe wherever the tests run.
  const now = new Date("2026-09-27T12:00:00.000Z");

  it("formats today's timestamp as a time of day", () => {
    const formatted = formatReceived("2026-09-27T12:00:00.000Z", now);
    expect(formatted).not.toBe("2026-09-27T12:00:00.000Z");
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("formats yesterday as 'Yest'", () => {
    expect(formatReceived("2026-09-26T12:00:00.000Z", now)).toBe("Yest");
  });

  it("formats within the last week as a weekday name", () => {
    const formatted = formatReceived("2026-09-23T12:00:00.000Z", now);
    expect(formatted).not.toBe("Yest");
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("formats older dates as a short date", () => {
    const formatted = formatReceived("2026-01-01T12:00:00.000Z", now);
    expect(formatted).toContain("Jan");
  });

  it("falls back to the raw string for an unparseable timestamp", () => {
    expect(formatReceived("not-a-date", now)).toBe("not-a-date");
  });
});

describe("parseFrom", () => {
  it("splits 'Name <addr>' form", () => {
    expect(parseFrom("Priya Raman <priya@northwind.co>")).toEqual({
      name: "Priya Raman",
      email: "priya@northwind.co",
    });
  });

  it("strips quotes around the display name", () => {
    expect(parseFrom('"Priya Raman" <priya@northwind.co>')).toEqual({
      name: "Priya Raman",
      email: "priya@northwind.co",
    });
  });

  it("treats a bare address as both name and email", () => {
    expect(parseFrom("sarah.chen@example.com")).toEqual({
      name: "sarah.chen@example.com",
      email: "sarah.chen@example.com",
    });
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Priya Raman")).toBe("PR");
  });

  it("takes the first two letters of a single word", () => {
    expect(initials("sarah.chen@example.com")).toBe("SA");
  });
});

describe("sortByConfidence", () => {
  it("sorts records lowest-min-confidence first", () => {
    const high = buildRecord({
      messageId: "high",
      responseStateConfidence: 0.95,
      contentTagConfidence: 0.9,
      priorityConfidence: 0.85,
    });
    const low = buildRecord({
      messageId: "low",
      responseStateConfidence: 0.4,
      contentTagConfidence: 0.9,
      priorityConfidence: 0.9,
    });
    const mid = buildRecord({
      messageId: "mid",
      responseStateConfidence: 0.7,
      contentTagConfidence: 0.9,
      priorityConfidence: 0.9,
    });

    const sorted = sortByConfidence([high, low, mid]);

    expect(sorted.map((r) => r.messageId)).toEqual(["low", "mid", "high"]);
  });

  it("does not mutate the input array", () => {
    const a = buildRecord({
      messageId: "a",
      responseStateConfidence: 0.9,
      contentTagConfidence: 0.9,
      priorityConfidence: 0.9,
    });
    const b = buildRecord({
      messageId: "b",
      responseStateConfidence: 0.1,
      contentTagConfidence: 0.9,
      priorityConfidence: 0.9,
    });
    const input = [a, b];

    sortByConfidence(input);

    expect(input).toEqual([a, b]);
  });
});
