import { expect, test } from "bun:test";
import { createMemoryHistory } from "@tanstack/react-router";
import { createConsoleRouter } from "../router";

// URL 是标签选择的权威来源，首次加载和浏览器前后退都恢复同一标签。
test("tab selection follows the URL on reload and history navigation", async () => {
  const history = createMemoryHistory({ initialEntries: ["/?tab=servers"] });
  const router = createConsoleRouter(history);
  await router.load();
  expect(router.state.location.search.tab).toBe("servers");
  await router.navigate({ to: "/", search: { tab: "sandboxes" } });
  expect(history.location.href).toBe("/?tab=sandboxes");
  const reloaded = createConsoleRouter(createMemoryHistory({ initialEntries: [history.location.href] }));
  await reloaded.load();
  expect(reloaded.state.location.search.tab).toBe("sandboxes");
  history.back();
  await router.load();
  expect(router.state.location.search.tab).toBe("servers");
  history.forward();
  await router.load();
  expect(router.state.location.search.tab).toBe("sandboxes");
});
// 无效或缺省标签安全回落到池页面。
test("invalid tab search falls back to pools", async () => {
  const router = createConsoleRouter(createMemoryHistory({ initialEntries: ["/?tab=invalid"] }));
  await router.load();
  expect(router.state.redirect?.headers.get("location")).toBe("/?tab=pools");
});
