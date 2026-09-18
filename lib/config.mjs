import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadConfig(env = process.env) {
  loadDotEnv(join(env.HERDR_PLUGIN_CONFIG_DIR ?? pluginRoot, ".env"), env);

  const bodyMode = String(env.HERDR_SLACK_BODY_MODE ?? "final").trim().toLowerCase();
  const webhookUrl = String(env.SLACK_WEBHOOK_URL ?? "").trim();

  return {
    enabled: envFlag(env.HERDR_SLACK_ENABLED, true),
    webhookUrl,
    webhookValid: webhookUrl === "" || isSlackWorkflowTriggerUrl(webhookUrl),
    channelLabel: String(env.HERDR_SLACK_CHANNEL ?? "#agent-notifications").trim(),
    delaySeconds: boundedInteger(env.HERDR_SLACK_DELAY_SECONDS, 300, 1, 86_400),
    bodyMode: bodyMode === "ready" ? "ready" : "final",
    maxFinalChars: boundedInteger(env.HERDR_SLACK_MAX_FINAL_CHARS, 2_600, 500, 2_800),
    redactSecrets: envFlag(env.HERDR_SLACK_REDACT_SECRETS, true),
    sessionRoot: resolve(expandHome(env.PI_SESSION_ROOT ?? join(homedir(), ".pi", "agent", "sessions"))),
    configPath: join(env.HERDR_PLUGIN_CONFIG_DIR ?? pluginRoot, ".env"),
  };
}

export function isSlackWorkflowTriggerUrl(raw) {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      ["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) &&
      ["triggers", "workflows"].includes(segments[0]) &&
      segments.length >= 3
    );
  } catch {
    return false;
  }
}

function loadDotEnv(path, env) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals < 1) continue;

    const key = line.slice(0, equals).trim();
    if (!key || env[key] !== undefined) continue;

    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

function envFlag(raw, fallback) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(String(raw).trim().toLowerCase());
}

function boundedInteger(raw, fallback, min, max) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
