import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const MAX_TAIL_BYTES = 8 * 1024 * 1024;

export async function readPiCompletion(sessionPath, options) {
  const safePath = await validateSessionPath(sessionPath, options.sessionRoot);
  const fileStat = await stat(safePath);
  const text = await readTail(safePath, MAX_TAIL_BYTES);
  const entries = parseJsonLines(text);

  let assistantEntry;
  let sessionName;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!sessionName && entry?.type === "session_info") {
      sessionName = cleanSingleLine(entry.name);
    }
    if (!assistantEntry && entry?.type === "message" && entry?.message?.role === "assistant") {
      assistantEntry = entry;
    }
    if (assistantEntry && sessionName) break;
  }

  const rawText = assistantEntry ? assistantText(assistantEntry.message) : "";
  const safeText = options.redactSecrets ? redactCommonSecrets(rawText) : rawText;
  const finalText = truncateMiddle(normalizeMessage(safeText), options.maxFinalChars);
  const fingerprint = assistantEntry
    ? createHash("sha256")
        .update(
          [
            safePath,
            assistantEntry.id ?? "",
            assistantEntry.timestamp ?? assistantEntry.message?.timestamp ?? "",
            assistantEntry.message?.stopReason ?? "",
            rawText,
          ].join("\u0000"),
        )
        .digest("hex")
    : undefined;

  return {
    path: safePath,
    fingerprint,
    fileSignature: `${fileStat.size}:${Math.trunc(fileStat.mtimeMs)}`,
    finalText: finalText || undefined,
    sessionName,
    assistantEntryId: assistantEntry?.id,
    assistantTimestamp: assistantEntry?.message?.timestamp ?? assistantEntry?.timestamp,
  };
}

export function sameCompletion(expected, current) {
  if (!expected || !current) return false;
  if (expected.path !== current.path) return false;
  if (expected.fingerprint || current.fingerprint) {
    return Boolean(expected.fingerprint && current.fingerprint && expected.fingerprint === current.fingerprint);
  }
  return expected.fileSignature === current.fileSignature;
}

export function redactCommonSecrets(text) {
  return String(text ?? "")
    .replace(
      /https:\/\/hooks\.slack(?:-gov)?\.com\/(?:services|triggers|workflows)\/[^\s)>\]}]+/gi,
      "[REDACTED_SLACK_WEBHOOK]",
    )
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]");
}

async function validateSessionPath(sessionPath, sessionRoot) {
  if (!sessionPath || !isAbsolute(sessionPath) || !sessionPath.endsWith(".jsonl")) {
    throw new Error("Pi session path is absent or invalid");
  }

  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(sessionRoot), realpath(sessionPath)]);
  const child = relative(resolvedRoot, resolvedPath);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Pi session path is outside the configured session root");
  }
  return resolvedPath;
}

async function readTail(path, maxBytes) {
  const fileStat = await stat(path);
  const start = Math.max(0, fileStat.size - maxBytes);
  const length = fileStat.size - start;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

function parseJsonLines(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partial or malformed line must not prevent the ready-only fallback.
    }
  }
  return entries;
}

function assistantText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

function normalizeMessage(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\t/g, "  ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return text;
  const marker = "\n\n… message truncated …\n\n";
  const remaining = maxChars - marker.length;
  const headLength = Math.max(1, Math.floor(remaining * 0.82));
  return `${text.slice(0, headLength)}${marker}${text.slice(-(remaining - headLength))}`;
}

function cleanSingleLine(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}
