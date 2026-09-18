import { loadConfig } from "./lib/config.mjs";
import { getAgent, getPresentation } from "./lib/herdr.mjs";
import { buildSlackPayload, postSlackWebhook } from "./lib/slack.mjs";

const action = process.argv[2] ?? "check";
const config = loadConfig();

if (action === "check") {
  console.log(
    JSON.stringify(
      {
        enabled: config.enabled,
        webhookConfigured: Boolean(config.webhookUrl),
        webhookValid: config.webhookValid,
        destination: config.channelLabel,
        delaySeconds: config.delaySeconds,
        bodyMode: config.bodyMode,
        maxFinalChars: config.maxFinalChars,
        redactSecrets: config.redactSecrets,
        sessionRoot: config.sessionRoot,
        configPath: config.configPath,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (action !== "test") {
  console.error(`unknown action: ${action}`);
  process.exit(2);
}

if (!config.enabled) {
  console.error("Pi Slack notifications are disabled");
  process.exit(1);
}
if (!config.webhookUrl) {
  console.error(`Slack webhook is not configured; edit ${config.configPath}`);
  process.exit(1);
}
if (!config.webhookValid) {
  console.error(`SLACK_WEBHOOK_URL in ${config.configPath} is not a valid Slack Workflow Builder trigger URL`);
  process.exit(1);
}

const context = readJsonEnv("HERDR_PLUGIN_CONTEXT_JSON");
const paneId = context.pane_id ?? context.focused_pane_id ?? process.env.HERDR_PANE_ID;
let presentation = {
  workspaceLabel: context.workspace_label ?? "Herdr",
  tabLabel: context.tab_label,
  paneId: paneId ?? "test",
};

if (paneId) {
  try {
    const agent = await getAgent(paneId);
    presentation = await getPresentation(agent);
  } catch {
    // The test does not require a live agent.
  }
}

const payload = buildSlackPayload({
  channelLabel: config.channelLabel,
  workspaceLabel: presentation.workspaceLabel,
  tabLabel: presentation.tabLabel,
  delaySeconds: config.delaySeconds,
  test: true,
  finalText: [
    "## Formatting check",
    "",
    "This message is sent as **plain text** because Slack Workflow Builder does not render `mrkdwn` from a text variable.",
    "",
    "- Emphasis and code markers are removed",
    "- Links keep their address: [Slack API docs](https://api.slack.com/)",
    "",
    "> Headings, lists, and quotes are flattened but stay readable.",
  ].join("\n"),
});

await postSlackWebhook(config.webhookUrl, payload);
console.log(`sent test notification to ${config.channelLabel}`);

function readJsonEnv(name) {
  try {
    return JSON.parse(process.env[name] ?? "{}");
  } catch {
    return {};
  }
}
