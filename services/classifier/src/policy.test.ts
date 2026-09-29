import type { Classification } from "@email-concierge/shared/types.ts";
import {
  ContentTag,
  PRIORITY_MAX,
  PRIORITY_MIN,
  ResponseState,
} from "@email-concierge/shared/types.ts";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_MAX_PRIORITY,
  ARCHIVE_MIN_CONFIDENCE,
  KEEP_MIN_PRIORITY,
  decideAction,
} from "./policy.ts";

const archivable: Classification = {
  responseState: "Done",
  responseStateConfidence: 0.95,
  contentTag: "Bulk/Marketing",
  contentTagConfidence: 0.95,
  priority: 2,
  priorityConfidence: 0.95,
  source: "jev",
};

function make(overrides: Partial<Classification>): Classification {
  return { ...archivable, ...overrides };
}

const lowConf = {
  responseStateConfidence: 0.1,
  contentTagConfidence: 0.1,
  priorityConfidence: 0.1,
};

describe("decideAction", () => {
  it("has the expected thresholds", () => {
    expect(KEEP_MIN_PRIORITY).toBe(5);
    expect(ARCHIVE_MAX_PRIORITY).toBe(3);
    expect(ARCHIVE_MIN_CONFIDENCE).toBe(0.9);
  });

  const cases: Array<[string, Partial<Classification>, "keep" | "archive"]> = [
    ["baseline archivable (jev, high confidence)", {}, "archive"],
    ["priority 3 boundary archives", { priority: 3 }, "archive"],
    ["priority 4 keeps", { priority: 4 }, "keep"],
    ["priority 5 keeps", { priority: 5 }, "keep"],
    ["priority 10 keeps", { priority: 10 }, "keep"],
    [
      "confidence exactly 0.9 archives",
      {
        responseStateConfidence: 0.9,
        contentTagConfidence: 0.9,
        priorityConfidence: 0.9,
      },
      "archive",
    ],
    [
      "responseState confidence just below 0.9 keeps",
      { responseStateConfidence: 0.89 },
      "keep",
    ],
    [
      "contentTag confidence just below 0.9 keeps",
      { contentTagConfidence: 0.89 },
      "keep",
    ],
    [
      "priority confidence just below 0.9 keeps",
      { priorityConfidence: 0.89 },
      "keep",
    ],
    ["haiku with high confidence archives", { source: "haiku" }, "archive"],
    [
      "haiku with low confidence keeps",
      { source: "haiku", priorityConfidence: 0.5 },
      "keep",
    ],
    [
      "human source with low confidence keeps",
      { source: "human", contentTagConfidence: 0.1 },
      "keep",
    ],
    [
      "heuristic with low confidence archives",
      { source: "heuristic", ...lowConf },
      "archive",
    ],
    [
      "heuristic but priority 4 keeps",
      { source: "heuristic", priority: 4 },
      "keep",
    ],
    [
      "heuristic but priority 5 keeps",
      { source: "heuristic", priority: 5 },
      "keep",
    ],
    [
      "To Respond keeps",
      { responseState: "To Respond", source: "heuristic" },
      "keep",
    ],
    [
      "Awaiting Reply keeps",
      { responseState: "Awaiting Reply", source: "heuristic" },
      "keep",
    ],
    ["FYI bulk keeps (not Done)", { responseState: "FYI" }, "keep"],
    ["Newsletter tag keeps", { contentTag: "Newsletter" }, "keep"],
    ["Notification tag keeps", { contentTag: "Notification" }, "keep"],
    ["Receipt tag keeps", { contentTag: "Receipt" }, "keep"],
    ["Personal tag keeps", { contentTag: "Personal" }, "keep"],
    ["Work tag keeps", { contentTag: "Work" }, "keep"],
  ];

  it.each(cases)("%s", (_name, overrides, expected) => {
    const result = decideAction(make(overrides));
    expect(result.action).toBe(expected);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("never archives To Respond / Awaiting Reply for any combination", () => {
    const sources = ["jev", "haiku", "heuristic", "human"] as const;
    for (const responseState of ["To Respond", "Awaiting Reply"] as const) {
      for (const contentTag of ContentTag.options) {
        for (const source of sources) {
          for (
            let priority = PRIORITY_MIN;
            priority <= PRIORITY_MAX;
            priority++
          ) {
            for (const conf of [0, 0.9, 1]) {
              const result = decideAction({
                responseState,
                responseStateConfidence: conf,
                contentTag,
                contentTagConfidence: conf,
                priority,
                priorityConfidence: conf,
                source,
              });
              expect(result.action).toBe("keep");
            }
          }
        }
      }
    }
  });

  it("archives only in the documented cell across the full enum grid", () => {
    for (const responseState of ResponseState.options) {
      for (const contentTag of ContentTag.options) {
        for (
          let priority = PRIORITY_MIN;
          priority <= PRIORITY_MAX;
          priority++
        ) {
          const result = decideAction(
            make({ responseState, contentTag, priority }),
          );
          const expected =
            responseState === "Done" &&
            contentTag === "Bulk/Marketing" &&
            priority <= ARCHIVE_MAX_PRIORITY
              ? "archive"
              : "keep";
          expect(result.action).toBe(expected);
        }
      }
    }
  });
});
