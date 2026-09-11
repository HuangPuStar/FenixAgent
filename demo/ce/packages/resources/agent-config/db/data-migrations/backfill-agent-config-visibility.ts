/** 模块拥有的数据迁移；根 runner 只汇总、记录和执行它。 */
export const backfillAgentConfigVisibility = {
  id: "agent-config/20260906-backfill-visibility",
  dependsOn: ["ddl/0001-create-agent-configs"],
  async run(): Promise<void> {
    // 生产实现：按批次为既有 agent_configs 回填 visibility，并保留已有 organization_id、user_id。
  },
  async verify(): Promise<void> {
    // 生产实现：校验回填后的 visibility 分布、ID 集合与既有归属范围一致。
  },
};
