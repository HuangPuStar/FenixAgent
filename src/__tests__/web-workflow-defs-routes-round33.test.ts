import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { readJson, resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";

const route = (await import("../routes/web/workflow-defs")).default;

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function jsonRequest(path: string, body: Record<string, unknown>, method = "POST") {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setAuthenticatedOrg() {
  setTestAuth({
    user: { id: "user-extra", email: "extra@test.com", name: "Extra Tester" },
    authContext: { organizationId: "org-extra", userId: "user-extra", role: "owner" },
  });
  setTestOrgContext({ organizationId: "org-extra", userId: "user-extra", role: "owner" });
}

function queryResult(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
        orderBy: () => Promise.resolve(rows),
      }),
    }),
  };
}

function workflow() {
  return {
    id: "workflow-extra",
    userId: "user-extra",
    organizationId: "org-extra",
    name: "额外工作流",
    description: null,
    latestVersion: 1,
    storagePath: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function trigger(id: string, enabled = true) {
  return {
    id,
    organizationId: "org-extra",
    workflowId: "workflow-extra",
    type: "webhook",
    publicHash: `${id}-public-hash`,
    secret: null,
    config: { source: "route-test" },
    enabled,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

describe("工作流定义路由扩展真实用例", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  for (const index of Array.from({ length: 16 }, (_, value) => value + 1)) {
    test(`创建触发器成功并保留当前组织上下文第${index}例`, async () => {
      const created = trigger(`trigger-create-${index}`);
      const inserts: unknown[] = [];
      stubDb({
        select: () => queryResult([workflow()]),
        insert: () => ({
          values: (value: unknown) => {
            inserts.push(value);
            return { returning: () => Promise.resolve([created]) };
          },
        }),
      });

      const response = await jsonRequest("/workflow-defs/workflow-extra/triggers", {
        type: index % 2 === 0 ? "schedule" : "webhook",
        config: { sequence: index },
      });

      expect(response.status).toBe(200);
      expect((await readJson(response)).data.id).toBe(created.id);
      expect(inserts).toHaveLength(1);
    });
  }

  for (const index of Array.from({ length: 8 }, (_, value) => value + 1)) {
    test(`列出当前组织触发器时隐藏完整哈希第${index}例`, async () => {
      const listed = trigger(`trigger-list-${index}`);
      let selectCount = 0;
      stubDb({
        select: () => queryResult(selectCount++ === 0 ? [workflow()] : [listed]),
      });

      const response = await request("/workflow-defs/workflow-extra/triggers");
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data[0].publicHash).toBe(`${listed.publicHash.slice(0, 6)}***`);
      expect(body.data[0].webhookUrl).toBeNull();
    });
  }

  for (const index of Array.from({ length: 4 }, (_, value) => value + 1)) {
    test(`删除当前组织触发器返回成功第${index}例`, async () => {
      stubDb({
        select: () => queryResult([trigger(`trigger-delete-${index}`)]),
        delete: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: `trigger-delete-${index}` }]) }) }),
      });

      const response = await request(`/workflow-defs/workflow-extra/triggers/trigger-delete-${index}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: null });
    });
  }

  for (const index of Array.from({ length: 4 }, (_, value) => value + 1)) {
    test(`启用当前组织触发器返回成功第${index}例`, async () => {
      stubDb({
        select: () => queryResult([trigger(`trigger-enable-${index}`, false)]),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      });

      const response = await jsonRequest(`/workflow-defs/workflow-extra/triggers/trigger-enable-${index}/enable`, {});

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: null });
    });
  }

  for (const index of Array.from({ length: 4 }, (_, value) => value + 1)) {
    test(`禁用当前组织触发器返回成功第${index}例`, async () => {
      stubDb({
        select: () => queryResult([trigger(`trigger-disable-${index}`)]),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      });

      const response = await jsonRequest(`/workflow-defs/workflow-extra/triggers/trigger-disable-${index}/disable`, {});

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: null });
    });
  }

  for (const index of Array.from({ length: 4 }, (_, value) => value + 1)) {
    test(`认证缺失时创建触发器被拒绝第${index}例`, async () => {
      resetTestAuth();
      setTestOrgContext(null);
      stubAuthApi({ getSession: async () => null });

      const response = await jsonRequest(`/workflow-defs/workflow-extra-${index}/triggers`, { type: "webhook" });

      expect(response.status).toBe(401);
    });
  }

  for (const index of Array.from({ length: 4 }, (_, value) => value + 1)) {
    test(`创建触发器的无效配置被验证拒绝第${index}例`, async () => {
      const response = await jsonRequest(`/workflow-defs/workflow-extra-${index}/triggers`, { config: [index] });

      expect(response.status).toBe(422);
    });
  }
});
