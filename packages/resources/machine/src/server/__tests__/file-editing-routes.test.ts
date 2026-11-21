import { afterEach, expect, test } from "bun:test";
import { EditingError } from "@fenix/file-editing/contracts";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "../../__tests__/guard-stubs";
import type { MachineFileEditingFacade } from "../facades/file-editing-facade";
import { createWebFileEditingRoutes } from "../routes/web/file-editing";

afterEach(resetTestAuth);
const calls: Array<unknown[]> = [];
const status = {
  id: "office-1",
  state: "editing" as const,
  conflict: false,
  version: "v1",
  lastSavedAt: null,
  expiresAt: Date.now() + 1000,
};
const facade: MachineFileEditingFacade = {
  async capabilities(actor, id) {
    calls.push([actor, id]);
    return { textMaxBytes: 2 * 1024 * 1024, office: { enabled: false, extensions: [], maxBytes: 0 } };
  },
  async open(actor, id, path) {
    calls.push([actor, id, path]);
    return { ...status, maxBytes: 1024, initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} } };
  },
  async status() {
    return status;
  },
  async save(actor, id, opId) {
    calls.push([actor, id, opId]);
    return { saveId: "save-1" };
  },
  async overwrite() {
    throw new EditingError("conflict", "changed again");
  },
  async close() {},
  async discard() {},
};
const routes = createWebFileEditingRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() }, facade);
function authenticate() {
  setTestAuth({
    user: { id: "u1", email: "u@example.test", name: "U" },
    authContext: { organizationId: "o1", userId: "u1", role: "member" },
  });
}

// 编辑会话控制接口必须由宿主同一份认证守卫保护。
test("editing control endpoints require authentication", async () => {
  resetTestAuth();
  expect((await routes.handle(new Request("http://localhost/environments/e1/file-editing-capabilities"))).status).toBe(
    401,
  );
});

// 路由只转交已认证身份和稳定环境 ID，不接受浏览器伪造属主。
test("office creation projects actor and rejects forged ownership fields", async () => {
  authenticate();
  const response = await routes.handle(
    new Request("http://localhost/environments/e1/office-edit-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "user/report.xlsx" }),
    }),
  );
  expect(response.status).toBe(200);
  expect(calls.at(-1)).toEqual([{ organizationId: "o1", userId: "u1", role: "member" }, "e1", "user/report.xlsx"]);
  const forged = await routes.handle(
    new Request("http://localhost/environments/e1/office-edit-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "a.xlsx", userId: "other" }),
    }),
  );
  expect(forged.status).toBe(422);
});

// 保存操作 ID透传且冲突使用标准 code，浏览器可以准确进入裁决状态。
test("save forwards stable operation id and conflict errors retain their code", async () => {
  authenticate();
  const response = await routes.handle(
    new Request("http://localhost/office-edit-sessions/office-1/save", {
      method: "POST",
      headers: { "content-type": "application/json", "x-file-op-id": "op-save-1" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(200);
  expect(calls.at(-1)?.at(-1)).toBe("op-save-1");
  const conflict = await routes.handle(
    new Request("http://localhost/office-edit-sessions/office-1/overwrite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error.code).toBe("conflict");
});
