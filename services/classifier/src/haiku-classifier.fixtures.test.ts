import { fixtureEmails } from "@email-concierge/shared/fixtures/emails.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { HaikuClassifier } from "./haiku-classifier.ts";
import { classifyByHeuristic } from "./heuristic-filter.ts";

// Real API calls, no mocking - per the build plan, Haiku is the always-available verifiable
// gate for the classifier fixture tests (Jev needs live OpenRouter creds that may not be
// exported here). Skips gracefully when ANTHROPIC_API_KEY is unset so CI-without-secrets
// doesn't fail; runs for real when the key is present.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "HaikuClassifier - live fixture classification",
  () => {
    // Constructed in beforeAll (not at describe-body scope) so the Anthropic client is never
    // instantiated when this suite is skipped, even if a future SDK version throws eagerly
    // on a missing key at construction time.
    let classifier: HaikuClassifier;
    beforeAll(() => {
      classifier = new HaikuClassifier();
    });

    // Fixtures the heuristic pre-filter would catch never reach Haiku in the real cascade
    // (see cascading-classifier.ts) - testing Haiku's raw judgment on them is asserting on
    // something the system never asks of it, and their promo/bulk phrasing sits right on
    // Haiku's own FYI-vs-Done boundary, making those specific assertions flaky noise.
    const modelReachableFixtures = fixtureEmails.filter(
      (fixture) => classifyByHeuristic(fixture) === null,
    );

    for (const fixture of modelReachableFixtures) {
      it(`classifies ${fixture.messageId} (${fixture.subject.slice(0, 40)}...)`, async () => {
        const result = await classifier.classify({
          from: fixture.from,
          subject: fixture.subject,
          bodyText: fixture.bodyText,
        });

        expect(result.responseState).toBe(fixture.expected.responseState);
        expect(result.contentTag).toBe(fixture.expected.contentTag);
        expect(result.priority).toBeGreaterThanOrEqual(
          fixture.expected.priorityMin,
        );
        expect(result.priority).toBeLessThanOrEqual(
          fixture.expected.priorityMax,
        );
      }, 30_000);
    }
  },
);
