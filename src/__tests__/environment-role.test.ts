import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "../errors";
import { resetAllStubs, stubEnvironmentRepo } from "../test-utils/helpers";

// 动态 import：environmentRepo 的 mock 是 setup-mocks.ts 注册的实时 Proxy，
// beforeEach 注入 stub 即可生效（与 fs-upload-escape.test.ts 同模式）。
const { getOwnedEnvironment } = await import("../services/environment-core");

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";

beforeEach(() => {
  resetAllStubs();
  stubEnvironmentRepo({
    getById: async (id: string) =>
      id === ENV_ID ? { id: ENV_ID, organizationId: ORG_ID, userId: USER_ID, agentConfigId: null } : null,
  });
});

afterEach(() => {
  resetAllStubs();
});

describe("getOwnedEnvironment 角色化授权（D17，403/404 分离）", () => {
  // member 写操作（传 role）必须抛 403 ForbiddenError，且不得伪装成 404。
  test("member write request is rejected with 403 ForbiddenError", async () => {
    await expect(getOwnedEnvironment(ENV_ID, ORG_ID, USER_ID, "member")).rejects.toThrow(ForbiddenError);
  });

  // owner 写操作放行，返回环境记录。
  test("owner write request passes and returns the environment", async () => {
    await expect(getOwnedEnvironment(ENV_ID, ORG_ID, USER_ID, "owner")).resolves.toMatchObject({
      id: ENV_ID,
      organizationId: ORG_ID,
    });
  });

  // admin 写操作与 owner 同等放行（owner/admin 可写为最小实现）。
  test("admin write request passes", async () => {
    await expect(getOwnedEnvironment(ENV_ID, ORG_ID, USER_ID, "admin")).resolves.toMatchObject({
      id: ENV_ID,
    });
  });

  // 不传 role（读操作或历史调用点）不触发角色检查，放行。
  test("request without role (read) passes", async () => {
    await expect(getOwnedEnvironment(ENV_ID, ORG_ID, USER_ID)).resolves.toMatchObject({
      id: ENV_ID,
    });
  });

  // 环境不存在抛 404 NotFoundError，与 403 明确区分（不得泄露环境是否存在）。
  test("missing environment throws 404 NotFoundError, distinct from 403", async () => {
    await expect(getOwnedEnvironment("env-missing", ORG_ID, USER_ID, "owner")).rejects.toThrow(NotFoundError);
    await expect(getOwnedEnvironment("env-missing", ORG_ID, USER_ID, "member")).rejects.toThrow(NotFoundError);
  });

  // 其他组织的环境不可见，保持 404 语义（403 只用于「环境存在但无操作权限」）。
  test("environment of another organization stays 404", async () => {
    await expect(getOwnedEnvironment(ENV_ID, "org-other", USER_ID, "owner")).rejects.toThrow(NotFoundError);
  });

  // agent 绑定环境（agentConfigId 非空）且访问者非 owner 时保持既有 404 语义，
  // 该检查优先于角色检查，避免向非本人泄露绑定环境的存在。
  test("agent-bound environment not owned by user stays 404", async () => {
    stubEnvironmentRepo({
      getById: async () => ({
        id: ENV_ID,
        organizationId: ORG_ID,
        userId: "owner-1",
        agentConfigId: "agent-1",
      }),
    });
    await expect(getOwnedEnvironment(ENV_ID, ORG_ID, USER_ID, "owner")).rejects.toThrow(NotFoundError);
  });
});
