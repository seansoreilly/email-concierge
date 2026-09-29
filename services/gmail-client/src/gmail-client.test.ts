import { describe, expect, it, vi } from "vitest";
import type { GmailApiSurface, GmailLabel } from "./gmail-client.js";
import {
  GmailClient,
  GmailHistoryExpiredError,
  LabelAllowlistNotLoadedError,
  LabelNotAllowedError,
} from "./gmail-client.js";
import { expectedTaxonomyLabelNames } from "./labels.js";

/**
 * These tests never touch the network or the real googleapis module —
 * they inject a fake GmailApiSurface (the narrow interface gmail-client
 * calls through) so we can verify the label-allowlist and batchModify
 * guard logic in isolation.
 */

function fakeLabel(name: string, id: string): GmailLabel {
  return { id, name };
}

function makeFakeApi(
  overrides: Partial<GmailApiSurface> = {},
): GmailApiSurface {
  return {
    historyList: vi.fn(),
    messagesList: vi.fn(),
    messagesGet: vi.fn(),
    messagesBatchModify: vi.fn().mockResolvedValue(undefined),
    labelsList: vi.fn().mockResolvedValue({ data: { labels: [] } }),
    labelsCreate: vi.fn(),
    draftsCreate: vi.fn(),
    ...overrides,
  };
}

describe("GmailClient.refreshLabelAllowlist", () => {
  it("filters labels.list to only Concierge/-prefixed labels", async () => {
    const api = makeFakeApi({
      labelsList: vi.fn().mockResolvedValue({
        data: {
          labels: [
            fakeLabel("INBOX", "INBOX"),
            fakeLabel("Concierge/Status/To Respond", "label-1"),
            fakeLabel("Some Other Custom Label", "label-2"),
          ],
        },
      }),
      labelsCreate: vi.fn().mockImplementation(({ requestBody }) =>
        Promise.resolve({
          data: fakeLabel(
            requestBody?.name ?? "unknown",
            `created-${requestBody?.name}`,
          ),
        }),
      ),
    });
    const client = new GmailClient(api);

    const allowlist = await client.refreshLabelAllowlist();

    expect(allowlist.get("Concierge/Status/To Respond")).toBe("label-1");
    expect(allowlist.has("INBOX")).toBe(false);
    expect(allowlist.has("Some Other Custom Label")).toBe(false);
  });

  it("creates every missing taxonomy label and caches its ID", async () => {
    const createdNames: string[] = [];
    const api = makeFakeApi({
      labelsList: vi.fn().mockResolvedValue({ data: { labels: [] } }),
      labelsCreate: vi.fn().mockImplementation(({ requestBody }) => {
        const name = requestBody?.name ?? "unknown";
        createdNames.push(name);
        return Promise.resolve({ data: fakeLabel(name, `id-${name}`) });
      }),
    });
    const client = new GmailClient(api);

    const allowlist = await client.refreshLabelAllowlist();

    const expected = expectedTaxonomyLabelNames();
    for (const name of expected) {
      expect(allowlist.get(name)).toBe(`id-${name}`);
    }
    expect(createdNames.sort()).toEqual([...expected].sort());
  });

  it("does not recreate a taxonomy label that already exists", async () => {
    const existingNames = expectedTaxonomyLabelNames();
    const api = makeFakeApi({
      labelsList: vi.fn().mockResolvedValue({
        data: {
          labels: existingNames.map((name, i) =>
            fakeLabel(name, `existing-${i}`),
          ),
        },
      }),
      labelsCreate: vi.fn(),
    });
    const client = new GmailClient(api);

    await client.refreshLabelAllowlist();

    expect(api.labelsCreate).not.toHaveBeenCalled();
  });
});

describe("GmailClient.batchModify", () => {
  it("throws LabelAllowlistNotLoadedError if refreshLabelAllowlist was never called", async () => {
    const api = makeFakeApi();
    const client = new GmailClient(api);

    await expect(
      client.batchModify(["msg-1"], ["some-id"], []),
    ).rejects.toThrow(LabelAllowlistNotLoadedError);
    expect(api.messagesBatchModify).not.toHaveBeenCalled();
  });

  it("succeeds when every label ID is in the allowlist", async () => {
    const api = makeFakeApi({
      labelsList: vi.fn().mockResolvedValue({
        data: { labels: [fakeLabel("Concierge/Status/Done", "allowed-id")] },
      }),
      labelsCreate: vi.fn().mockImplementation(({ requestBody }) =>
        Promise.resolve({
          data: fakeLabel(
            requestBody?.name ?? "unknown",
            `created-${requestBody?.name}`,
          ),
        }),
      ),
    });
    const client = new GmailClient(api);
    await client.refreshLabelAllowlist();

    await client.batchModify(["msg-1", "msg-2"], ["allowed-id"], []);

    expect(api.messagesBatchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        ids: ["msg-1", "msg-2"],
        addLabelIds: ["allowed-id"],
        removeLabelIds: [],
      },
    });
  });

  it("throws LabelNotAllowedError and never calls the API for an out-of-allowlist label ID", async () => {
    const api = makeFakeApi({
      labelsList: vi.fn().mockResolvedValue({
        data: { labels: [fakeLabel("Concierge/Status/Done", "allowed-id")] },
      }),
      labelsCreate: vi.fn().mockImplementation(({ requestBody }) =>
        Promise.resolve({
          data: fakeLabel(
            requestBody?.name ?? "unknown",
            `created-${requestBody?.name}`,
          ),
        }),
      ),
    });
    const client = new GmailClient(api);
    await client.refreshLabelAllowlist();

    await expect(client.batchModify(["msg-1"], ["TRASH"], [])).rejects.toThrow(
      LabelNotAllowedError,
    );
    expect(api.messagesBatchModify).not.toHaveBeenCalled();
  });

  it("throws for an out-of-allowlist ID in removeLabelIds too", async () => {
    const api = makeFakeApi({
      labelsList: vi.fn().mockResolvedValue({
        data: { labels: [fakeLabel("Concierge/Status/Done", "allowed-id")] },
      }),
      labelsCreate: vi.fn().mockImplementation(({ requestBody }) =>
        Promise.resolve({
          data: fakeLabel(
            requestBody?.name ?? "unknown",
            `created-${requestBody?.name}`,
          ),
        }),
      ),
    });
    const client = new GmailClient(api);
    await client.refreshLabelAllowlist();

    await expect(client.batchModify(["msg-1"], [], ["SPAM"])).rejects.toThrow(
      LabelNotAllowedError,
    );
    expect(api.messagesBatchModify).not.toHaveBeenCalled();
  });

  it("throws for an empty messageIds array", async () => {
    const api = makeFakeApi({
      labelsCreate: vi.fn().mockImplementation(({ requestBody }) =>
        Promise.resolve({
          data: fakeLabel(
            requestBody?.name ?? "unknown",
            `created-${requestBody?.name}`,
          ),
        }),
      ),
    });
    const client = new GmailClient(api);
    await client.refreshLabelAllowlist();

    await expect(client.batchModify([], [], [])).rejects.toThrow();
    expect(api.messagesBatchModify).not.toHaveBeenCalled();
  });
});

describe("GmailClient.archive / unarchive", () => {
  it("archive removes exactly INBOX and adds nothing", async () => {
    const api = makeFakeApi();
    const client = new GmailClient(api);

    await client.archive(["msg-1", "msg-2"]);

    expect(api.messagesBatchModify).toHaveBeenCalledTimes(1);
    expect(api.messagesBatchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        ids: ["msg-1", "msg-2"],
        addLabelIds: [],
        removeLabelIds: ["INBOX"],
      },
    });
  });

  it("unarchive adds exactly INBOX and removes nothing", async () => {
    const api = makeFakeApi();
    const client = new GmailClient(api);

    await client.unarchive(["msg-1"]);

    expect(api.messagesBatchModify).toHaveBeenCalledTimes(1);
    expect(api.messagesBatchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        ids: ["msg-1"],
        addLabelIds: ["INBOX"],
        removeLabelIds: [],
      },
    });
  });

  it("throws on empty messageIds without calling the API", async () => {
    const api = makeFakeApi();
    const client = new GmailClient(api);

    await expect(client.archive([])).rejects.toThrow();
    await expect(client.unarchive([])).rejects.toThrow();
    expect(api.messagesBatchModify).not.toHaveBeenCalled();
  });

  it("batchModify still rejects INBOX in both add and remove", async () => {
    const api = makeFakeApi({
      labelsCreate: vi.fn().mockImplementation(({ requestBody }) =>
        Promise.resolve({
          data: fakeLabel(
            requestBody?.name ?? "unknown",
            `created-${requestBody?.name}`,
          ),
        }),
      ),
    });
    const client = new GmailClient(api);
    await client.refreshLabelAllowlist();

    await expect(client.batchModify(["msg-1"], [], ["INBOX"])).rejects.toThrow(
      LabelNotAllowedError,
    );
    await expect(client.batchModify(["msg-1"], ["INBOX"], [])).rejects.toThrow(
      LabelNotAllowedError,
    );
    expect(api.messagesBatchModify).not.toHaveBeenCalled();
  });
});

describe("GmailClient.labelsCreate", () => {
  it("refuses to create a label outside the Concierge/ namespace", async () => {
    const api = makeFakeApi();
    const client = new GmailClient(api);

    await expect(client.labelsCreate("Not Owned")).rejects.toThrow();
    expect(api.labelsCreate).not.toHaveBeenCalled();
  });

  it("creates a label inside the Concierge/ namespace", async () => {
    const api = makeFakeApi({
      labelsCreate: vi.fn().mockResolvedValue({
        data: fakeLabel("Concierge/Tag/Work", "id-work"),
      }),
    });
    const client = new GmailClient(api);

    const created = await client.labelsCreate("Concierge/Tag/Work");

    expect(created.id).toBe("id-work");
    expect(api.labelsCreate).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { name: "Concierge/Tag/Work" },
    });
  });
});

describe("GmailClient.draftsCreate", () => {
  it("requires a non-empty threadId", async () => {
    const api = makeFakeApi();
    const client = new GmailClient(api);

    await expect(client.draftsCreate("", "raw-message")).rejects.toThrow();
    expect(api.draftsCreate).not.toHaveBeenCalled();
  });

  it("creates a draft scoped to the given threadId", async () => {
    const api = makeFakeApi({
      draftsCreate: vi
        .fn()
        .mockResolvedValue({ data: { id: "draft-1", message: {} } }),
    });
    const client = new GmailClient(api);

    await client.draftsCreate("thread-123", "raw-base64url");

    expect(api.draftsCreate).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        message: {
          threadId: "thread-123",
          raw: "raw-base64url",
        },
      },
    });
  });
});

describe("GmailClient read-only passthroughs", () => {
  it("historyList calls through with startHistoryId and parses messagesAdded", async () => {
    const api = makeFakeApi({
      historyList: vi.fn().mockResolvedValue({
        data: {
          history: [
            { messagesAdded: [{ message: { id: "msg-1" } }] },
            { messagesAdded: [{ message: { id: "msg-2" } }] },
          ],
          historyId: "999",
        },
      }),
    });
    const client = new GmailClient(api);

    const result = await client.historyList({ startHistoryId: "12345" });

    expect(api.historyList).toHaveBeenCalledWith({
      userId: "me",
      startHistoryId: "12345",
      pageToken: undefined,
    });
    expect(result.messageIdsAdded).toEqual(["msg-1", "msg-2"]);
    expect(result.historyId).toBe("999");
  });

  it("historyList throws GmailHistoryExpiredError on a 404", async () => {
    const api = makeFakeApi({
      historyList: vi.fn().mockRejectedValue({ code: 404 }),
    });
    const client = new GmailClient(api);

    await expect(
      client.historyList({ startHistoryId: "stale" }),
    ).rejects.toThrow(GmailHistoryExpiredError);
  });

  it("messagesList calls through with an optional query, restricted to INBOX", async () => {
    const api = makeFakeApi({
      messagesList: vi.fn().mockResolvedValue({
        data: { messages: [{ id: "msg-1" }, { id: "msg-2" }] },
      }),
    });
    const client = new GmailClient(api);

    const result = await client.messagesList({ query: "is:unread" });

    expect(api.messagesList).toHaveBeenCalledWith({
      userId: "me",
      q: "is:unread",
      pageToken: undefined,
      maxResults: undefined,
      labelIds: ["INBOX"],
    });
    expect(result.messageIds).toEqual(["msg-1", "msg-2"]);
  });

  it("messagesGet fetches full format and parses into ParsedMessage", async () => {
    const api = makeFakeApi({
      messagesGet: vi.fn().mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          snippet: "hello",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "From", value: "a@example.com" },
              { name: "Subject", value: "Hi" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("body text").toString("base64url") },
          },
          labelIds: ["INBOX"],
        },
      }),
    });
    const client = new GmailClient(api);

    const result = await client.messagesGet("msg-1");

    expect(api.messagesGet).toHaveBeenCalledWith({
      userId: "me",
      id: "msg-1",
      format: "full",
    });
    expect(result.messageId).toBe("msg-1");
    expect(result.threadId).toBe("thread-1");
    expect(result.from).toBe("a@example.com");
    expect(result.subject).toBe("Hi");
    expect(result.bodyText).toBe("body text");
  });
});
