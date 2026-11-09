import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { createInstance } from "i18next";
import { ORGS_NS, orgResources } from "../i18n";
import type { MachineView } from "../pages/agent-panel/pages/agent-organizations-types";
import {
  canOperateMachine,
  getOrganizationCreateErrorMessage,
  nameToSlug,
  parseLabels,
  readDefaultMachineId,
} from "../pages/agent-panel/pages/agent-organizations-utils";

const MACHINE: MachineView = {
  id: "machine-1",
  organizationId: "org-1",
  userId: null,
  agentName: "opencode",
  name: "Runtime",
  status: "offline",
  machineInfo: null,
  labels: [],
};

describe("agent organization view utilities", () => {
  // 组织名称转换为 URL 标识时保留中文，并清理重复分隔符。
  test("creates a stable organization slug", () => {
    expect(nameToSlug("研发 中心 / Platform")).toBe("研发-中心-platform");
  });

  // 默认执行节点缺失或为空时必须回退到本地运行，避免展示不存在的机器。
  test("reads the configured default machine safely", () => {
    expect(readDefaultMachineId(undefined)).toBe("local");
    expect(readDefaultMachineId({ defaultEngine: { machineId: "machine-1" } })).toBe("machine-1");
  });

  // 机器操作同时受组织、成员身份和管理权限约束，跨组织记录不得暴露写操作。
  test("guards machine actions by organization and ownership", () => {
    expect(canOperateMachine(MACHINE, "org-1", "user-1", true)).toBe(true);
    expect(canOperateMachine(MACHINE, "org-2", "user-1", true)).toBe(false);
    expect(canOperateMachine({ ...MACHINE, userId: "user-2" }, "org-1", "user-1", true)).toBe(false);
  });

  // 标签输入按逗号拆分并过滤空项，保持提交给注册表 API 的数据干净。
  test("normalizes machine labels", () => {
    expect(parseLabels("sandbox, production, ,gpu")).toEqual(["sandbox", "production", "gpu"]);
  });
});

// 稳定的 Slug 冲突码应转成本包中文词条，其他故障保留服务端说明。
test("组织创建冲突显示中文提示", () => {
  const i18n = createInstance();
  void i18n.init({
    lng: "zh",
    initAsync: false,
    defaultNS: ORGS_NS,
    resources: { zh: { [ORGS_NS]: orgResources.zh } },
  });
  const translate = (key: string) => i18n.t(key);
  expect(
    getOrganizationCreateErrorMessage(
      new ApiError("Organization slug already taken", "ORGANIZATION_SLUG_ALREADY_TAKEN"),
      translate,
    ),
  ).toMatch(/Slug.*(占用|使用)/);
  expect(getOrganizationCreateErrorMessage(new Error("服务暂时不可用"), translate)).toBe("服务暂时不可用");
});
