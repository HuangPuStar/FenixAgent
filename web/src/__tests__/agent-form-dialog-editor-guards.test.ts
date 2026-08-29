import { describe, expect, test } from "bun:test";
import {
  type AgentEditorOption,
  paginateAgentEditorOptions,
  shouldConfirmAgentEditorClose,
  shouldShowAgentEditorLoading,
} from "../pages/agent-panel/agent-editor/agent-editor-model";
import {
  appendUnavailableNodeOption,
  dispatchAgentReconnect,
} from "../pages/agent-panel/agent-editor/use-agent-editor";

describe("Agent Editor 关闭保护与分页", () => {
  // 创建态和编辑态的 Escape 都应在存在可写草稿时触发关闭确认。
  test("可写脏表单统一触发 dirty guard", () => {
    expect(shouldConfirmAgentEditorClose(true, false)).toBe(true);
  });

  // 未修改或只读表单关闭时不应弹出无意义的草稿确认。
  test("干净或只读表单无需 dirty guard", () => {
    expect(shouldConfirmAgentEditorClose(false, false)).toBe(false);
    expect(shouldConfirmAgentEditorClose(true, true)).toBe(false);
  });

  // 重启多个 environment 时必须逐个携带权威 environment ID，并去除重复通知。
  test("逐个派发 reconnect environment ID", () => {
    const details: unknown[] = [];
    const target = {
      dispatchEvent(event: Event) {
        details.push((event as CustomEvent).detail);
        return true;
      },
    };
    dispatchAgentReconnect(["env-a", "env-b", "env-a"], target);
    expect(details).toEqual([{ envId: "env-a" }, { envId: "env-b" }]);
  });

  // 当前 Sandbox Pool 不在可见列表时仍应保留真实绑定，并安全回退显示 pool ID。
  test("补入不可见 Sandbox Pool 选项", () => {
    const nodes: AgentEditorOption[] = [{ id: "default", label: "Default" }];
    appendUnavailableNodeOption(nodes, { kind: "sandbox", sandboxPoolId: "pool-hidden" });
    expect(nodes).toEqual([
      { id: "default", label: "Default" },
      { id: "sandbox:pool-hidden", label: "pool-hidden", unavailable: true },
    ]);
  });

  // 若已有展示标签则优先使用，且可见选项不能被重复追加为 unavailable。
  test("不可见节点优先使用已有标签", () => {
    const nodes: AgentEditorOption[] = [{ id: "sandbox:pool-visible", label: "Visible Pool" }];
    appendUnavailableNodeOption(nodes, { kind: "sandbox", sandboxPoolId: "pool-visible" }, "Saved Pool");
    appendUnavailableNodeOption(nodes, { kind: "machine", machineId: "machine-hidden" }, "Builder");
    expect(nodes).toEqual([
      { id: "sandbox:pool-visible", label: "Visible Pool" },
      { id: "machine:machine-hidden", label: "Builder", unavailable: true },
    ]);
  });

  // 首批数据尚未到达时应进入稳定加载框架，避免渲染可编辑的不完整表单。
  test("首批数据加载进入稳定框架", () => {
    expect(shouldShowAgentEditorLoading(true, false, false)).toBe(true);
    expect(shouldShowAgentEditorLoading(false, false, false)).toBe(true);
  });

  // 已有表单数据后的后台刷新不得替换整个编辑器，只保留局部请求反馈。
  test("后台刷新保留已渲染编辑器", () => {
    expect(shouldShowAgentEditorLoading(true, true, false)).toBe(false);
    expect(shouldShowAgentEditorLoading(false, false, true)).toBe(false);
  });

  // 大数据选择器每次只允许一页数据进入 DOM，并保留完整结果计数。
  test("选择器分页限制单批 DOM 数量", () => {
    const result = paginateAgentEditorOptions(
      Array.from({ length: 121 }, (_, index) => index),
      1,
      50,
    );
    expect(result.items).toHaveLength(50);
    expect(result.items[0]).toBe(50);
    expect(result.total).toBe(121);
    expect(result.pageCount).toBe(3);
  });
});
