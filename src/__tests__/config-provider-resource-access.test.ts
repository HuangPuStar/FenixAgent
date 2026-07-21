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

const now = new Date("2026-06-01T00:00:00.000Z");

function providerRow(overrides: Partial<ReturnType<typeof baseProviderRow>>) {
  return { ...baseProviderRow(), ...overrides };
}

function baseProviderRow() {
  return {
    id: "provider_internal",
    userId: "user_owner",
    organizationId: "org_current",
    name: "openai",
    displayName: "OpenAI",
    protocol: "openai",
    baseUrl: "https://internal.example.com",
    apiKey: "internal-key",
    extraOptions: {},
    createdAt: now,
    updatedAt: now,
  };
}

function modelRow(overrides: Partial<ReturnType<typeof baseModelRow>>) {
  return { ...baseModelRow(), ...overrides };
}

function baseModelRow() {
  return {
    id: "model_internal",
    providerId: "provider_internal",
    organizationId: "org_current",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    modalities: null,
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: now,
    updatedAt: now,
  };
}

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    groupBy: async () => rows,
    limit: async () => rows,
  });
}

function installDb(
  selectResults: unknown[][],
  options: {
    insertId?: string;
    deleteRows?: unknown[];
  } = {},
) {
  const calls = {
    delete: 0,
  };

  stubDb({
    select: () => ({
      from: () => ({
        where: () => queryResult(selectResults.shift() ?? []),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ id: options.insertId ?? "provider_created" }],
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          calls.delete += 1;
          return options.deleteRows ?? [{ id: "provider_deleted" }];
        },
      }),
    }),
  });

  return calls;
}

describe("config provider resource access", () => {
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

  // listProviders 同时返回内部和外部同名 provider，并通过 resourceKey 区分身份
  test("listProviders 返回内部和外部同名 provider", async () => {
    const internal = providerRow({ id: "provider_internal", organizationId: "org_current" });
    const external = providerRow({
      id: "provider_external",
      organizationId: "org_source",
      userId: "user_source",
      baseUrl: "https://external.example.com",
    });
    installDb([
      [internal],
      [external],
      [
        { providerId: "provider_internal", count: 1 },
        { providerId: "provider_external", count: 2 },
      ],
    ]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        {
          organizationId: "org_source",
          resourceType: "provider",
          resourceId: "provider_external",
          hasPublicRead: true,
        },
      ],
      listOwnedByOrganization: async () => [
        {
          organizationId: "org_current",
          resourceType: "provider",
          resourceId: "provider_internal",
          grantCount: 1,
          hasPublicRead: true,
        },
      ],
    });

    const { listProviders } = await import("../services/config/provider");
    const rows = await listProviders(ctx);

    expect(rows.map((row) => row.resourceKey)).toEqual([
      "org_current/provider_internal",
      "org_source/provider_external",
    ]);
    expect(rows.map((row) => row.modelCount)).toEqual([1, 2]);
    expect(rows[0].resourceAccess).toMatchObject({ ownership: "internal", writable: true, publicReadable: true });
    expect(rows[1].resourceAccess).toMatchObject({ ownership: "external", writable: false });
  });

  // getProviderByResourceKey 可读取外部授权 provider，并让 model 继承 provider 只读状态
  test("getProviderByResourceKey 返回外部 provider 和只读 models", async () => {
    const external = providerRow({
      id: "provider_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    installDb([
      [external],
      [modelRow({ id: "model_external", providerId: "provider_external", organizationId: "org_source" })],
    ]);
    stubResourcePermissionRepo({
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { getProviderByResourceKey } = await import("../services/config/provider");
    const row = await getProviderByResourceKey(ctx, "org_source/provider_external");

    expect(row?.id).toBe("provider_external");
    expect(row?.resourceAccess.resourceKey).toBe("org_source/provider_external");
    expect(row?.models[0].providerResourceAccess.writable).toBe(false);
  });

  // deleteProvider 命中外部资源时抛 403，且不会执行 DB 删除
  test("deleteProvider 拒绝删除外部 provider", async () => {
    const external = providerRow({
      id: "provider_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    const calls = installDb([[], [external], []]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        {
          organizationId: "org_source",
          resourceType: "provider",
          resourceId: "provider_external",
          hasPublicRead: true,
        },
      ],
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { deleteProvider } = await import("../services/config/provider");
    await expect(deleteProvider(ctx, "openai")).rejects.toThrow(AppError);
    expect(calls.delete).toBe(0);
  });

  // assertProviderInternalWritable 命中外部 resourceKey 时抛 403
  test("assertProviderInternalWritable 拒绝外部 provider", async () => {
    const external = providerRow({
      id: "provider_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    installDb([[external], []]);
    stubResourcePermissionRepo({
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { assertProviderInternalWritable } = await import("../services/config/provider");
    await expect(assertProviderInternalWritable(ctx, "org_source/provider_external")).rejects.toThrow(AppError);
  });

  // upsertProvider publicReadable 通过权限 service 写入公开授权
  test("upsertProvider publicReadable 调用 setPublicRead", async () => {
    let capturedGrant: unknown;
    installDb([], { insertId: "provider_created" });
    stubResourcePermissionRepo({
      createGrant: async (input) => {
        capturedGrant = input;
        return {
          id: "grant_1",
          ...input,
          createdAt: now,
          updatedAt: now,
        };
      },
    });

    const { upsertProvider } = await import("../services/config/provider");
    const result = await upsertProvider(ctx, "openai", { protocol: "openai" }, { publicReadable: true });

    expect(result.id).toBe("provider_created");
    expect(capturedGrant).toEqual({
      organizationId: "org_current",
      resourceType: "provider",
      resourceId: "provider_created",
      principalType: "all",
      principalId: null,
      action: "read",
      createdBy: "user_owner",
    });
  });
});
