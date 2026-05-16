import { createKnowledgeProvider } from "./openviking";
import type { KnowledgeProvider } from "./types";

let provider: KnowledgeProvider | null = null;

export function getKnowledgeProvider(): KnowledgeProvider {
  if (!provider) {
    provider = createKnowledgeProvider();
  }
  return provider;
}

export function setKnowledgeProviderForTesting(p: KnowledgeProvider | null): void {
  provider = p;
}
