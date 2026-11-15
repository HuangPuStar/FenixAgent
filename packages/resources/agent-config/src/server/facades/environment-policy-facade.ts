import { type ActorContext, ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import {
  deleteAgentEnvironmentTtl,
  getAgentEnvironmentTtl,
  putAgentEnvironmentTtl,
} from "../repositories/environment-policy";
import { getAgentConfigModule } from "../runtime";
import {
  effectiveEnvironmentTtl,
  getEnvironmentPolicyMaximum,
  validateEnvironmentTtl,
} from "../services/environment-policy";

/** AgentConfig 策略应用入口；使用配置的现行授权结论。 */
export class EnvironmentPolicyFacade {
  private async authorize(actor: ActorContext, id: string, write = false): Promise<void> {
    const resource = await getAgentConfigModule().facade.getById(actor, id);
    if (!resource) throw new NotFoundError("Agent not found");
    if (write && !resource.access.actions.includes("update"))
      throw new ForbiddenError("Agent update permission required");
  }
  /** 可见主体读取配置及当前有效 TTL。 */
  async get(actor: ActorContext, id: string) {
    await this.authorize(actor, id);
    const ttlSeconds = await getAgentEnvironmentTtl(id);
    const maxTtlSeconds = getEnvironmentPolicyMaximum();
    return {
      ttlSeconds,
      source: ttlSeconds === null ? ("default" as const) : ("agent" as const),
      effectiveTtlSeconds: effectiveEnvironmentTtl(ttlSeconds, maxTtlSeconds),
      maxTtlSeconds,
    };
  }
  /** 只有当前 update 权限可修改策略。 */
  async put(actor: ActorContext, id: string, ttlSeconds: number) {
    await this.authorize(actor, id, true);
    await putAgentEnvironmentTtl(id, validateEnvironmentTtl(ttlSeconds, getEnvironmentPolicyMaximum()));
    return this.get(actor, id);
  }
  /** 删除策略恢复默认值。 */
  async remove(actor: ActorContext, id: string): Promise<null> {
    await this.authorize(actor, id, true);
    await deleteAgentEnvironmentTtl(id);
    return null;
  }
}
