/** 模块拥有的数据迁移；根 runner 只汇总、记录和执行它。 */
export const backfillAgentConfigResourceBase = {
  id: "agent-config/20260906-backfill-resource-base",
  dependsOn: ["ddl/0001-create-resources-and-agent-config-properties"],
  async run(): Promise<void> {
    // 生产实现：用旧 agent_configs.id 建 resources 与 properties，保持 ID 不变并按批次回填。
  },
  async verify(): Promise<void> {
    // 生产实现：校验旧表与新 resources/properties 的 ID 集合、数量和归属范围一致。
  },
};
