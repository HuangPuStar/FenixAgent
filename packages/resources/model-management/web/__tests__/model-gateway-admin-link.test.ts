import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { browserAdminUiUrl } from "../lib/model-gateway-admin-url";

const execute = promisify(execFile);
const fixture = join(import.meta.dir, "fixtures", "model-gateway-admin-link.fixture.tsx");

/** 渲染用例独立运行，避免全包测试中的 react-i18next 模块替身污染真实字典。 */
async function runPanelScenario(scenario: "missing" | "error" | "configured"): Promise<void> {
  await execute(process.execPath, [fixture, scenario], { timeout: 10_000, maxBuffer: 1024 * 1024 });
}

describe("模型网关管理员浏览器入口", () => {
  // 远端控制台不能把服务端回环地址当成管理员浏览器可达地址。
  test("远端浏览器拒绝本机地址与非网页协议", () => {
    expect(browserAdminUiUrl("http://127.0.0.1:34000/ui/", "fenix.example.test")).toBeNull();
    expect(browserAdminUiUrl("http://localhost:4000/ui/", "fenix.example.test")).toBeNull();
    expect(browserAdminUiUrl("http://[::1]:4000/ui/", "fenix.example.test")).toBeNull();
    expect(browserAdminUiUrl("http://[::]:4000/ui/", "fenix.example.test")).toBeNull();
    expect(browserAdminUiUrl("http://0.0.0.0:4000/ui/", "fenix.example.test")).toBeNull();
    expect(browserAdminUiUrl("https://user:password@gateway.example.test/ui/", "fenix.example.test")).toBeNull();
    expect(browserAdminUiUrl("javascript:alert(1)", "fenix.example.test")).toBeNull();
  });

  // 本机开发仍可打开本机 LiteLLM；公开配置应规范化后进入新标签页。
  test("本机开发与公开地址可用于浏览器导航", () => {
    expect(browserAdminUiUrl("http://localhost:4000/ui/", "127.0.0.1")).toBe("http://localhost:4000/ui/");
    expect(browserAdminUiUrl("http://[::1]:4000/ui/", "[::1]")).toBe("http://[::1]:4000/ui/");
    expect(browserAdminUiUrl("HTTPS://GATEWAY.EXAMPLE.TEST/ui/", "fenix.example.test")).toBe(
      "https://gateway.example.test/ui/",
    );
  });

  // 缺少浏览器地址时显示配置指引，不能呈现一个会连接浏览器本机的锚点。
  test("配置缺失显示明确错误且禁用外链", async () => {
    await runPanelScenario("missing");
  });

  // 配置读取失败与未配置应区分，失败时有重试出口。
  test("配置读取失败显示可重试错误", async () => {
    await runPanelScenario("error");
  });

  // 配置为公开网页地址时，模型页应生成可点击的新标签页链接。
  test("公开管理地址生成可点击链接", async () => {
    await runPanelScenario("configured");
  });
});
