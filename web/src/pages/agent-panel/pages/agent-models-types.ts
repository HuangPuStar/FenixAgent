import type { ProviderInfo, ProviderModel } from "../../../types/config";

export interface ProviderCatalogData {
  providers: ProviderInfo[];
  modelsByProvider: Record<string, ProviderModel[]>;
  detailFailures: string[];
}

export interface ProviderDraft {
  id: string;
  displayName: string;
  protocol: "openai" | "anthropic";
  apiKey: string;
  baseURL: string;
  selectedModels: string[];
}

export interface ModelDraft {
  id: string;
  name: string;
  context: string;
  output: string;
  inputModalities: string[];
  outputModalities: string[];
  thinkingEnabled: boolean;
  thinkingBudget: string;
  inputCost: string;
  outputCost: string;
}

export type ProviderDialogTarget = { mode: "create" } | { mode: "edit" | "view"; provider: ProviderInfo };

export type ModelDialogTarget =
  | { mode: "create"; providerKey: string }
  | { mode: "edit" | "view"; providerKey: string; model: ProviderModel };

export interface DiscoveryState {
  providerKey: string;
  models: string[];
  addedIds: Set<string>;
  warning?: string;
}

export interface ModelTestState {
  key: string;
  status: "running" | "success" | "error";
  detail?: string;
}
