import { describe, expect, it } from "vitest";
import { formatBodyText } from "./format-body";

describe("formatBodyText", () => {
  it("strips Paradox/Olivia-style markdown table pipes and separator rows", () => {
    const input =
      "|  Deloitte Australia  \r\n---  \r\n|  |  |  |  Sep   \r\n---  \r\n24   \r\nThu   \r\n  \r\n" +
      "Your virtual interview at Deloitte Australia is tomorrow!  \r\n---  \r\n" +
      "|  |  Hi Sean! I just wanted to remind you that your 1 hour virtual interview " +
      "at Deloitte Australia is tomorrow Thursday, September 24 at 03:30 PM AEST.   \r\n---|---  \r\n";

    const result = formatBodyText(input);

    expect(result).not.toContain("|");
    expect(result).not.toMatch(/^-{2,}$/m);
    expect(result).toContain("Deloitte Australia");
    expect(result).toContain(
      "Hi Sean! I just wanted to remind you that your 1 hour virtual interview",
    );
  });

  it("converts markdown links to plain 'text (url)' form", () => {
    const input =
      "|  [Click here to join the interview by Microsoft Teams](https://oli.vi/W9Nfp1m9) " +
      "Meeting ID: 323498618888203";

    const result = formatBodyText(input);

    expect(result).toContain(
      "Click here to join the interview by Microsoft Teams (https://oli.vi/W9Nfp1m9)",
    );
    expect(result).not.toContain("[");
    expect(result).not.toContain("]");
  });

  it("decodes HTML entities left over from stripHtml", () => {
    const input = "we&#39;re excited to talk to you.&nbsp; &nbsp;";

    const result = formatBodyText(input);

    expect(result).toBe("we're excited to talk to you.");
  });

  it("decodes common named and numeric entities", () => {
    const input = "Ben &amp; Jerry&#8217;s &lt;tag&gt; &quot;quoted&quot;";

    const result = formatBodyText(input);

    expect(result).toBe('Ben & Jerry’s <tag> "quoted"');
  });

  it("collapses 3+ consecutive blank lines to at most one blank line", () => {
    const input = "Para one.\r\n\r\n\r\n\r\nPara two.";

    const result = formatBodyText(input);

    expect(result).toBe("Para one.\n\nPara two.");
  });

  it("leaves ordinary plain-text email bodies unchanged in substance", () => {
    const input =
      "Hi Sean,\n\nThanks for applying. We'll be in touch soon.\n\nBest,\nJane";

    const result = formatBodyText(input);

    expect(result).toBe(
      "Hi Sean,\n\nThanks for applying. We'll be in touch soon.\n\nBest,\nJane",
    );
  });

  it("handles empty string", () => {
    expect(formatBodyText("")).toBe("");
  });
});
