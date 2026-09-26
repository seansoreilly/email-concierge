import type { FixtureEmail } from "../types.ts";

export const fixtureEmails: FixtureEmail[] = [
  {
    messageId: "fixture-001",
    threadId: "fixture-thread-001",
    from: "sarah.chen@example.com",
    subject: "Can you review the Q3 roadmap doc before Friday?",
    snippet:
      "Hey, wanted to check if you had a chance to look at the roadmap...",
    bodyText:
      "Hey,\n\nWanted to check if you had a chance to look at the Q3 roadmap doc I shared " +
      "last week. I need your sign-off before Friday's leadership review. Let me know if " +
      "you have any concerns or if we should hop on a call.\n\nThanks,\nSarah",
    receivedAt: "2026-09-22T14:30:00Z",
    headers: {},
    expected: {
      responseState: "To Respond",
      contentTag: "Work",
      priorityMin: 6,
      priorityMax: 9,
    },
  },
  {
    messageId: "fixture-002",
    threadId: "fixture-thread-002",
    from: "notifications@github.com",
    subject: "[org/repo] New comment on issue #482",
    snippet: "alice commented: I think this is fixed by the last PR...",
    bodyText:
      "alice commented on issue #482:\n\n> I think this is fixed by the last PR, can someone " +
      "confirm on staging?\n\nView it on GitHub.",
    receivedAt: "2026-09-22T09:15:00Z",
    headers: { precedence: "list" },
    expected: {
      responseState: "FYI",
      contentTag: "Notification",
      priorityMin: 2,
      priorityMax: 4,
    },
  },
  {
    messageId: "fixture-003",
    threadId: "fixture-thread-003",
    from: "no-reply@stripe.com",
    subject: "Your receipt from Acme Corp — $49.00",
    snippet: "Thanks for your payment. Here is your receipt...",
    bodyText:
      "Thanks for your payment of $49.00 to Acme Corp on Sep 21, 2026.\n\nReceipt #INV-2026-4471\n" +
      "Payment method: Visa ending in 4242",
    receivedAt: "2026-09-21T18:02:00Z",
    headers: {},
    expected: {
      responseState: "Done",
      contentTag: "Receipt",
      priorityMin: 2,
      priorityMax: 3,
    },
  },
  {
    messageId: "fixture-004",
    threadId: "fixture-thread-004",
    from: "marketing@bigretailer.com",
    subject: "🔥 Fall Sale: 40% off everything, this weekend only!",
    snippet: "Don't miss out on our biggest sale of the season...",
    bodyText:
      "Don't miss out on our biggest sale of the season! 40% off everything storewide, " +
      "this weekend only. Shop now before it's gone.\n\nUnsubscribe | Manage preferences",
    receivedAt: "2026-09-20T08:00:00Z",
    headers: {
      listUnsubscribe: "<mailto:unsubscribe@bigretailer.com>",
      precedence: "bulk",
    },
    expected: {
      responseState: "Done",
      contentTag: "Bulk/Marketing",
      priorityMin: 2,
      priorityMax: 3,
    },
  },
  {
    messageId: "fixture-005",
    threadId: "fixture-thread-005",
    from: "mom@example.com",
    subject: "Dinner Sunday?",
    snippet: "Hi honey, are you free for dinner this Sunday...",
    bodyText:
      "Hi honey,\n\nAre you free for dinner this Sunday? Your dad and I are thinking around " +
      "6pm. Let me know if that works or if you want to bring anyone.\n\nLove, Mom",
    receivedAt: "2026-09-23T11:00:00Z",
    headers: {},
    expected: {
      responseState: "To Respond",
      contentTag: "Personal",
      priorityMin: 5,
      priorityMax: 8,
    },
  },
  {
    messageId: "fixture-006",
    threadId: "fixture-thread-006",
    from: "j.martinez@vendorcorp.com",
    subject: "RE: Contract renewal terms",
    snippet: "Following up on my email from last week regarding the renewal...",
    bodyText:
      "Following up on my email from last week regarding the contract renewal. We need your " +
      "decision by end of month to lock in the current pricing. Happy to jump on a call if " +
      "that's easier.\n\nBest,\nJ. Martinez",
    receivedAt: "2026-09-19T16:45:00Z",
    headers: {},
    expected: {
      responseState: "To Respond",
      contentTag: "Work",
      priorityMin: 7,
      priorityMax: 10,
    },
  },
  {
    messageId: "fixture-007",
    threadId: "fixture-thread-007",
    from: "team-updates@project-tool.com",
    subject: "Weekly digest: 14 updates in your workspace",
    snippet: "Here's what happened in your workspace this week...",
    bodyText:
      "Here's what happened in your workspace this week: 14 task updates, 3 new comments, " +
      "1 completed milestone. View the full digest on your dashboard.",
    receivedAt: "2026-09-21T07:00:00Z",
    headers: { precedence: "bulk" },
    expected: {
      responseState: "FYI",
      contentTag: "Notification",
      priorityMin: 2,
      priorityMax: 4,
    },
  },
  {
    messageId: "fixture-008",
    threadId: "fixture-thread-008",
    from: "you@example.com",
    subject: "RE: Can you review the Q3 roadmap doc before Friday?",
    snippet:
      "Sent my comments on the doc, waiting to hear back on the budget line...",
    bodyText:
      "Sent my comments on the doc. Still waiting to hear back on the budget line before I " +
      "can give final sign-off. Let me know once that's confirmed.",
    receivedAt: "2026-09-23T10:00:00Z",
    headers: {},
    expected: {
      responseState: "Awaiting Reply",
      contentTag: "Work",
      priorityMin: 4,
      priorityMax: 6,
    },
  },
  {
    messageId: "fixture-009",
    threadId: "fixture-thread-009",
    from: "security@bankcorp.com",
    subject: "Unusual sign-in activity on your account",
    snippet:
      "We noticed a new sign-in to your account from an unrecognized device...",
    bodyText:
      "We noticed a new sign-in to your account from an unrecognized device in a new " +
      "location. If this was you, no action is needed. If not, please secure your account " +
      "immediately by resetting your password.",
    receivedAt: "2026-09-24T03:22:00Z",
    headers: {},
    expected: {
      responseState: "To Respond",
      contentTag: "Notification",
      priorityMin: 8,
      priorityMax: 10,
    },
  },
  {
    messageId: "fixture-013",
    threadId: "fixture-thread-013",
    from: "digest@techweekly.com",
    subject: "This Week in Tech: 12 stories you might have missed",
    snippet: "Our top picks from this week's tech news, curated for you...",
    bodyText:
      "Our top picks from this week's tech news, curated for you. This week: the latest " +
      "in AI infra, a deep dive on edge compute, and more.\n\nUnsubscribe from this newsletter.",
    receivedAt: "2026-09-20T06:00:00Z",
    headers: {
      listUnsubscribe: "<mailto:unsubscribe@techweekly.com>",
      precedence: "bulk",
    },
    expected: {
      responseState: "Done",
      contentTag: "Newsletter",
      priorityMin: 2,
      priorityMax: 3,
    },
  },
  {
    messageId: "fixture-010",
    threadId: "fixture-thread-010",
    from: "calendar-notifications@example.com",
    subject: "Reminder: 1:1 with Priya tomorrow at 2pm",
    snippet: "This is a reminder for your upcoming event...",
    bodyText:
      "This is a reminder for your upcoming event: 1:1 with Priya, tomorrow at 2:00 PM.",
    receivedAt: "2026-09-22T20:00:00Z",
    headers: {},
    expected: {
      responseState: "FYI",
      contentTag: "Notification",
      priorityMin: 3,
      priorityMax: 5,
    },
  },
  {
    messageId: "fixture-011",
    threadId: "fixture-thread-011",
    from: "old-friend@example.com",
    subject: "It's been a while!",
    snippet: "Hey! I saw you moved to a new city, how's it going...",
    bodyText:
      "Hey! I saw on social media you moved to a new city — how's it going? We should " +
      "catch up sometime, it's been way too long. Let me know if you're ever back in town.",
    receivedAt: "2026-09-18T13:10:00Z",
    headers: {},
    expected: {
      responseState: "To Respond",
      contentTag: "Personal",
      priorityMin: 3,
      priorityMax: 6,
    },
  },
  {
    messageId: "fixture-012",
    threadId: "fixture-thread-012",
    from: "billing@saastool.com",
    subject: "Your invoice is ready — INV-88213",
    snippet: "Your monthly invoice for SaaSTool Pro is now available...",
    bodyText:
      "Your monthly invoice for SaaSTool Pro ($29.00) is now available. Payment will be " +
      "automatically charged to your card on file on Oct 1.",
    receivedAt: "2026-09-25T05:00:00Z",
    headers: {},
    expected: {
      responseState: "Done",
      contentTag: "Receipt",
      priorityMin: 2,
      priorityMax: 3,
    },
  },
];
