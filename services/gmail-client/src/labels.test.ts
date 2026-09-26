import { describe, expect, it } from "vitest";
import {
  contentTagLabelName,
  isAppOwnedLabelName,
  responseStateLabelName,
} from "./labels.js";

describe("label naming convention", () => {
  it("names response-state labels under Concierge/Status/", () => {
    expect(responseStateLabelName("To Respond")).toBe(
      "Concierge/Status/To Respond",
    );
  });

  it("names content-tag labels under Concierge/Tag/", () => {
    expect(contentTagLabelName("Work")).toBe("Concierge/Tag/Work");
  });

  it("sanitizes a '/' inside an enum value to '-' to avoid unintended Gmail label nesting", () => {
    // "Bulk/Marketing" is a single ContentTag value, but Gmail treats "/"
    // as a nesting separator — without sanitizing, this would create an
    // unintended "Concierge/Tag/Bulk" parent label. Pinned explicitly so
    // a future change to the sanitizer is a deliberate, visible decision.
    expect(contentTagLabelName("Bulk/Marketing")).toBe(
      "Concierge/Tag/Bulk-Marketing",
    );
  });

  it("recognizes only Concierge/-prefixed names as app-owned", () => {
    expect(isAppOwnedLabelName("Concierge/Status/Done")).toBe(true);
    expect(isAppOwnedLabelName("INBOX")).toBe(false);
    expect(isAppOwnedLabelName("Some Other Label")).toBe(false);
  });
});
