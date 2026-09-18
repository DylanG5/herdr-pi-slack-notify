import { markdownToPlainText, neutralizePlainMentions } from "./markdown.mjs";

const MAX_WORKFLOW_TEXT_CHARS = 3_900;

// Slack Workflow Builder drops our `text` variable into a plain-text field, so
// the message is built as plain text: no mrkdwn markers, no pane id, no mention.
export function buildSlackPayload({
  channelLabel,
  workspaceLabel,
  tabLabel,
  sessionName,
  finalText,
  delaySeconds,
  test = false,
}) {
  const terminal = [workspaceLabel, tabLabel].filter(Boolean).join(" · ") || "Herdr";

  const header = [`Terminal: ${plainInline(terminal)}`];
  if (sessionName) {
    header.push(`Session: ${plainInline(sessionName)}`);
  }

  const parts = [header.join("\n")];
  parts.push(
    test
      ? `Workflow test for ${plainInline(channelLabel)}.`
      : `Completed and unseen for ${formatDuration(delaySeconds)}.`,
  );

  const body = finalText ? markdownToPlainText(finalText) : "";
  parts.push(body ? `Agent response:\n${body}` : "Pi finished and is ready for review.");

  return {
    text: truncate(parts.join("\n\n").trim(), MAX_WORKFLOW_TEXT_CHARS),
  };
}

export async function postSlackWebhook(webhookUrl, payload, options = {}) {
  const attempts = options.attempts ?? 3;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      await sleep(attempt * 1_000);
      continue;
    }

    const body = await response.text().catch(() => "");
    if (response.ok) return;

    lastError = new Error(`Slack workflow webhook returned HTTP ${response.status}${body ? `: ${plain(body, 200)}` : ""}`);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) throw lastError;

    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1_000 : attempt * 1_000);
  }

  throw lastError ?? new Error("Slack workflow webhook failed");
}

// A single-line, plain-text fragment for labels. No HTML entities: a plain-text
// field would show `&amp;` literally. Mention tokens are made inert for safety.
function plainInline(value) {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return neutralizePlainMentions(cleaned);
}

function plain(value, maxChars) {
  return truncate(
    String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim(),
    maxChars,
  );
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatDuration(seconds) {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} seconds`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
