/**
 * 公共 Git 模块的组合根（`fenix.module.ts` 的 `create` 目标）。
 *
 * 装配只有一件事：把宿主投影的 {@link GitModuleConfig} 变成 `GitService`——连接映射（每连接一个管理适配器）
 * 加上绑定服务。这一层不读日志之外的任何外部状态，也不在构造时产生**任何出站请求**：适配器构造只建信号量，
 * 首次调用才连 Forgejo。这保证了默认装配（未启用 git）与「启用了 git 但从未调用」的进程都不会碰到远端。
 *
 * 单例是**惰性且幂等**的：进程内第一次调用构造，之后返回同一实例。生命周期由宿主掌握：`createGitModule`
 * 在装配期把释放动作登记进 `context.registerCleanup`，宿主关闭序与启动失败清理因此都经
 * `assembly.dispose()` 触发 {@link disposeGitModule}——模块的释放语义由模块自己声明，宿主持有的只有
 * 装配句柄。T01 的模块没有定时器与长连接，清空单例就是全部释放动作；T04 的后台消费循环接入时同样挂在这里。
 */

import { createLogger } from "@fenix/logger";
import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { getModuleConfig } from "@fenix/platform-sdk/server";
import type { GitService } from "./contracts/client";
import { ForgejoClient } from "./forgejo/client";
import { createBindingsService, type GitConnectionDeps } from "./server/bindings-service";
import type { GitModuleConfig } from "./server/config";

const logger = createLogger("git");

let moduleInstance: GitService | undefined;
let modulePending: Promise<GitService> | undefined;

/**
 * 创建（或取回）公共 Git 模块实例。
 *
 * 失败时**不缓存**失败的 promise：配置修好后允许重试，否则一次拼错路径就会让整个进程在内存里永久记住这个
 * 错误。初始化进行中的并发调用共享同一个 promise，不会构造出第二套连接映射。
 *
 * @throws Error 配置缺失或没有任何连接（消息指向 `AOS_GIT_CONFIG_FILE`）
 */
export function createGitModule(context?: ModuleFactoryContext): Promise<GitService> {
  if (moduleInstance !== undefined) return Promise.resolve(moduleInstance);
  if (modulePending !== undefined) return modulePending;

  // 释放动作在构造**之前**登记：即使构造失败，宿主在启动失败清理里调用 dispose 也只是清空一个未初始化的
  // 单例（幂等）；反过来（构造成功但登记失败）会留下一个永远不被释放的实例。
  context?.registerCleanup(() => {
    disposeGitModule();
  });

  const pending: Promise<GitService> = buildGitModule().then(
    (service) => {
      // 只有仍是当前这次初始化时才认领实例：`disposeGitModule()` 期间的并发构造不得把单例写回来。
      if (modulePending === pending) {
        moduleInstance = service;
        modulePending = undefined;
      }
      return service;
    },
    (error: unknown) => {
      if (modulePending === pending) modulePending = undefined;
      throw error;
    },
  );
  modulePending = pending;
  return pending;
}

/**
 * 读取已装配的模块实例。
 *
 * 同步接口：宿主与消费者都在装配完成后按引用取用，不存在等待的语义。尚未初始化与初始化中分开报错，前者是
 * 装配顺序写错，后者是提前调用——两者的排查方向不同。
 */
export function getGitService(): GitService {
  if (moduleInstance !== undefined) return moduleInstance;
  if (modulePending !== undefined) {
    throw new Error("公共 Git 模块正在初始化中：createGitModule() 尚未完成");
  }
  throw new Error("公共 Git 模块尚未初始化：请先 await createGitModule()");
}

/**
 * 清空单例（宿主关闭序调用），可重复调用。
 *
 * 在途的初始化不会回填（见 {@link createGitModule} 的认领条件），因此关闭过程中发起的构造不会让已释放的
 * 模块复活。清空后再次调用 `createGitModule()` 会重新构造——这是刻意的：配置已变时宿主需要重建能力。
 */
export function disposeGitModule(): void {
  moduleInstance = undefined;
  modulePending = undefined;
}

/** 测试复位：动作与 {@link disposeGitModule} 相同，分开命名是为了让调用点读起来就是「这是测试夹具」。 */
export function resetGitModuleForTesting(): void {
  disposeGitModule();
}

/**
 * 构造模块实例。
 *
 * `getModuleConfig` 读的是宿主投影后的只读配置：`provisionToken` 已是**值**（`{env:NAME}` 引用在投影期
 * 解析），`secretValues` 是 Git manifest 已声明的密钥值表，用于运行期解析绑定的 `credentialRef`。
 */
async function buildGitModule(): Promise<GitService> {
  const config = requireModuleConfig();
  const secrets = config.secretValues ?? {};

  const connections = new Map<string, GitConnectionDeps>();
  for (const connection of config.connections) {
    connections.set(connection.id, {
      config: connection,
      adminClient: new ForgejoClient({
        baseUrl: connection.baseUrl,
        token: connection.provisionToken,
        requestTimeoutMs: connection.requestTimeoutMs,
        maxConcurrentRequests: connection.maxConcurrentRequests,
      }),
    });
  }

  const bindings = createBindingsService({ connections, secrets });
  // 只记连接 id：连接拓扑是排障时最需要确认的信息，且它不含凭据。
  logger.info("git.module.ready", { connectionIds: [...connections.keys()] });

  return {
    connectionIds: [...connections.keys()],
    createScopedClient: (input) => bindings.createScopedClient(input),
    admin: bindings,
  };
}

/**
 * 取模块配置并做「启用即必须有连接」的判定。
 *
 * 空连接不等于「没有 Git 能力」而等于装配失败：配置文件路径未配置时宿主会投影空连接（默认装配也如此），
 * 而 `create` 只在 git 进入装配 profile 时被调用——走到这里说明本进程启用了 git，却没有可用的连接，
 * 继续启动只会得到一个连接 id 列表为空的假模块。
 *
 * 底层异常（基础设施未初始化、模块未声明配置）一律转成同一条可操作的消息：运维要做的就是配置
 * `AOS_GIT_CONFIG_FILE`，原始原因挂在 cause 上供排障。
 */
function requireModuleConfig(): GitModuleConfig {
  let config: GitModuleConfig | undefined;
  try {
    config = getModuleConfig<GitModuleConfig | undefined>("git");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`公共 Git 模块启用失败：启用 git 必须配置 AOS_GIT_CONFIG_FILE（配置读取失败：${reason}）`, {
      cause: error,
    });
  }

  if (config === undefined || !Array.isArray(config.connections) || config.connections.length === 0) {
    throw new Error("公共 Git 模块启用失败：启用 git 必须配置 AOS_GIT_CONFIG_FILE（当前没有任何连接）");
  }
  return config;
}
