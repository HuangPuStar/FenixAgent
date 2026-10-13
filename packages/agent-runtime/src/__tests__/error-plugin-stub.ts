import { OrchestrationError } from "@fenix/orchestration";
import { AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { mapOrchestrationErrorToHttp } from "../errors/orchestration-http";

/**
 * 宿主错误映射插件（`apps/server/src/plugins/error-handler.ts`）的替身。
 *
 * **为什么需要替身**：包内用例要验证「路由把错误原样抛出、由宿主的全局 `onError` 映射成稳定状态码」——
 * 本地 `handle` 没有 `onError`，错误会落成 Elysia 默认的 500 纯文本，因此断言必须挂一个错误插件。
 * 生产挂的是宿主插件，而包内用例不得 import `@server/plugins/error-handler`（§1.7 收尾要清零的
 * `apps-boundary` 残留面之一），故按宿主插件的**契约**复刻一层。
 *
 * **为什么只复刻三个分支**：宿主插件共六条分支（AppError / OrchestrationError / CoreRuntime NODE_OFFLINE /
 * Sandbox 服务不可用 / Elysia ValidationError / PG uuid 兜底），本包用例只断言前两条与 500 兜底；
 * 其余分支的输入（Sandbox Provider、宿主 logger、Elysia schema 校验）在包内不具备，复刻它们等于凭空
 * 造一套宿主实现。宿主插件本身的覆盖在 `apps/server/src/__tests__/`，不在本包的验收范围。
 *
 * **复刻内容与真实性**：`AppError` 分支读的是错误对象自带的 `statusCode` / `code`（分类法在
 * `@fenix/platform-sdk`，两侧共用同一组类）；`OrchestrationError` 分支调本包 `mapOrchestrationErrorToHttp`
 * ——这正是宿主插件用的同一真相来源（宿主从 `@fenix/agent-runtime/server` 取它）。500 兜底的固定文案
 * 「Internal server error」同样是宿主的脱敏口径，用例据此断言原始 message 不外泄。
 *
 * 插件名刻意与宿主不同（`test-error-handler`）：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */
export const errorPluginStub = new Elysia({ name: "test-error-handler" }).onError(
  { as: "global" },
  ({ error, set }) => {
    if (error instanceof AppError) {
      set.status = error.statusCode;
      return { error: { type: error.code, message: error.message } };
    }
    if (error instanceof OrchestrationError) {
      const { status, message } = mapOrchestrationErrorToHttp(error);
      set.status = status;
      return { error: { type: error.code, message } };
    }
    set.status = 500;
    return { error: { type: "INTERNAL_ERROR", message: "Internal server error" } };
  },
);
