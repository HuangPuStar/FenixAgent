import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { act } from "react";
import { I18nextProvider } from "react-i18next";
import type { WorkflowV2WorkflowItem } from "../api/workflows";
import en from "../i18n/locales/en/workflows.json";
import zh from "../i18n/locales/zh/workflows.json";
import { WORKFLOW_NS } from "../i18n/namespace";
import { WorkflowListCards } from "../pages/list/workflow-list-cards";
import { mountCanvas } from "./canvas-host-harness";

const i18n = createInstance();
await i18n.init({ lng: "zh", initAsync: false, resources: { zh: { [WORKFLOW_NS]: zh }, en: { [WORKFLOW_NS]: en } } });
const ITEM: WorkflowV2WorkflowItem = {
  id: "local-1",
  upstreamWorkflowId: "upstream-1",
  appId: "app-1",
  name: "客服工作流",
  ownerUserId: "user-1",
  visibility: "private",
  publishState: "unpublished",
  publishedVersion: null,
  syncState: "active",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
let mount: ReturnType<typeof mountCanvas>;
let opened: WorkflowV2WorkflowItem[];
let logs: WorkflowV2WorkflowItem[];

beforeEach(() => {
  mount = mountCanvas();
  opened = [];
  logs = [];
});
afterEach(() => mount.unmount());

async function render(item = ITEM) {
  await mount.render(
    <I18nextProvider i18n={i18n}>
      <WorkflowListCards
        items={[item]}
        onOpenCanvas={(target) => opened.push(target)}
        onOpenRunLogs={(target) => logs.push(target)}
        onOpenLogs={() => {}}
        onOpenApi={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
    </I18nextProvider>,
  );
}

function button(label: string): HTMLButtonElement {
  const target = [...mount.container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  if (!target) throw new Error(`按钮未渲染：${label}`);
  return target;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

describe("工作流卡片的数据与操作", () => {
  // 未发布与读取失败代表不同事实，不能借默认版本把未知状态伪装为已发布。
  test("四态解释与版本遵循上游事实，删除中优先", async () => {
    await render();
    expect(mount.container.textContent).toContain("未发布");
    expect(mount.container.textContent).toContain(zh.list.status_hint.unpublished);
    await render({ ...ITEM, publishState: "published", publishedVersion: "v0.0.2" });
    expect(mount.container.textContent).toContain("已发布");
    expect(mount.container.textContent).toContain("v0.0.2");
    expect(mount.container.textContent).not.toContain("vv0.0.2");
    await render({ ...ITEM, publishState: "unknown", publishedVersion: "v0.0.2" });
    expect(mount.container.textContent).toContain("状态未知");
    expect(mount.container.textContent).toContain(zh.list.status_hint.unknown);
    expect(mount.container.textContent).not.toContain("v0.0.2");
    await render({ ...ITEM, syncState: "pending_delete", publishState: "published", publishedVersion: "v0.0.2" });
    expect(mount.container.textContent).toContain("删除中");
    expect(mount.container.textContent).toContain(zh.list.status_hint.pending_delete);
    expect(mount.container.textContent).not.toContain("已发布");
  });

  // 常驻日志与画布入口相互独立，操作必须传回对应工作流，而非触发卡片父层导航。
  test("无需菜单即可打开运行日志，画布标题与按钮都传递正确目标", async () => {
    await render();
    await click("运行日志");
    expect(logs).toEqual([ITEM]);
    expect(opened).toEqual([]);
    await click(ITEM.name);
    await click("打开画布");
    expect(opened).toEqual([ITEM, ITEM]);
    expect(button("运行日志").getAttribute("aria-label")).toContain(ITEM.name);
  });

  // 删除中不再允许编辑，但保留只读日志便于用户核对已有记录。
  test("删除中禁用标题和画布入口，日志仍可查看", async () => {
    const item = { ...ITEM, syncState: "pending_delete" as const };
    await render(item);
    expect(button(item.name).disabled).toBe(true);
    expect(button("打开画布").disabled).toBe(true);
    await click(item.name);
    await click("打开画布");
    expect(opened).toEqual([]);
    await click("运行日志");
    expect(logs).toEqual([item]);
  });

  // 时间只描述注册表更新，不暗示不存在的运行记录或画布保存记录。
  test("信息更新时间提供绝对时间且不展示虚构的运行统计", async () => {
    await render();
    const time = mount.container.querySelector("time");
    expect(time?.dateTime).toBe(ITEM.updatedAt);
    expect(time?.title).toBe(new Date(ITEM.updatedAt).toLocaleString("zh"));
    expect(mount.container.textContent).toContain("信息更新");
    expect(mount.container.textContent).not.toContain("成功率");
    expect(mount.container.textContent).not.toContain("最近运行");
  });
});
