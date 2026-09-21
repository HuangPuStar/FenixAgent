import { setMetaAgentModelResolver } from "@fenix/agent-config/server";
import { getModelManagementModule } from "@fenix/model-management/server";
import { toActorContext } from "../plugins/auth";

/**
 * Meta Agent 的默认模型解析策略（宿主注入 agent-config 的回调端口）。
 *
 * 与 `host-wiring.ts` 的其它绑定分开成文，是因为性质不同：那些是把**进程级运行态句柄**交给包，本文件交给
 * 包的是**一条资源可见性策略**——它把「宿主协议层的请求上下文」翻译成资源包的 actor，再走资源包自己的
 * Facade 取数。放在这里而不是包内，是因为翻译需要宿主的 `toActorContext`，而资源包不得反向依赖宿主。
 */
export function registerMetaAgentModelResolver(): void {
  /**
   * 取当前主体可见的第一个 Provider 的第一个模型。
   *
   * 返回的是 `model` 表的行 ID——`agent_config.model_id` 是它的外键（运行时只认这个外键，不接受
   * `provider/modelId` 形式的引用），因此这里不能返回模型业务键。
   *
   * 读取一律经 Facade：授权与可见性由资源包的授权谓词决定，宿主不再自己拼资源键。
   */
  setMetaAgentModelResolver(async (ctx) => {
    const actor = toActorContext(ctx);
    const { facade } = getModelManagementModule();
    const { items } = await facade.list(actor);
    for (const item of items) {
      const detail = await facade.getById(actor, item.id);
      const firstModel = detail?.models[0];
      if (firstModel) return firstModel.id;
    }
    return null;
  });
}
