import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * These two tests are the CI safety boundary for this app's one
 * non-negotiable invariant: it must never be able to send email, under
 * any configuration. Gmail's gmail.modify OAuth scope (needed for both
 * label writes and draft creation) also technically permits
 * messages.send — there is no OAuth scope that allows drafts/labels
 * but forbids send — so this boundary has to be enforced in code, and
 * verified by static analysis of the source tree.
 *
 * IMPORTANT: these are static greps over source text, not a formal
 * proof of anything. They reduce risk (they catch the straightforward
 * ways this invariant could be violated or silently regress) but a
 * sufficiently obfuscated or dynamically-constructed import/call could
 * still slip past a text-based check like this.
 */

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const GMAIL_CLIENT_DIR = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const THIS_FILE = fileURLToPath(import.meta.url);

const SCAN_ROOTS = ["services", "shared", "web", "scripts"];
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function listSourceFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const results: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function repoSourceFiles(): string[] {
  return SCAN_ROOTS.flatMap((dir) =>
    listSourceFiles(path.join(REPO_ROOT, dir)),
  );
}

// Matches `from "googleapis"`, `require("googleapis")`, `import("googleapis")`,
// and the same forms for the "@googleapis/*" family of standalone
// per-API packages (e.g. "@googleapis/gmail"), which construct the same
// kind of client and would otherwise be an easy bypass of this test.
const GOOGLEAPIS_IMPORT_PATTERN =
  /(?:from\s+|require\(|import\()\s*["'](googleapis|@googleapis\/[\w-]+)["']/;

describe("safety boundary: googleapis import confinement", () => {
  it("is imported ONLY inside services/gmail-client/", () => {
    const offendingFiles: string[] = [];
    let foundInsideGmailClient = false;

    for (const file of repoSourceFiles()) {
      if (file === THIS_FILE) {
        continue;
      }
      const contents = fs.readFileSync(file, "utf8");
      if (!GOOGLEAPIS_IMPORT_PATTERN.test(contents)) {
        continue;
      }
      const isInsideGmailClient = file.startsWith(
        `${GMAIL_CLIENT_DIR}${path.sep}`,
      );
      if (isInsideGmailClient) {
        foundInsideGmailClient = true;
      } else {
        offendingFiles.push(path.relative(REPO_ROOT, file));
      }
    }

    // Sanity check that the scanner itself isn't silently finding nothing
    // (e.g. because the regex or the exclusion logic is broken). Without
    // this, a bug that made the whole scan a no-op would make the test
    // above pass vacuously forever.
    expect(foundInsideGmailClient).toBe(true);

    expect(offendingFiles).toEqual([]);
  });

  it("sanity: the import pattern itself matches a known-positive sample", () => {
    expect(
      GOOGLEAPIS_IMPORT_PATTERN.test('import { google } from "googleapis";'),
    ).toBe(true);
    expect(
      GOOGLEAPIS_IMPORT_PATTERN.test('import { gmail_v1 } from "googleapis";'),
    ).toBe(true);
    expect(
      GOOGLEAPIS_IMPORT_PATTERN.test('const g = require("googleapis");'),
    ).toBe(true);
    expect(
      GOOGLEAPIS_IMPORT_PATTERN.test('import gmail from "@googleapis/gmail";'),
    ).toBe(true);
    expect(GOOGLEAPIS_IMPORT_PATTERN.test('import { z } from "zod";')).toBe(
      false,
    );
  });
});

// Matches Gmail API send-method call patterns specifically, e.g.
// `gmail.users.messages.send(` or `.drafts.send(`. Deliberately scoped
// to this exact shape (a `.send(` preceded by `messages` or `drafts`)
// rather than a bare `.send(` grep, because a bare `.send(` grep across
// the whole repo would false-positive constantly on AWS SDK v3 calls
// elsewhere in this app (`client.send(new PutItemCommand(...))` etc,
// used for DynamoDB/Secrets Manager). That is explicitly the wrong test
// — this one is scoped to Gmail's method-call shape, and only within
// this package's own source.
const SEND_CALL_PATTERN = /\.(?:messages|drafts)\.send\s*\(/;

describe("safety boundary: no send-adjacent Gmail API calls in gmail-client", () => {
  it("never calls messages.send or drafts.send anywhere in services/gmail-client/", () => {
    const offendingFiles: string[] = [];

    for (const file of listSourceFiles(GMAIL_CLIENT_DIR)) {
      if (file === THIS_FILE) {
        // This file's own pattern definitions and sanity-check strings
        // legitimately contain these substrings; scanning it would be a
        // guaranteed false positive against the test's own source, not a
        // finding about the wrapper's behavior.
        continue;
      }
      const contents = fs.readFileSync(file, "utf8");
      if (SEND_CALL_PATTERN.test(contents)) {
        offendingFiles.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(offendingFiles).toEqual([]);
  });

  it("sanity: the send-call pattern itself matches known-positive samples", () => {
    expect(SEND_CALL_PATTERN.test("gmail.users.messages.send({")).toBe(true);
    expect(SEND_CALL_PATTERN.test("gmail.users.drafts.send({")).toBe(true);
    // Must NOT flag AWS SDK v3's unrelated client.send(new Command()) shape.
    expect(SEND_CALL_PATTERN.test("client.send(new PutItemCommand({}))")).toBe(
      false,
    );
    expect(SEND_CALL_PATTERN.test("gmail.users.messages.batchModify({")).toBe(
      false,
    );
  });
});

// Positive check on invariant #2 ("exposes ONLY these methods"): every
// gmail_v1 resource/method pair actually called anywhere in this
// package's non-test source must be one of the seven allowlisted calls.
// archive()/unarchive() add NO entry here: they reuse messages.batchModify
// (already listed) and only ever pass the hard-coded system label "INBOX".
// This is additive to (not a replacement for) the two tests above.
const RESOURCE_METHOD_CALL_PATTERN = /\.users\.(\w+)\.(\w+)\s*\(/g;
const ALLOWED_RESOURCE_METHODS = new Set([
  "history.list",
  "messages.list",
  "messages.get",
  "messages.batchModify",
  "labels.list",
  "labels.create",
  "drafts.create",
]);

describe("safety boundary: Gmail resource/method allowlist conformance", () => {
  it("only ever calls the seven allowlisted gmail_v1 resource.method combinations", () => {
    const calls: string[] = [];
    const disallowed: string[] = [];

    for (const file of listSourceFiles(GMAIL_CLIENT_DIR)) {
      if (file.endsWith(".test.ts")) {
        continue;
      }
      const contents = fs.readFileSync(file, "utf8");
      for (const match of contents.matchAll(RESOURCE_METHOD_CALL_PATTERN)) {
        const resource = match[1];
        const method = match[2];
        const combo = `${resource}.${method}`;
        calls.push(combo);
        if (!ALLOWED_RESOURCE_METHODS.has(combo)) {
          disallowed.push(`${path.relative(REPO_ROOT, file)}: ${combo}`);
        }
      }
    }

    // Sanity: make sure the scanner is actually finding calls, not
    // vacuously passing because the regex matched nothing.
    expect(calls.length).toBeGreaterThanOrEqual(ALLOWED_RESOURCE_METHODS.size);
    expect(disallowed).toEqual([]);
  });
});

// archive()/unarchive() legitimately mention the system label "INBOX"
// (messagesList filters on it too), so INBOX is the only system label ID
// allowed as a string literal in non-test source. TRASH/SPAM must never
// appear at all, so no code path in this package can send them to Gmail.
// Static text check, same caveats as above.
const FORBIDDEN_LABEL_LITERAL_PATTERN = /["'`](TRASH|SPAM)["'`]/;

describe("safety boundary: no TRASH/SPAM label IDs in gmail-client", () => {
  it("never references TRASH or SPAM label IDs in non-test source", () => {
    const offending: string[] = [];
    let scanned = 0;
    for (const file of listSourceFiles(GMAIL_CLIENT_DIR)) {
      if (file.endsWith(".test.ts")) {
        continue;
      }
      scanned += 1;
      const contents = fs.readFileSync(file, "utf8");
      if (FORBIDDEN_LABEL_LITERAL_PATTERN.test(contents)) {
        offending.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offending).toEqual([]);
  });

  it("sanity: the pattern matches known-positive samples only", () => {
    expect(FORBIDDEN_LABEL_LITERAL_PATTERN.test('addLabelIds: ["TRASH"]')).toBe(
      true,
    );
    expect(
      FORBIDDEN_LABEL_LITERAL_PATTERN.test("removeLabelIds: ['SPAM']"),
    ).toBe(true);
    expect(
      FORBIDDEN_LABEL_LITERAL_PATTERN.test('removeLabelIds: ["INBOX"]'),
    ).toBe(false);
  });
});
