// web/__tests__/admin-key-gate.test.tsx
// AdminKeyGate 的展示契约：锁定时渲染密钥表单（含错误提示与无障碍属性），解锁后只渲染 children。
//
// 为什么只在库内断言这一层：取数、写 key 与 401 回门由 `@fenix/web-runtime/hooks/use-admin-key-gate`
// 承担（本包是纯展示包，不得依赖 web-runtime），库内能钉住的正是「受控 props → DOM」这段映射。
// 四个消费方（sandbox / observer 3 页 / model-management）的标题与提示文案各不相同，因此文案必须
// 原样出现在 DOM 里——这是「库内组件不绑定 i18n 命名空间」的可验证形式。

import { describe, expect, test } from "bun:test";
import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import ReactDOMServer from "react-dom/server";

const TEXTS = {
  title: "需要 Master Key",
  description: "输入系统 master key 后进入管理面板。",
  inputPlaceholder: "系统 master key",
  submitLabel: "进入面板",
};

describe("AdminKeyGate", () => {
  test("锁定时渲染表单：传入文案原样出现，且不渲染 children", () => {
    const html = ReactDOMServer.renderToString(
      <AdminKeyGate unlocked={false} error={null} onUnlock={() => {}} {...TEXTS}>
        <p>面板内容</p>
      </AdminKeyGate>,
    );

    expect(html).toContain(TEXTS.title);
    expect(html).toContain(TEXTS.description);
    expect(html).toContain(TEXTS.inputPlaceholder);
    expect(html).toContain(TEXTS.submitLabel);
    expect(html).toContain('type="password"');
    expect(html).toContain(`aria-label="${TEXTS.inputPlaceholder}"`);
    expect(html).not.toContain("面板内容");
  });

  test("解锁后只渲染 children，表单与错误提示都不在 DOM 里", () => {
    const html = ReactDOMServer.renderToString(
      <AdminKeyGate unlocked={true} error="master key 无效或已失效" onUnlock={() => {}} {...TEXTS}>
        <p>面板内容</p>
      </AdminKeyGate>,
    );

    expect(html).toContain("面板内容");
    expect(html).not.toContain(TEXTS.submitLabel);
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("master key 无效或已失效");
  });

  test("带错误回门时用 role=alert 播报，并把它挂到输入框的 aria-describedby 上", () => {
    const html = ReactDOMServer.renderToString(
      <AdminKeyGate unlocked={false} error="master key 无效或已失效" onUnlock={() => {}} {...TEXTS}>
        <p>面板内容</p>
      </AdminKeyGate>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("master key 无效或已失效");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });

  test("无错误时不播报：没有 role=alert，输入框也不标为非法", () => {
    const html = ReactDOMServer.renderToString(
      <AdminKeyGate unlocked={false} error={null} onUnlock={() => {}} {...TEXTS}>
        <p>面板内容</p>
      </AdminKeyGate>,
    );

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain("aria-describedby");
  });
});
