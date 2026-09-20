import { getModelGatewayServices, type ModelGatewayServices } from "./server/model-gateway";
import type { ModelManagementServerModule } from "./server/module";
import { getModelManagementModule } from "./server/module-runtime";

/**
 * Model-management 模块的运行时表面。
 *
 * 只暴露需要"对象身份"的两块进程级单例，不新建第二套：资源模块表面（facade / service / repositories）
 * 与模型网关服务集（provider / budget / subject / usage / keyManagement）。`setModelGatewayServices`
 * 是全进程单例，再构造一份等于让同一批凭据、预算和用量各有两条读取路径。
 *
 * 两个属性都是**读时才取**的取值器，不是构造期快照：
 *
 * - 本包的服务端表面必须由宿主注入平台能力（`AccessControlModule` / `ResourceScopeStore` /
 *   `AuthorizedResourceQuery` / `IdentityDirectory`）后才存在，而模块工厂在装配序列里被调用时这些
 *   注入未必已经发生（`src/server/module.ts` 已记录这一「构造依赖尚未由注册表表达」的已知不足）；
 * - 取值器把"未装配"的失败推迟到真正读取的调用点，并复用 `getModelManagementModule` /
 *   `getModelGatewayServices` 的既有报错，而不是把 undefined 变成一路静默的"资源不存在"。
 *
 * 因此本函数是**无副作用**的：不读 DB、不写单例、不注册清理，装配序列可以在任何时点调用它。
 */
export interface ModelManagementModule {
  readonly id: "model-management";
  /** 已装配的资源模块表面；未装配时读取即报错。 */
  readonly server: ModelManagementServerModule;
  /** 模型网关运行时服务集；网关未启用（未配置管理凭证）时读取即报错。 */
  readonly gateway: ModelGatewayServices;
}

/** 创建 Model-management 模块实例（惰性取值器，见接口注释）。 */
export function createModelManagementModule(): ModelManagementModule {
  return {
    id: "model-management",
    get server() {
      return getModelManagementModule();
    },
    get gateway() {
      return getModelGatewayServices();
    },
  };
}
