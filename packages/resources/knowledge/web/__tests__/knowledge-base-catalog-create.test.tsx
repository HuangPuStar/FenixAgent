import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KNOWLEDGE_NS, knowledgeResources } from "../i18n";
import { registerReactI18nextStub } from "./react-i18next-stub";

const window = initializeHappyDomWindow(new Window({ url: "http://localhost/" }));
const globals = globalThis as Record<string, unknown>;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.window = window;
globals.document = window.document;
globals.navigator = window.navigator;
globals.HTMLElement = window.HTMLElement;
globals.customElements = window.customElements;

const i18n = createInstance();
void i18n.init({
  lng: "en",
  defaultNS: KNOWLEDGE_NS,
  initAsync: false,
  resources: { en: { [KNOWLEDGE_NS]: knowledgeResources.en } },
});
registerReactI18nextStub(i18n);

const { useKnowledgeBaseCatalog } = await import("../pages/agent-panel/pages/use-knowledge-base-catalog");
type Catalog = ReturnType<typeof useKnowledgeBaseCatalog>;

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let catalog: Catalog | null = null;
let createdBodies: Record<string, unknown>[] = [];

const onKnowledgeBaseDeleted = () => undefined;
const onKnowledgeBaseUpdated = () => undefined;

function Harness() {
  catalog = useKnowledgeBaseCatalog({
    kbId: null,
    onKnowledgeBaseDeleted,
    onKnowledgeBaseUpdated,
  });
  return null;
}

function currentCatalog(): Catalog {
  if (!catalog) throw new Error("知识库表单尚未挂载");
  return catalog;
}

async function flushRequests() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  createdBodies = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      createdBodies.push(body);
      return Response.json({ success: true, data: { id: "kb-created", name: body.name } });
    }
    const data = url.includes("form-options") ? { embeddingModels: [], chunkMethods: [], pipelines: [] } : [];
    return Response.json({ success: true, data });
  }) as typeof fetch;
  const container = window.document.createElement("div");
  root = createRoot(container as unknown as HTMLElement);
  act(() => root?.render(createElement(Harness)));
  await flushRequests();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  catalog = null;
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("知识库创建表单请求契约", () => {
  // Pipeline 模式省略不适用的分块字段，真实请求不得携带会被后端拒绝的 null。
  test("Pipeline 创建省略 chunkMethod 并保留所选模型和流水线", async () => {
    act(() => {
      currentCatalog().setFormName("Pipeline KB");
      currentCatalog().setFormEmbeddingModel("text-embedding-v2@provider");
      currentCatalog().setFormParseMethod("pipeline");
      currentCatalog().setFormPipeline("pipeline-1");
      currentCatalog().setFormChunkMethod("naive");
    });
    act(() => currentCatalog().submitForm());
    await flushRequests();

    expect(createdBodies).toEqual([
      {
        name: "Pipeline KB",
        slug: "pipeline-kb",
        embeddingModel: "text-embedding-v2@provider",
        parseMethod: "pipeline",
        pipelineId: "pipeline-1",
      },
    ]);
  });

  // 内置解析保留用户选择的分块器，省略 Pipeline 字段的修复不能破坏内置配置。
  test("内置解析创建保留所选 chunkMethod", async () => {
    act(() => {
      currentCatalog().setFormName("Builtin KB");
      currentCatalog().setFormEmbeddingModel("text-embedding-v2@provider");
      currentCatalog().setFormChunkMethod("book");
    });
    act(() => currentCatalog().submitForm());
    await flushRequests();

    expect(createdBodies[0]).toMatchObject({
      parseMethod: "builtin",
      chunkMethod: "book",
      pipelineId: null,
    });
  });
});
