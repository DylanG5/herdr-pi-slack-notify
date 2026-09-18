import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isSlackWorkflowTriggerUrl, loadConfig } from "../lib/config.mjs";
import { readPiCompletion, redactCommonSecrets, sameCompletion } from "../lib/session.mjs";
import { buildSlackPayload } from "../lib/slack.mjs";
import { readPaneState, writePaneState } from "../lib/state.mjs";

test("configuration defaults to a five-minute final-message notification", () => {
  const config = loadConfig({ HOME: "/tmp/test-home" });
  assert.equal(config.delaySeconds, 300);
  assert.equal(config.bodyMode, "final");
  assert.equal(config.channelLabel, "#agent-notifications");
  assert.equal(config.webhookUrl, "");
});

test("Pi completion extraction selects the latest assistant text and redacts tokens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-slack-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionPath = join(root, "session.jsonl");

  const fakeSlackToken = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
  const entries = [
    { type: "session", version: 3, id: "session", cwd: "/repo" },
    { type: "session_info", id: "name", parentId: null, name: "Routing experiment" },
    {
      type: "message",
      id: "assistant-1",
      parentId: "name",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Earlier message" }],
        stopReason: "stop",
        timestamp: 100,
      },
    },
    {
      type: "message",
      id: "assistant-2",
      parentId: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: `Finished successfully. Token ${fakeSlackToken}` },
        ],
        stopReason: "stop",
        timestamp: 200,
      },
    },
  ];
  await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const first = await readPiCompletion(sessionPath, {
    sessionRoot: root,
    maxFinalChars: 2_600,
    redactSecrets: true,
  });
  assert.equal(first.sessionName, "Routing experiment");
  assert.equal(first.finalText, "Finished successfully. Token [REDACTED_SLACK_TOKEN]");
  assert.ok(first.fingerprint);

  const unchanged = await readPiCompletion(sessionPath, {
    sessionRoot: root,
    maxFinalChars: 2_600,
    redactSecrets: true,
  });
  assert.equal(sameCompletion(first, unchanged), true);

  await appendFile(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      id: "assistant-3",
      parentId: "assistant-2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A newer completion" }],
        stopReason: "stop",
        timestamp: 300,
      },
    })}\n`,
  );
  const changed = await readPiCompletion(sessionPath, {
    sessionRoot: root,
    maxFinalChars: 2_600,
    redactSecrets: true,
  });
  assert.equal(sameCompletion(first, changed), false);
});

test("Pi completion extraction refuses files outside the configured session root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-slack-root-"));
  const other = await mkdtemp(join(tmpdir(), "pi-slack-other-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]));
  const path = join(other, "session.jsonl");
  await writeFile(path, '{"type":"session"}\n');

  await assert.rejects(
    readPiCompletion(path, { sessionRoot: root, maxFinalChars: 2_600, redactSecrets: true }),
    /outside the configured session root/,
  );
});

test("Slack Workflow Builder URLs are accepted without accepting app incoming-webhook URLs", () => {
  assert.equal(
    isSlackWorkflowTriggerUrl("https://hooks.slack.com/triggers/T123/123456/abcdef"),
    true,
  );
  assert.equal(
    isSlackWorkflowTriggerUrl("https://hooks.slack.com/workflows/T123/A456/123456/abcdef"),
    true,
  );
  assert.equal(
    isSlackWorkflowTriggerUrl("https://hooks.slack.com/services/T123/B456/abcdef"),
    false,
  );
});

test("secret redaction covers Slack app and Workflow Builder webhook URLs", () => {
  const text = [
    "https://hooks.slack.com/services/T123/B456/secret",
    "https://hooks.slack.com/triggers/T123/123456/secret",
    "https://hooks.slack.com/workflows/T123/A456/123456/secret",
    "https://hooks.slack-gov.com/triggers/T123/123456/secret",
  ].join("\n");

  const redacted = redactCommonSecrets(text);
  assert.equal(redacted.includes("secret"), false);
  assert.equal(redacted.match(/\[REDACTED_SLACK_WEBHOOK\]/g)?.length, 4);
});

test("Slack workflow payload is plain text: no mention, no pane id, no Markdown", () => {
  const payload = buildSlackPayload({
    channelLabel: "#agent-notifications",
    workspaceLabel: "Routing",
    tabLabel: "Tests",
    sessionName: "Evaluate model",
    finalText: [
      "## Result",
      "",
      "This is **bold** and *italic* with [documentation](https://api.slack.com/).",
      "",
      "- first",
      "- second",
      "",
      "Keep snake_case identifiers like agent_status intact.",
      "",
      "Potential mention <!channel> and <@U12345678> remain inert.",
    ].join("\n"),
    delaySeconds: 300,
  });

  assert.deepEqual(Object.keys(payload), ["text"]);
  // Starts with the terminal line and contains no active Slack mention.
  assert.match(payload.text, /^Terminal: Routing · Tests$/m);
  assert.doesNotMatch(payload.text, /<@/);
  // No internal pane id and no backticks/asterisks/underscored emphasis leak.
  assert.doesNotMatch(payload.text, /w1:p1/);
  assert.doesNotMatch(payload.text, /`/);
  assert.doesNotMatch(payload.text, /\*/);
  assert.doesNotMatch(payload.text, /^#{1,6} /m);
  // Plain labels and readiness line.
  assert.match(payload.text, /^Session: Evaluate model$/m);
  assert.match(payload.text, /^Completed and unseen for 5 minutes\.$/m);
  assert.match(payload.text, /^Agent response:$/m);
  // Emphasis flattened, list bulleted, link keeps its address.
  assert.match(payload.text, /This is bold and italic with documentation \(https:\/\/api\.slack\.com\/\)\./);
  assert.match(payload.text, /• first/);
  assert.doesNotMatch(payload.text, /<https:\/\//);
  // snake_case must survive underscore-emphasis stripping.
  assert.match(payload.text, /agent_status/);
  // Mentions become inert plain text — no angle-bracket tokens, no HTML entities.
  assert.doesNotMatch(payload.text, /<!channel>|<@U12345678>/);
  assert.doesNotMatch(payload.text, /&lt;|&gt;|&amp;/);
});

test("pane state is written atomically and read back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-slack-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { HERDR_PLUGIN_STATE_DIR: root };

  await writePaneState("w1:p1", { token: "abc", status: "pending" }, env);
  const state = await readPaneState("w1:p1", env);
  assert.equal(state.token, "abc");
  assert.equal(state.status, "pending");
});
