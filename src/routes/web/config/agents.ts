import { Hono } from "hono";
import { sessionAuth } from "../../../auth/middleware";
import { getSection, setSection, setTopLevelField, getConfig, replaceSection } from "../../../services/config";

const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction"]);

function isValidAgentName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
      && name.length >= 1 && name.length <= 64
      && !name.includes("--");
}

function isValidMode(mode: string): boolean {
  return ["primary", "subagent", "all"].includes(mode);
}

function isValidSteps(steps: number): boolean {
  return Number.isInteger(steps) && steps >= 1 && steps <= 200;
}

function validateAgentData(data: Record<string, unknown>): string | null {
  if (data.mode !== undefined && !isValidMode(data.mode as string)) return "INVALID_MODE";
  if (data.steps !== undefined && !isValidSteps(data.steps as number)) return "INVALID_STEPS";
  return null;
}

async function handleList() {
  const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
  const config = await getConfig();
  const defaultAgent = config.default_agent as string | undefined;
  const list = Object.entries(agents).map(([name, cfg]) => ({
    name,
    builtIn: BUILT_IN_AGENTS.has(name),
    model: cfg.model ?? null,
    mode: cfg.mode ?? null,
  }));
  return { success: true, data: { default_agent: defaultAgent ?? null, agents: list } };
}

async function handleGet(name: string) {
  const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
  const agent = agents[name];
  if (!agent) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };
  return {
    success: true,
    data: {
      name,
      builtIn: BUILT_IN_AGENTS.has(name),
      model: agent.model ?? null,
      prompt: agent.prompt ?? null,
      tools: agent.tools ?? null,
      steps: agent.steps ?? null,
      mode: agent.mode ?? null,
      permission: agent.permission ?? null,
    },
  };
}

async function handleSet(name: string, data: Record<string, unknown>) {
  const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
  if (!agents[name]) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };
  const validation = validateAgentData(data);
  if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };
  agents[name] = { ...agents[name], ...data };
  await setSection("agent", agents);
  return { success: true, data: { name, ...data } };
}

async function handleCreate(name: string, data: Record<string, unknown>) {
  if (!isValidAgentName(name)) {
    return { success: false, error: { code: "VALIDATION_ERROR", message: "Invalid agent name: must be 1-64 lowercase alphanumeric chars with single hyphens" } };
  }
  const validation = validateAgentData(data);
  if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };
  const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
  if (agents[name]) return { success: false, error: { code: "ALREADY_EXISTS", message: `Agent '${name}' already exists` } };
  agents[name] = data;
  await setSection("agent", agents);
  return { success: true, data: { name } };
}

async function handleDelete(name: string) {
  if (BUILT_IN_AGENTS.has(name)) {
    return { success: false, error: { code: "FORBIDDEN", message: `Cannot delete built-in agent '${name}'` } };
  }
  const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
  if (!agents[name]) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };
  delete agents[name];
  await replaceSection("agent", agents);
  return { success: true };
}

async function handleSetDefault(name: string) {
  const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
  if (!agents[name]) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };
  await setTopLevelField("default_agent", name);
  return { success: true, data: { default_agent: name } };
}

const app = new Hono();

app.post("/config/agents", sessionAuth, async (c) => {
  const body = await c.req.json<{ action: string; name?: string; data?: Record<string, unknown> }>().catch((): { action: string; name?: string; data?: Record<string, unknown> } => ({ action: "" }));
  const { action, name, data } = body;

  switch (action) {
    case "list": return c.json(await handleList());
    case "get": return c.json(await handleGet(name!));
    case "set": return c.json(await handleSet(name!, data!));
    case "create": return c.json(await handleCreate(name!, data!));
    case "delete": return c.json(await handleDelete(name!));
    case "set_default": return c.json(await handleSetDefault(name!));
    default: return c.json({ success: false, error: { code: "VALIDATION_ERROR", message: `Unknown action '${action}'` } }, 400);
  }
});

export default app;
