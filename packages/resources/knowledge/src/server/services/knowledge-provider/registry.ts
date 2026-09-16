import { RagFlowKnowledgeProvider } from "./ragflow";
import type { KnowledgeProvider } from "./types";

let testProvider: KnowledgeProvider | null = null;

export function getKnowledgeProvider(): KnowledgeProvider {
  if (testProvider) return testProvider;
  return new RagFlowKnowledgeProvider();
}

export function setKnowledgeProviderForTesting(p: KnowledgeProvider | null): void {
  testProvider = p;
}
