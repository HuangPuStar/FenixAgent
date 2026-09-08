export type DemoScenarioId =
  | "conversation"
  | "longConversation"
  | "markdown"
  | "tools"
  | "permission"
  | "askUser"
  | "subtask"
  | "files"
  | "assets"
  | "failure"
  | "empty";

export type ContextTab = "files" | "sites" | "tasks" | "views";

export interface DemoScenario {
  id: DemoScenarioId;
  status: "ready" | "thinking" | "running" | "waiting" | "recovering";
  contextTab: ContextTab;
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  { id: "conversation", status: "ready", contextTab: "files" },
  { id: "longConversation", status: "ready", contextTab: "files" },
  { id: "markdown", status: "ready", contextTab: "files" },
  { id: "tools", status: "running", contextTab: "files" },
  { id: "permission", status: "waiting", contextTab: "tasks" },
  { id: "askUser", status: "waiting", contextTab: "files" },
  { id: "subtask", status: "running", contextTab: "tasks" },
  { id: "files", status: "ready", contextTab: "files" },
  { id: "assets", status: "ready", contextTab: "sites" },
  { id: "failure", status: "recovering", contextTab: "views" },
  { id: "empty", status: "ready", contextTab: "files" },
] as const;

export function getDemoScenario(id: DemoScenarioId): DemoScenario {
  return DEMO_SCENARIOS.find((scenario) => scenario.id === id) ?? DEMO_SCENARIOS[0];
}
