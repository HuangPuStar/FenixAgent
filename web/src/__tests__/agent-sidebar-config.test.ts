import { describe, expect, test } from "bun:test";
import { filterNavGroups, SIDEBAR_NAV_GROUPS } from "../pages/agent-panel/AgentSidebarConfig";

describe("agent sidebar config", () => {
  // 黑名单命中的 tab 会从对应导航组中移除
  test("filterNavGroups removes hidden items", () => {
    const filtered = filterNavGroups(SIDEBAR_NAV_GROUPS, ["models", "mcp"]);
    const configGroup = filtered.find((group) => group.id === "config");

    expect(configGroup?.items.map((item) => item.id)).not.toContain("models");
    expect(configGroup?.items.map((item) => item.id)).not.toContain("mcp");
  });

  // 过滤后空掉的导航组不会继续渲染
  test("filterNavGroups removes empty groups", () => {
    const filtered = filterNavGroups(SIDEBAR_NAV_GROUPS, ["home", "agents", "workflow"]);

    expect(filtered.find((group) => group.id === "core")).toBeUndefined();
  });

  // 未知 id 不会影响现有导航项，前端仅按命中的 item id 过滤
  test("filterNavGroups ignores unknown hidden ids", () => {
    const filtered = filterNavGroups(SIDEBAR_NAV_GROUPS, ["unknown-tab"]);
    const configGroup = filtered.find((group) => group.id === "config");

    expect(configGroup?.items.map((item) => item.id)).toContain("models");
    expect(configGroup?.items.map((item) => item.id)).toContain("mcp");
  });
});
