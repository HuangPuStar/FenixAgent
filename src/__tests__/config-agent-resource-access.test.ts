import { beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import { setOrganizationRepoForTesting } from "../services/resource-permission";
import { resetAllStubs, stubDb, stubResourcePermissionRepo } from "../test-utils/helpers";

const ctx: AuthContext = {
  organizationId: "org_current",
  userId: "user_owner",
  role: "owner",
};

const now = new Date("2026-06-04T00:00:00.000Z");

function baseAgentRow() {
  return {
    id: "agc_internal",
    userId: "user_owner",
    organizationId: "org_current",
    name: "shared-agent",
    prompt: "prompt",
    model: "openai/gpt-4o",
    steps: 20,
    mode: "primary",
    permission: null,
    variant: null,
    temperature: null,
    topP: null,
    disable: false,
    hidden: false,
    color: null,
    description: "desc",
    knowledge: null,
    machineId: "machine-internal",
    createdAt: now,
    updatedAt: now,
  };
}

function agentRow(overrides: Partial<ReturnType<typeof baseAgentRow>>) {
  return { ...baseAgentRow(), ...overrides };
}

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

function installDb(selectResults: unknown[][], options: { insertId?: string; updateRows?: unknown[] } = {}) {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => queryResult(selectResults.shift() ?? []),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ id: options.insertId ?? "agc_created" }],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => options.updateRows ?? [{ id: "agc_updated" }],
        }),
      }),
    }),
  });
}

describe("config agent resource access", () => {
  beforeEach(() => {
    resetAllStubs();
    setOrganizationRepoForTesting({
      listNamesByIds: async () =>
        new Map([
          ["org_current", "Current Team"],
          ["org_source", "Source Team"],
        ]),
    });
  });

  // listAgentConfigs 同时返回内部与外部公开 Agent，并附带 resourceAccess
  test("listAgentConfigs 返回内部和外部共享 Agent", async () => {
    const internal = agentRow({});
    const external = agentRow({
      id: "agc_external",
      organizationId: "org_source",
      userId: "user_source",
      machineId: "machine-external",
    });
    installDb([[internal], [external]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        {
          organizationId: "org_source",
          resourceType: "agent_config",
          resourceId: "agc_external",
          hasPublicRead: true,
        },
      ],
      listOwnedByOrganization: async () => [
        {
          organizationId: "org_current",
          resourceType: "agent_config",
          resourceId: "agc_internal",
          grantCount: 1,
          hasPublicRead: true,
        },
      ],
    });

    const { listAgentConfigs } = await import("../services/config/agent-config");
    const rows = await listAgentConfigs(ctx);

    expect(rows.map((row) => row.resourceAccess.resourceKey)).toEqual([
      "org_current/agc_internal",
      "org_source/agc_external",
    ]);
    expect(rows[0].resourceAccess).toMatchObject({ ownership: "internal", publicReadable: true, writable: true });
    expect(rows[1].resourceAccess).toMatchObject({ ownership: "external", writable: false });
  });

  // getAgentConfigByResourceKey 仅在外部 Agent 被授权时返回详情
  test("getAgentConfigByResourceKey 按授权返回外部 Agent", async () => {
    const external = agentRow({
      id: "agc_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    installDb([[external]]);
    stubResourcePermissionRepo({
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { getAgentConfigByResourceKey } = await import("../services/config/agent-config");
    const row = await getAgentConfigByResourceKey(ctx, "org_source/agc_external");

    expect(row?.id).toBe("agc_external");
    expect(row?.resourceAccess.resourceKey).toBe("org_source/agc_external");
    expect(row?.resourceAccess.writable).toBe(false);
  });

  // 不可写的外部 Agent 命中 assertAgentConfigInternalWritable 时抛出 403
  test("assertAgentConfigInternalWritable 拒绝外部 Agent", async () => {
    const external = agentRow({
      id: "agc_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    installDb([[external]]);
    stubResourcePermissionRepo({
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { assertAgentConfigInternalWritable } = await import("../services/config/agent-config");
    await expect(assertAgentConfigInternalWritable(ctx, "org_source/agc_external")).rejects.toThrow(AppError);
  });

  // create/update 通过 setPublicRead 透传 publicReadable 到资源权限 service
  test("createAgentConfig 和 updateAgentConfig 透传 publicReadable", async () => {
    const internal = agentRow({});
    let createdGrant: unknown;
    let deletedGrant: unknown;
    installDb([[internal]], { insertId: "agc_created", updateRows: [{ id: "agc_internal" }] });
    stubResourcePermissionRepo({
      createGrant: async (input) => {
        createdGrant = input;
        return { id: "grant-created", ...input, createdAt: now, updatedAt: now };
      },
      deleteGrant: async (input) => {
        deletedGrant = input;
        return true;
      },
      listOwnedByOrganization: async () => [],
    });

    const { createAgentConfig, updateAgentConfig } = await import("../services/config/agent-config");
    const createdId = await createAgentConfig(ctx, "shared-agent", { prompt: "p" }, { publicReadable: true });
    const updated = await updateAgentConfig(ctx, "shared-agent", { prompt: "next" }, { publicReadable: false });

    expect(createdId).toBe("agc_created");
    expect(updated).toBe(true);
    expect(createdGrant).toEqual({
      organizationId: "org_current",
      resourceType: "agent_config",
      resourceId: "agc_created",
      principalType: "all",
      principalId: null,
      action: "read",
      createdBy: "user_owner",
    });
    expect(deletedGrant).toEqual({
      organizationId: "org_current",
      resourceType: "agent_config",
      resourceId: "agc_internal",
      principalType: "all",
      principalId: null,
      action: "read",
    });
  });
});
