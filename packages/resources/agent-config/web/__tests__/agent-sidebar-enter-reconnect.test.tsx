import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { AgentSidebarTreeNode } from "../hooks/use-agent-sidebar-tree";

const win = initializeHappyDomWindow(new Window({ url: "http://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
const { useAgentSidebarTree } = await import("../hooks/use-agent-sidebar-tree");
const i18n = createInstance();
await i18n.init({ lng: "zh", resources: {} });

const node: AgentSidebarTreeNode = {
  agent: {
    id: "config-1",
    name: "agent",
    builtIn: false,
    model: null,
    modelId: null,
    description: null,
    agentNode: {},
    knowledgeBaseCount: 0,
  },
  environment: { id: "env-requested", name: "environment" },
  instances: [],
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** HTTP 边界延迟 enter 响应，验证通知不能早于运行态就绪。 */
function renderSidebar() {
  let resolveEnter!: (response: Response) => void;
  const pendingEnter = new Promise<Response>((resolve) => {
    resolveEnter = resolve;
  });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/enter")) return pendingEnter;
    const data = url.includes("/web/config/agents") ? { agents: [], default_agent: null } : [];
    return Response.json({ success: true, data });
  }) as typeof fetch;
  const events: unknown[] = [];
  const selections: unknown[] = [];
  const entered = (event: Event) => events.push((event as CustomEvent<unknown>).detail);
  win.addEventListener("agent:entered", entered);
  let sidebar!: ReturnType<typeof useAgentSidebarTree>;
  function Probe() {
    sidebar = useAgentSidebarTree({
      orgId: undefined,
      onSelectInstance: (...target) => selections.push(target),
    });
    return null;
  }
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    ),
  );
  return {
    events,
    selections,
    enter: () => act(() => sidebar.runEnter(node, { instanceUid: "inst-requested" })),
    finish: async (response: Response) => {
      await act(async () => {
        resolveEnter(response);
        await Bun.sleep(20);
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      win.removeEventListener("agent:entered", entered);
    },
  };
}

describe("进入实例后的连接恢复通知", () => {
  // 服务端完成 enter 后才允许恢复缓存连接，且必须使用响应中的真实实例和环境。
  test("enter 成功通知实际目标，等待期间不提前重连", async () => {
    const h = renderSidebar();
    try {
      h.enter();
      expect(h.events).toEqual([]);
      expect(h.selections).toEqual([]);
      await h.finish(
        Response.json({
          success: true,
          data: {
            environment_id: "env-resolved",
            instance_uid: "inst-resolved",
            name: "instance",
            status: "running",
            created_at: "2026-10-23T00:00:00Z",
          },
        }),
      );
      expect(h.events).toEqual([{ envId: "env-resolved", instanceUid: "inst-resolved" }]);
      expect(h.selections).toEqual([["inst-resolved", "env-resolved", "inst-resolved"]]);
    } finally {
      h.unmount();
    }
  });

  // 恢复失败不能对仍不可用的机器发起新连接，也不能切换到失败的实例。
  test("enter 失败不通知重连或导航", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const h = renderSidebar();
    try {
      h.enter();
      await h.finish(Response.json({ success: false, error: { message: "机器恢复失败" } }, { status: 503 }));
      expect(h.events).toEqual([]);
      expect(h.selections).toEqual([]);
    } finally {
      h.unmount();
      error.mockRestore();
    }
  });
});
