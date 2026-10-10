import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import * as tenantBinding from "../server/repositories/tenant-binding-repository";
import {
  handleCanvasPassthrough,
  resetGetProcessBudget,
  resetRateLimitBuckets,
} from "../server/services/canvas-passthrough";
import { issueCode, redeemCode } from "../server/services/iframe-ticket";
import * as upstream from "../server/services/upstream-client";
import * as workflowRegistry from "../server/services/workflow-registry";
import { createWorkflowV2ModuleConfig } from "../server/testing";

const ORGANIZATION_ID = "execution-context-org";
const WORKFLOW_ID = "execution-context-workflow";
const SPACE_ID = "execution-context-space";
const APP_ID = "execution-context-app";
const USER_ID = "execution-context-user";
const calls: upstream.UpstreamCallInput[] = [];
const restoreSpies: Array<() => void> = [];

beforeEach(() => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ moduleConfigs: { "workflow-v2": createWorkflowV2ModuleConfig() } });
  resetRateLimitBuckets();
  resetGetProcessBudget();
  calls.length = 0;
  const workflowSpy = spyOn(workflowRegistry, "findWorkflowByUpstreamId").mockImplementation(
    async (organizationId, workflowId) =>
      organizationId === ORGANIZATION_ID && workflowId === WORKFLOW_ID
        ? {
            id: "execution-context-local-id",
            organizationId: ORGANIZATION_ID,
            upstreamWorkflowId: WORKFLOW_ID,
            appId: APP_ID,
            name: "execution context",
            ownerUserId: USER_ID,
            visibility: "private",
            syncState: "active",
          }
        : null,
  );
  const bindingSpy = spyOn(tenantBinding, "findTenantBinding").mockResolvedValue({
    platformSpaceId: SPACE_ID,
    appId: APP_ID,
    platformStatus: "active",
    appStatus: "active",
  });
  const upstreamSpy = spyOn(upstream, "callUpstream").mockImplementation(async (input) => {
    calls.push(input);
    const body = input.body as Record<string, unknown> | undefined;
    return body?.project_id !== undefined && body.bot_id !== undefined
      ? {
          status: 200,
          body: {
            code: 777777772,
            msg: "Workflow execution failure: project_id and bot_id cannot be set at the same time",
          },
        }
      : { status: 200, body: { code: 0, data: { execute_id: "execution-context-run", workflow_id: WORKFLOW_ID } } };
  });
  restoreSpies.push(
    () => workflowSpy.mockRestore(),
    () => bindingSpy.mockRestore(),
    () => upstreamSpy.mockRestore(),
  );
});

afterEach(() => {
  for (const restore of restoreSpies.splice(0)) restore();
  resetAllStubs();
});

function ticketFor(organizationId = ORGANIZATION_ID): string {
  const issued = issueCode({ userId: USER_ID, orgId: organizationId, workflowId: WORKFLOW_ID });
  const redeemed = redeemCode(issued.code);
  if (!redeemed) throw new Error("测试画布票据兑换失败");
  return redeemed.ticket;
}

describe("画布执行上下文", () => {
  // App 内运行只注入权威 project_id，客户端伪造的 bot_id 必须剥离，避免上游互斥检查拒绝执行。
  test.each(["test_run", "nodeDebug"])("%s forwards only the authorized project context", async (endpoint) => {
    const body = {
      workflow_id: WORKFLOW_ID,
      input: { text: "execution context" },
      space_id: "forged-space",
      project_id: "forged-project",
      bot_id: "forged-bot",
    };
    const result = await handleCanvasPassthrough({
      method: "POST",
      path: `/api/workflow_api/${endpoint}`,
      query: { project_id: "forged-query-project", bot_id: "forged-query-bot" },
      ticket: ticketFor(),
      body,
      contentLength: null,
    });
    expect(result).toMatchObject({ status: 200, body: { code: 0, data: { execute_id: "execution-context-run" } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      workflow_id: WORKFLOW_ID,
      input: body.input,
      space_id: SPACE_ID,
      project_id: APP_ID,
    });
    expect(calls[0]?.query).toEqual({});
    expect(body.bot_id).toBe("forged-bot");
  });

  // 修复执行参数不能削弱组织隔离，其他组织的有效票据同样不能运行本组织工作流。
  test("rejects a workflow outside the ticket organization before forwarding", async () => {
    const result = await handleCanvasPassthrough({
      method: "POST",
      path: "/api/workflow_api/test_run",
      query: {},
      ticket: ticketFor("execution-context-other-org"),
      body: { workflow_id: WORKFLOW_ID, input: {} },
      contentLength: null,
    });
    expect(result.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
