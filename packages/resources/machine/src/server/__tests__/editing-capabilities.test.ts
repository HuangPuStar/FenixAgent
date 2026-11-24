import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { parseMachineEditingConfig } from "../editing/editing-config";
import { getMachineEditingCapabilities } from "../editing/editing-runtime";
import {
  initializeMachineModuleConfig,
  stubFileWsTransport,
  stubMachineConfig,
  stubMachineEnvironmentRecord,
} from "../testing";

const actor = { organizationId: "org", userId: "user" };
beforeEach(() => {
  initializeMachineModuleConfig();
  stubMachineEnvironmentRecord({ id: "env", ...actor });
  stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "machine" }] }) }) }) });
  stubMachineConfig({
    defaultMachineId: "machine",
    fileEditing: parseMachineEditingConfig({
      publicUrl: "https://docs.example.test",
      baseUrl: "https://app.example.test",
      jwtSecret: randomBytes(32).toString("hex"),
    })!,
  });
});
afterEach(resetAllStubs);

// 文本和Office都必须具备实际执行端所需的完整条件保存能力，旧协议保留只读。
test.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, true],
])("runtime flags overwrite=%s version=%s determine editing=%s", async (uploadOverwrite, contentVersion, enabled) => {
  stubFileWsTransport({
    isFileWsConnected: () => true,
    getFileCapabilities: () => ({ uploadOverwrite, contentVersion }),
  });
  const result = await getMachineEditingCapabilities(actor, "env");
  expect(result).toMatchObject({ text: { enabled }, textMaxBytes: 2097152, office: { enabled } });
});

// Office可不部署，文本能力仍须单独按远程协议判断。
test.each([false, true])("text capability is independent of Office configuration (supported=%s)", async (enabled) => {
  stubMachineConfig({ fileEditing: undefined });
  stubFileWsTransport({
    isFileWsConnected: () => true,
    getFileCapabilities: () => ({ uploadOverwrite: enabled, contentVersion: enabled }),
  });
  expect(await getMachineEditingCapabilities(actor, "env")).toMatchObject({
    text: { enabled },
    office: { enabled: false },
  });
});

// 本地文件不依赖远程节点或Office服务，文本编辑始终保留。
test("local text editing does not require Office or a file channel", async () => {
  stubMachineConfig({ defaultMachineId: undefined, fileEditing: undefined });
  expect(await getMachineEditingCapabilities(actor, "env")).toMatchObject({
    text: { enabled: true },
    office: { enabled: false },
  });
});
