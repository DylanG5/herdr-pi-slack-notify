import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function stateFileForPane(paneId, env = process.env) {
  const root =
    env.HERDR_PLUGIN_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "herdr", "plugins", "dylan.pi-slack-notify");
  const safePaneId = Buffer.from(paneId, "utf8").toString("base64url");
  return join(root, "pending", `${safePaneId}.json`);
}

export async function readPaneState(paneId, env = process.env) {
  const path = stateFileForPane(paneId, env);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writePaneState(paneId, state, env = process.env) {
  const path = stateFileForPane(paneId, env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify({ version: 1, paneId, ...state }, null, 2)}\n`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => {});
  return { version: 1, paneId, ...state };
}

export async function replacePaneStateIfToken(paneId, token, patch, env = process.env) {
  const current = await readPaneState(paneId, env);
  if (!current || current.token !== token) return false;
  await writePaneState(paneId, { ...current, ...patch }, env);
  return true;
}
