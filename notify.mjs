import { randomUUID } from "node:crypto";
import { loadConfig } from "./lib/config.mjs";
import { getAgent, getPresentation, isSameAgent, summarizeAgent } from "./lib/herdr.mjs";
import { readPiCompletion, sameCompletion } from "./lib/session.mjs";
import { buildSlackPayload, postSlackWebhook } from "./lib/slack.mjs";
import { readPaneState, replacePaneStateIfToken, writePaneState } from "./lib/state.mjs";

await main().catch((error) => {
  console.error(`Pi Slack notification failed: ${safeError(error)}`);
  process.exitCode = 1;
});

async function main() {
  const event = readJsonEnv("HERDR_PLUGIN_EVENT_JSON");
  const context = readJsonEnv("HERDR_PLUGIN_CONTEXT_JSON");
  const status = statusFrom(event, context);
  const paneId = paneIdFrom(event, context);
  if (!paneId || !status) return;

  if (status !== "done") {
    await writePaneState(paneId, {
      token: randomUUID(),
      status: "cancelled",
      observedStatus: status,
      updatedAt: Date.now(),
    });
    return;
  }

  const config = loadConfig();
  const token = randomUUID();
  const scheduledAt = Date.now();
  const deadlineAt = scheduledAt + config.delaySeconds * 1_000;

  await writePaneState(paneId, {
    token,
    status: "preparing",
    observedStatus: "done",
    scheduledAt,
    deadlineAt,
  });

  if (!config.enabled) {
    await replacePaneStateIfToken(paneId, token, { status: "disabled", updatedAt: Date.now() });
    return;
  }
  if (!config.webhookUrl) {
    console.error(`Slack webhook is not configured; edit ${config.configPath}`);
    await replacePaneStateIfToken(paneId, token, { status: "skipped_no_webhook", updatedAt: Date.now() });
    return;
  }
  if (!config.webhookValid) {
    console.error(`SLACK_WEBHOOK_URL in ${config.configPath} is not a valid Slack Workflow Builder trigger URL`);
    await replacePaneStateIfToken(paneId, token, { status: "skipped_invalid_webhook", updatedAt: Date.now() });
    return;
  }

  const agent = await getAgent(paneId);
  if (!isPiAgent(agent) || agent.agent_status !== "done") {
    await replacePaneStateIfToken(paneId, token, {
      status: "cancelled",
      observedStatus: agent?.agent_status ?? "missing",
      updatedAt: Date.now(),
    });
    return;
  }

  const expectedAgent = summarizeAgent(agent);
  const expectedCompletion = await completionForAgent(agent, config);
  const presentation = await getPresentation(agent);
  const stillCurrent = await readPaneState(paneId);
  if (!stillCurrent || stillCurrent.token !== token) return;

  await writePaneState(paneId, {
    ...stillCurrent,
    status: "pending",
    expectedAgent,
    expectedCompletion: completionIdentity(expectedCompletion),
    presentation,
    updatedAt: Date.now(),
  });

  await sleepUntil(deadlineAt);

  const pending = await readPaneState(paneId);
  if (!pending || pending.token !== token || pending.status !== "pending") return;

  const wakeConfig = loadConfig();
  if (!wakeConfig.enabled || !wakeConfig.webhookUrl || !wakeConfig.webhookValid) {
    await replacePaneStateIfToken(paneId, token, { status: "cancelled_config", updatedAt: Date.now() });
    return;
  }

  const currentAgent = await getAgent(paneId).catch(() => undefined);
  if (!currentAgent || currentAgent.agent_status !== "done" || !isPiAgent(currentAgent)) {
    await replacePaneStateIfToken(paneId, token, {
      status: "cancelled",
      observedStatus: currentAgent?.agent_status ?? "missing",
      updatedAt: Date.now(),
    });
    return;
  }
  if (!isSameAgent(pending.expectedAgent, currentAgent)) {
    await replacePaneStateIfToken(paneId, token, { status: "cancelled_agent_changed", updatedAt: Date.now() });
    return;
  }

  const currentCompletion = await completionForAgent(currentAgent, wakeConfig);
  if (pending.expectedCompletion && !sameCompletion(pending.expectedCompletion, currentCompletion)) {
    await replacePaneStateIfToken(paneId, token, { status: "cancelled_completion_changed", updatedAt: Date.now() });
    return;
  }

  const beforeClaim = await readPaneState(paneId);
  if (!beforeClaim || beforeClaim.token !== token || beforeClaim.status !== "pending") return;
  await writePaneState(paneId, { ...beforeClaim, status: "sending", updatedAt: Date.now() });

  const latestPresentation = await getPresentation(currentAgent).catch(() => pending.presentation);
  const payload = buildSlackPayload({
    channelLabel: wakeConfig.channelLabel,
    workspaceLabel: latestPresentation?.workspaceLabel,
    tabLabel: latestPresentation?.tabLabel,
    sessionName: currentCompletion?.sessionName,
    finalText: wakeConfig.bodyMode === "final" ? currentCompletion?.finalText : undefined,
    delaySeconds: wakeConfig.delaySeconds,
  });

  try {
    await postSlackWebhook(wakeConfig.webhookUrl, payload);
  } catch (error) {
    await replacePaneStateIfToken(paneId, token, {
      status: "failed",
      error: safeError(error),
      updatedAt: Date.now(),
    });
    throw error;
  }

  await replacePaneStateIfToken(paneId, token, {
    status: "notified",
    notifiedAt: Date.now(),
    error: undefined,
  });
}

async function completionForAgent(agent, config) {
  const session = agent?.agent_session;
  if (session?.agent !== "pi" || session?.kind !== "path" || !session.value) return undefined;
  try {
    return await readPiCompletion(session.value, {
      sessionRoot: config.sessionRoot,
      maxFinalChars: config.maxFinalChars,
      redactSecrets: config.redactSecrets,
    });
  } catch (error) {
    console.error(`Pi final message unavailable; using ready-only fallback: ${safeError(error)}`);
    return undefined;
  }
}

function completionIdentity(completion) {
  if (!completion) return undefined;
  return {
    path: completion.path,
    fingerprint: completion.fingerprint,
    fileSignature: completion.fileSignature,
  };
}

function isPiAgent(agent) {
  return String(agent?.agent ?? agent?.agent_session?.agent ?? "").toLowerCase() === "pi";
}

function statusFrom(event, context) {
  const status =
    event?.data?.agent_status ??
    context?.agent_status ??
    context?.focused_pane_status ??
    context?.event?.agent_status;
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

function paneIdFrom(event, context) {
  const paneId = event?.data?.pane_id ?? context?.pane_id ?? context?.focused_pane_id;
  return typeof paneId === "string" && paneId ? paneId : undefined;
}

function readJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Ignoring invalid ${name}: ${safeError(error)}`);
    return {};
  }
}

function sleepUntil(timestamp) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, timestamp - Date.now())));
}

function safeError(error) {
  return String(error?.message ?? error ?? "unknown error").replace(/https:\/\/hooks\.slack[^\s]+/gi, "[REDACTED_WEBHOOK]");
}
