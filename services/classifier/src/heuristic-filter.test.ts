import { fixtureEmails } from "@email-concierge/shared/fixtures/emails.ts";
import { describe, expect, it } from "vitest";
import { classifyByHeuristic } from "./heuristic-filter.ts";

describe("classifyByHeuristic", () => {
  it("returns null when there are no headers", () => {
    const result = classifyByHeuristic({
      from: "a@example.com",
      subject: "hi",
      bodyText: "hi",
    });
    expect(result).toBeNull();
  });

  it("returns null when Precedence: bulk is set without List-Unsubscribe", () => {
    const result = classifyByHeuristic({
      from: "team-updates@project-tool.com",
      subject: "Weekly digest: 14 updates in your workspace",
      bodyText: "...",
      headers: { precedence: "bulk" },
    });
    expect(result).toBeNull();
  });

  it("classifies as Bulk/Marketing when List-Unsubscribe is present and no newsletter keyword matches", () => {
    const result = classifyByHeuristic({
      from: "marketing@bigretailer.com",
      subject: "Fall Sale: 40% off everything",
      bodyText: "...",
      headers: { listUnsubscribe: "<mailto:unsub@bigretailer.com>" },
    });
    expect(result?.responseState).toBe("Done");
    expect(result?.contentTag).toBe("Bulk/Marketing");
    expect(result?.source).toBe("heuristic");
  });

  it("classifies as Newsletter when a newsletter keyword matches", () => {
    const result = classifyByHeuristic({
      from: "digest@techweekly.com",
      subject: "This Week in Tech: 12 stories",
      bodyText: "...",
      headers: { listUnsubscribe: "<mailto:unsub@techweekly.com>" },
    });
    expect(result?.contentTag).toBe("Newsletter");
  });

  it("matches every fixture email's expected label when the heuristic fires", () => {
    for (const fixture of fixtureEmails) {
      const result = classifyByHeuristic(fixture);
      if (result) {
        expect(result.responseState).toBe(fixture.expected.responseState);
        expect(result.contentTag).toBe(fixture.expected.contentTag);
      }
    }
  });
});
