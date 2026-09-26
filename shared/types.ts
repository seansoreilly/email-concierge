import { z } from "zod";

export const ResponseState = z.enum([
  "To Respond",
  "Awaiting Reply",
  "FYI",
  "Done",
]);
export type ResponseState = z.infer<typeof ResponseState>;

export const ContentTag = z.enum([
  "Personal",
  "Work",
  "Newsletter",
  "Notification",
  "Receipt",
  "Bulk/Marketing",
]);
export type ContentTag = z.infer<typeof ContentTag>;

export const Priority = z.number().int().min(2).max(10);
export type Priority = z.infer<typeof Priority>;

export const ClassificationSource = z.enum([
  "jev",
  "haiku",
  "heuristic",
  "human",
]);
export type ClassificationSource = z.infer<typeof ClassificationSource>;

export const Classification = z.object({
  responseState: ResponseState,
  responseStateConfidence: z.number().min(0).max(1),
  contentTag: ContentTag,
  contentTagConfidence: z.number().min(0).max(1),
  priority: Priority,
  priorityConfidence: z.number().min(0).max(1),
  source: ClassificationSource,
});
export type Classification = z.infer<typeof Classification>;

export const CorrectionRecord = z.object({
  messageId: z.string(),
  correctedAt: z.string().datetime(),
  previous: Classification.pick({
    responseState: true,
    contentTag: true,
    priority: true,
  }),
  corrected: Classification.pick({
    responseState: true,
    contentTag: true,
    priority: true,
  }),
});
export type CorrectionRecord = z.infer<typeof CorrectionRecord>;

export const EmailRecord = z.object({
  messageId: z.string(),
  threadId: z.string(),
  from: z.string(),
  subject: z.string(),
  snippet: z.string(),
  bodyText: z.string(),
  receivedAt: z.string().datetime(),
  classification: Classification,
  appliedLabelIds: z.array(z.string()).default([]),
  draftCreated: z.boolean().default(false),
  draftId: z.string().optional(),
  isFixture: z.boolean().default(false),
  corrections: z.array(CorrectionRecord).default([]),
});
export type EmailRecord = z.infer<typeof EmailRecord>;

// POST /emails/{messageId}/correction request body - the fields a human can override.
export const CorrectionRequest = Classification.pick({
  responseState: true,
  contentTag: true,
  priority: true,
});
export type CorrectionRequest = z.infer<typeof CorrectionRequest>;

export const FixtureEmail = z.object({
  messageId: z.string(),
  threadId: z.string(),
  from: z.string(),
  subject: z.string(),
  snippet: z.string(),
  bodyText: z.string(),
  receivedAt: z.string().datetime(),
  headers: z
    .object({
      listUnsubscribe: z.string().optional(),
      precedence: z.string().optional(),
    })
    .default({}),
  expected: z.object({
    responseState: ResponseState,
    contentTag: ContentTag,
    priorityMin: Priority,
    priorityMax: Priority,
  }),
});
export type FixtureEmail = z.infer<typeof FixtureEmail>;
