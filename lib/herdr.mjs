import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getAgent(target, env = process.env) {
  const response = await runHerdr(["agent", "get", target], env);
  return response?.result?.agent;
}

export async function getPresentation(agent, env = process.env) {
  const [workspaceResult, tabResult] = await Promise.allSettled([
    runHerdr(["workspace", "get", agent.workspace_id], env),
    runHerdr(["tab", "get", agent.tab_id], env),
  ]);

  const workspace = workspaceResult.status === "fulfilled" ? workspaceResult.value?.result?.workspace : undefined;
  const tab = tabResult.status === "fulfilled" ? tabResult.value?.result?.tab : undefined;
  const tabLabel = namedLabel(tab?.label);

  return {
    workspaceLabel: cleanLabel(workspace?.label) ?? cleanLabel(agent.cwd) ?? agent.workspace_id ?? "workspace",
    tabLabel,
    paneId: agent.pane_id,
  };
}

export function summarizeAgent(agent) {
  if (!agent) return undefined;
  return {
    agent: agent.agent,
    agentStatus: agent.agent_status,
    paneId: agent.pane_id,
    terminalId: agent.terminal_id,
    workspaceId: agent.workspace_id,
    tabId: agent.tab_id,
    cwd: agent.foreground_cwd ?? agent.cwd,
    session: agent.agent_session
      ? {
          agent: agent.agent_session.agent,
          source: agent.agent_session.source,
          kind: agent.agent_session.kind,
          value: agent.agent_session.value,
        }
      : undefined,
  };
}

export function isSameAgent(expected, current) {
  if (!expected || !current) return false;
  if (expected.terminalId && current.terminal_id && expected.terminalId !== current.terminal_id) return false;

  const currentSession = current.agent_session;
  if (expected.session) {
    if (!currentSession) return false;
    if (
      expected.session.kind !== currentSession.kind ||
      expected.session.value !== currentSession.value ||
      expected.session.agent !== currentSession.agent
    ) {
      return false;
    }
  }
  return true;
}

export async function runHerdr(args, env = process.env) {
  const binary = env.HERDR_BIN_PATH || "herdr";
  let stdout;
  try {
    ({ stdout } = await execFileAsync(binary, args, {
      encoding: "utf8",
      env,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }

  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} returned invalid JSON`);
  }
}

function namedLabel(value) {
  const label = cleanLabel(value);
  return label && !/^\d+$/.test(label) ? label : undefined;
}

function cleanLabel(value) {
  const label = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return label || undefined;
}
