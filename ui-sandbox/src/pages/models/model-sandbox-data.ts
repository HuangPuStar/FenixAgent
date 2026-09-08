import type { OwnedResourceScope } from "../../lib/resource-scope";

export interface SandboxModel {
  id: string;
  name: string;
  context: string;
  thinking?: string;
  cost: { input: number; output: number };
}

export interface SandboxProvider {
  id: string;
  name: string;
  protocol: "OpenAI 兼容" | "Anthropic";
  endpoint: string;
  keyHint: string;
  publicRead: boolean;
  version: number;
  color: string;
  updatedAt: string;
  models: SandboxModel[];
  scope: OwnedResourceScope;
}

export type ModelDialogState =
  | { kind: "provider"; provider?: SandboxProvider }
  | { kind: "model"; provider: SandboxProvider; model?: SandboxModel }
  | { kind: "discover"; provider: SandboxProvider }
  | { kind: "delete-provider"; provider: SandboxProvider }
  | { kind: "delete-model"; provider: SandboxProvider; model: SandboxModel };

export const INITIAL_PROVIDERS: SandboxProvider[] = [
  {
    id: "openai-production",
    name: "OpenAI Production",
    protocol: "OpenAI 兼容",
    endpoint: "https://api.openai.com/v1",
    keyHint: "sk-proj-••••8D2F",
    publicRead: false,
    version: 5,
    color: "#15977e",
    updatedAt: "今天 09:42",
    models: [
      {
        id: "gpt-5.2",
        name: "GPT-5.2",
        context: "400K",
        thinking: "32K 思考预算",
        cost: { input: 1.75, output: 14 },
      },
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        context: "1M",
        cost: { input: 0.4, output: 1.6 },
      },
    ],
    scope: "本组织",
  },
  {
    id: "anthropic-cn",
    name: "Anthropic",
    protocol: "Anthropic",
    endpoint: "https://api.anthropic.com",
    keyHint: "sk-ant-••••92AC",
    publicRead: true,
    version: 3,
    color: "#b27b55",
    updatedAt: "昨天 18:20",
    models: [
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        context: "200K",
        thinking: "可配置思考",
        cost: { input: 3, output: 15 },
      },
    ],
    scope: "平台",
  },
  {
    id: "bailian-token-plan",
    name: "阿里云百炼",
    protocol: "OpenAI 兼容",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyHint: "sk-••••71B8",
    publicRead: false,
    version: 7,
    color: "#6659d9",
    updatedAt: "8 月 23 日",
    models: [
      {
        id: "qwen3-max",
        name: "Qwen3 Max",
        context: "256K",
        thinking: "64K 思考预算",
        cost: { input: 1.2, output: 6 },
      },
      {
        id: "qwen-vl-max",
        name: "Qwen VL Max",
        context: "128K",
        cost: { input: 0.8, output: 3.2 },
      },
    ],
    scope: "个人",
  },
  {
    id: "deepseek-internal",
    name: "DeepSeek 内网网关",
    protocol: "OpenAI 兼容",
    endpoint: "https://llm-gateway.internal/v1",
    keyHint: "{env:RCS_SECRET_DEEPSEEK}",
    publicRead: false,
    version: 2,
    color: "#4773df",
    updatedAt: "8 月 21 日",
    models: [
      {
        id: "deepseek-v3.2",
        name: "DeepSeek V3.2",
        context: "128K",
        thinking: "模型原生思考",
        cost: { input: 0.28, output: 0.42 },
      },
    ],
    scope: "本组织",
  },
];

export const DISCOVERED_MODELS = ["gpt-5.2-codex", "gpt-5.2-mini", "text-embedding-3-large", "omni-moderation-latest"];

export function contextToTokens(context: string): number {
  const value = Number.parseFloat(context);
  if (context.endsWith("M")) return value * 1_000_000;
  if (context.endsWith("K")) return value * 1_000;
  return value;
}

export function createDiscoveredModel(id: string): SandboxModel {
  return {
    id,
    name: id,
    context: "128K",
    cost: { input: 0, output: 0 },
  };
}
