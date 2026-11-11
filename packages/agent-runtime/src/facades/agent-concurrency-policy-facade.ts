import { AppError, type IdentityDirectory } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import type { AgentConcurrencyPolicyService, ConcurrencyOverrides } from "../server/services/agent-concurrency-policy";
import { agentConcurrencyPolicyService } from "../server/services/agent-concurrency-policy-state";

/** 系统密钥认证后的管理编排；不构造用户 actor，也不改变组织内资源授权。 */
export class AgentConcurrencyPolicyFacade {
  constructor(
    private readonly service: AgentConcurrencyPolicyService,
    private readonly directory: () => Pick<IdentityDirectory, "getUser" | "listUserDisplayInfo"> = getIdentityDirectory,
  ) {}

  /** 平台三项设置。 */
  getGlobal() {
    return this.service.describe();
  }

  /** 提交平台覆盖后返回新的实际值及来源。 */
  async patchGlobal(patch: Partial<ConcurrencyOverrides>) {
    await this.service.patchGlobal(patch);
    return this.getGlobal();
  }

  /** 仅列出显式用户覆盖，用户展示数据只经身份公开端口读取。 */
  async listUsers() {
    const rows = this.service.listUsers();
    const users = await this.directory().listUserDisplayInfo(rows.map((row) => row.userId));
    return rows
      .filter((row) => users.has(row.userId))
      .map((row) => ({ ...row, name: users.get(row.userId)?.name ?? row.userId }));
  }

  /** 返回存在用户的覆盖与继承信息。 */
  async getUser(userId: string) {
    const user = await this.requireUser(userId);
    return { userId, name: user.name, policy: this.service.describe(userId) };
  }

  /** 指定用户覆盖；null 恢复继承。 */
  async putUser(userId: string, value: number | null) {
    await this.requireUser(userId);
    await this.service.putUser(userId, value);
    return this.getUser(userId);
  }

  /** 删除覆盖后仍返回用户的实际继承值。 */
  async deleteUser(userId: string) {
    await this.requireUser(userId);
    await this.service.deleteUser(userId);
    return this.getUser(userId);
  }

  private async requireUser(userId: string) {
    const user = await this.directory().getUser(userId);
    if (!user) throw new AppError("User not found", "NOT_FOUND", 404);
    return user;
  }
}

/** Runtime owner 的唯一并发管理门面。 */
export const agentConcurrencyPolicyFacade = new AgentConcurrencyPolicyFacade(agentConcurrencyPolicyService);
