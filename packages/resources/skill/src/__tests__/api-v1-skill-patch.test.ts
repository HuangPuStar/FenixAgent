import { afterEach, expect, test } from "bun:test";
import { createApiSkillsRoutes } from "../server/routes/api/skills";
import {
  authorizedSkill,
  authorizedSkillDetail,
  installSkillModuleStub,
  resetSkillModuleStub,
  testActor,
} from "./fixtures";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

afterEach(resetSkillModuleStub);
// ID 更新不泄漏文件绝对路径，字段缺席不会由 DTO 填充默认值。
test("v1 Skill PATCH accepts partial data and returns safe envelope", async () => {
  let content = "old",
    metadata = { old: "value" };
  installSkillModuleStub({
    facade: {
      updateById: async (_a, _id, input) => {
        if (input.content !== undefined) content = input.content;
        if (input.metadata !== undefined) metadata = input.metadata as typeof metadata;
        return authorizedSkill();
      },
      readDetailById: async () => ({ ...authorizedSkillDetail(), content, metadata }),
    },
  });
  const app = createApiSkillsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin(testActor()) });
  const response = await app.handle(
    new Request("http://localhost/api/v1/skills/skill-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: {} }),
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.data.content).toBe("old");
  expect(body.data.metadata).toEqual({});
  expect(body.data.path).toBeUndefined();
  expect(body.data.resourceAccess).toBeUndefined();
});
