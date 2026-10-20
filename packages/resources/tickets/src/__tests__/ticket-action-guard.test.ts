import { describe, expect, test } from "bun:test";
import {
  type AccessControlModule,
  type ActorContext,
  ForbiddenError,
  ResourceAccessDeniedError,
  type ResourceDefinition,
} from "@fenix/platform-sdk";
import { TICKET_PROJECT_RESOURCE_TYPE } from "../server/access/ticket-project-resource";
import { isProjectAdmin, requireProjectAction } from "../server/facades/ticket-action-guard";

/**
 * 授权拒绝的收窄边界（backend contract §2.3）：平台拒绝 → 403，**其余错误原样上抛**。
 *
 * 这一层的风险不在「拒绝时报不报 403」，而在把别的东西也报成 403：存储故障、装配错误一旦被收窄成 403，
 * 排障会沿着权限方向查到底，而真正的故障（数据库不可达、绑定失效）没有任何痕迹。因此本文件的正例与反例
 * 各占一半——`isProjectAdmin` 的「拒绝 → false」同样不得吞掉非授权错误，否则管理员会在故障期间静默失去权限。
 *
 * 接缝说明：只注入 `AccessControlModule` 替身并记录 `authorize` 的入参；`ResourceDefinition` 用真实的
 * 项目资源定义（判定是否「用项目 ID 去问授权」是 Facade 的责任，这里只钉住入参透传）。
 */

describe("授权拒绝的收窄（§2.3）", () => {
  const ACTOR: ActorContext = {
    kind: "user",
    userId: "user_creator",
    activeOrganizationId: "org_alpha",
    memberships: [{ organizationId: "org_alpha", role: "member" }],
  };

  const RESOURCE: ResourceDefinition = {
    type: TICKET_PROJECT_RESOURCE_TYPE,
    ownershipMode: "organization",
    actions: ["read", "create", "update"],
    memberDefaultActions: ["read"],
    publicDefaultActions: [],
  };

  interface AuthorizeCall {
    readonly actor: ActorContext;
    readonly action: string;
    readonly resource: ResourceDefinition;
    readonly resourceId: string;
  }

  /**
   * 授权替身：只实现 `authorize`，其余方法一律视为行为回归（Facade 的这三个判定不该触碰它们）。
   *
   * `authorize` 按用例给出的行为抛错或放行，并把入参记下来供透传断言。
   */
  function createAccessControlStub(behaviour: (input: AuthorizeCall) => Promise<void>): {
    readonly module: AccessControlModule;
    readonly calls: AuthorizeCall[];
  } {
    const calls: AuthorizeCall[] = [];
    const unused = async (): Promise<never> => {
      throw new Error("权限判定不应触碰 AccessControlModule 的其它方法");
    };
    return {
      calls,
      module: {
        id: "test-access-control",
        resolveInitialScope: unused,
        initializeResourceAccess: unused,
        authorize: async (input) => {
          calls.push(input);
          await behaviour(input);
        },
        createListConstraint: unused,
        resolveAccess: unused,
        resolveAccessMany: unused,
      },
    };
  }

  // 平台拒绝 → 403：这是评论/标签 Facade 与工单 Facade 共用的唯一收窄出口，文案由调用点给出。
  test("授权拒绝收窄为 403 并沿用调用点文案", async () => {
    const { module } = createAccessControlStub(async () => {
      throw new ResourceAccessDeniedError("当前主体无权执行资源动作");
    });

    const failure = await requireProjectAction({
      accessControl: module,
      resource: RESOURCE,
      actor: ACTOR,
      action: "update",
      projectId: "project-1",
      message: "无权管理该项目标签",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ForbiddenError);
    expect(failure).toMatchObject({ statusCode: 403, code: "FORBIDDEN", message: "无权管理该项目标签" });
  });

  // 判定必须落在「被操作的那个项目」上：传错资源 ID 会让成员拿到他人的项目权限（越权判定）。
  test("授权入参透传：主体、动作、资源定义与项目 ID 原样送达", async () => {
    const { module, calls } = createAccessControlStub(async () => undefined);

    await requireProjectAction({
      accessControl: module,
      resource: RESOURCE,
      actor: ACTOR,
      action: "update",
      projectId: "project-42",
      message: "无权",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actor: ACTOR,
      action: "update",
      resource: RESOURCE,
      resourceId: "project-42",
    });
  });

  // 存储故障不得伪装成权限问题：非授权拒绝的错误原样上抛（对象同一，交由宿主错误处理器判定）。
  test("非授权错误原样上抛且不被收窄成 403", async () => {
    const databaseFailure = new Error("数据库连接不可用");
    const { module } = createAccessControlStub(async () => {
      throw databaseFailure;
    });

    const failure = await requireProjectAction({
      accessControl: module,
      resource: RESOURCE,
      actor: ACTOR,
      action: "update",
      projectId: "project-42",
      message: "无权",
    }).catch((error: unknown) => error);

    expect(failure).toBe(databaseFailure);
    expect(failure).not.toBeInstanceOf(ForbiddenError);
  });

  // 放行即静默返回：布尔形态的调用点据此把「管理员」当作可执行任何动作的依据。
  test("授权放行时不抛错", async () => {
    const { module } = createAccessControlStub(async () => undefined);

    await expect(
      requireProjectAction({
        accessControl: module,
        resource: RESOURCE,
        actor: ACTOR,
        action: "update",
        projectId: "project-42",
        message: "无权",
      }),
    ).resolves.toBeUndefined();
  });

  // 管理员判定只是同一次授权的布尔出口：命中即 true，且不额外询问第二次（两次询问会给出两种答案的窗口）。
  test("管理员判定：放行为 true 且只问一次授权", async () => {
    const { module, calls } = createAccessControlStub(async () => undefined);

    const isAdmin = await isProjectAdmin({
      accessControl: module,
      resource: RESOURCE,
      actor: ACTOR,
      action: "update",
      projectId: "project-42",
    });

    expect(isAdmin).toBe(true);
    expect(calls).toHaveLength(1);
  });

  // 拒绝是「不是管理员」而不是错误：判定必须返回 false，让业务回落到按对象归属放行的分支（而非 500）。
  test("管理员判定：授权拒绝为 false", async () => {
    const { module } = createAccessControlStub(async () => {
      throw new ResourceAccessDeniedError();
    });

    const isAdmin = await isProjectAdmin({
      accessControl: module,
      resource: RESOURCE,
      actor: ACTOR,
      action: "update",
      projectId: "project-42",
    });

    expect(isAdmin).toBe(false);
  });

  // 故障期间不得把管理员判成非管理员：非授权错误必须上抛，否则管理员会静默失去全部管理动作。
  test("管理员判定：非授权错误上抛而不是吞成 false", async () => {
    const databaseFailure = new Error("数据库连接不可用");
    const { module } = createAccessControlStub(async () => {
      throw databaseFailure;
    });

    const failure = await isProjectAdmin({
      accessControl: module,
      resource: RESOURCE,
      actor: ACTOR,
      action: "update",
      projectId: "project-42",
    }).catch((error: unknown) => error);

    expect(failure).toBe(databaseFailure);
  });
});
