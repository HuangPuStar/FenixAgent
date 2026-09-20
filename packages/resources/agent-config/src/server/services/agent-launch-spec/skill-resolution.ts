import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "@fenix/logger";
import type { SkillRow } from "@fenix/resource-skill/server";
import {
  buildSkillArchive,
  buildSkillDownloadUrl,
  getGlobalSkillsDir,
  getSkillArchivePath,
  getSkillSourceDir,
} from "@fenix/resource-skill/server/content";
import type { ScopedAgentConfigRow } from "../../repositories/agent-config-resource";
import { LAUNCH_SPEC_LOG_PREFIX, summarizeSkills, throwInvalidConfig } from "./support";
import type { AgentLaunchSpecAssemblerDeps } from "./types";

/**
 * Skill 解析：绑定集合 → 行（按绑定顺序）→ 可下载的归档地址。
 *
 * 归档的构建与新鲜度判定仍在 `resource-skill` 包里（`./server/content`）：Skill 是"元数据 + 源目录 +
 * 归档"的组合存储，归档怎么切、怎么判过期由那个包定义，本模块只负责"启动前确保它可用"。
 */

/** 递归收集目录下所有文件的最晚修改时间。 */
function getLatestMtime(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, getLatestMtime(fullPath));
    } else if (entry.isFile()) {
      latest = Math.max(latest, statSync(fullPath).mtimeMs);
    }
  }
  return latest;
}

/** 判断 skill 源文件是否有更新，需要重建 archive。 */
function isSkillStale(sourceDir: string, archivePath: string): boolean {
  if (!existsSync(archivePath) || !existsSync(sourceDir)) return !existsSync(archivePath);
  const archiveMtime = statSync(archivePath).mtimeMs;
  return getLatestMtime(sourceDir) > archiveMtime;
}

function resolveSkillArchivePath(skillRoot: string, row: SkillRow) {
  return {
    archivePath: getSkillArchivePath(skillRoot, row.organizationId, row.name),
    sourceDir: getSkillSourceDir(skillRoot, row.organizationId, row.name),
  };
}

/**
 * 读取 Agent 绑定的 skill 行，并保持与绑定顺序一致。
 *
 * 这里对"绑定存在但 skill 行缺失"直接失败，因为这种状态通常意味着配置被破坏，继续启动只会把错误
 * 延后到运行时（表现为工具集残缺而不是启动失败）。
 *
 * 一次取回全部命中行（`listRowsByIdsUnscoped`）而不是逐行 N+1：绑定数量随 Agent 增长，逐行读会把
 * 启动延迟放大成 O(n) 次往返。
 */
export async function loadAgentSkills(
  deps: AgentLaunchSpecAssemblerDeps,
  agentConfig: ScopedAgentConfigRow,
): Promise<readonly SkillRow[]> {
  const skillIds = await deps.associations.listSkillIds(agentConfig.id);
  if (skillIds.length === 0) return [];

  const skillRows = await deps.skills.listRowsByIdsUnscoped(skillIds);
  const skillById = new Map(skillRows.map((row) => [row.id, row]));
  const missingSkillIds = skillIds.filter((skillId) => !skillById.has(skillId));
  if (missingSkillIds.length > 0) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing skills`,
      `${LAUNCH_SPEC_LOG_PREFIX} missing skill rows for agentConfig='${agentConfig.id}', missingSkillIds=${JSON.stringify(missingSkillIds)}, available=${JSON.stringify(
        summarizeSkills(skillRows),
      )}`,
    );
  }

  // `skillIds` 来自绑定表且已确认全部命中，`get` 的结果必然存在；用非空断言表达这一点而不是再判一次。
  return skillIds.map((skillId) => skillById.get(skillId) as SkillRow);
}

/**
 * 确保每个 skill 都具备可下载的归档包。
 *
 * 归档缺失或过期时会尝试重建；若源目录本身就不存在，则直接视为配置损坏——不重建、不跳过，因为
 * "少了一个 skill"在运行期只表现为工具缺失，比启动失败难排查得多。
 */
export async function buildSkillSpecs(
  agentConfig: ScopedAgentConfigRow,
  skills: readonly SkillRow[],
): Promise<{ name: string; url: string }[]> {
  const skillRoot = getGlobalSkillsDir();
  const resolvedSkills: { name: string; url: string }[] = [];
  for (const row of skills) {
    const { archivePath, sourceDir } = resolveSkillArchivePath(skillRoot, row);
    log(
      `${LAUNCH_SPEC_LOG_PREFIX} buildAgentLaunchSpec: translating skill '${row.name}' sourceDir='${sourceDir}' archivePath='${archivePath}' skillOrg='${row.organizationId}'`,
    );

    if (!existsSync(sourceDir)) {
      throwInvalidConfig(
        `AgentConfig '${agentConfig.id}' references missing skill source '${row.name}'`,
        `${LAUNCH_SPEC_LOG_PREFIX} missing skill source directory for agentConfig='${agentConfig.id}', skill='${row.name}', sourceDir='${sourceDir}'`,
      );
    }

    if (isSkillStale(sourceDir, archivePath)) {
      log(`${LAUNCH_SPEC_LOG_PREFIX} Skill archive stale, rebuilding: ${row.name}`);
      try {
        await buildSkillArchive(sourceDir, archivePath);
      } catch (error) {
        throwInvalidConfig(
          `AgentConfig '${agentConfig.id}' failed to build skill archive '${row.name}'`,
          `${LAUNCH_SPEC_LOG_PREFIX} failed to rebuild skill archive for agentConfig='${agentConfig.id}', skill='${row.name}', archivePath='${archivePath}'`,
          error,
        );
      }
    }

    if (!existsSync(archivePath)) {
      throwInvalidConfig(
        `AgentConfig '${agentConfig.id}' references missing skill archive '${row.name}'`,
        `${LAUNCH_SPEC_LOG_PREFIX} missing skill archive after rebuild for agentConfig='${agentConfig.id}', skill='${row.name}', archivePath='${archivePath}'`,
      );
    }

    // 下载令牌有效期 1 小时：与实例启动到 agent 拉取归档的时间窗匹配（迁移前既有取值）。
    resolvedSkills.push({
      name: row.name,
      url: buildSkillDownloadUrl(
        { id: row.id, organizationId: row.organizationId, name: row.name },
        { expiresInSeconds: 3600 },
      ),
    });
  }
  return resolvedSkills;
}
