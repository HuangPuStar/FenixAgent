import { backfillAgentConfigResourceBase } from "@fenix-ce/agent-config/data-migrations";

/** 根 runner 仅汇总模块 manifest；数据迁移逻辑不放在 scripts。 */
export const ceDataMigrations = [backfillAgentConfigResourceBase];
