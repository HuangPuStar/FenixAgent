import type { ResourceVisibility } from "@fenix/platform-sdk";
import type { SkillRow } from "../repositories/skill";
import { toSkillMetadata } from "../repositories/skill";
import { deleteSkillDocument, normalizeSkillWriteData, validateSkillName, writeSkillDocument } from "./skill-content";
import type { SkillService } from "./skill-service";

/**
 * Skill 的系统托管路径。
 *
 * builtin skill 的同步、孤儿清理与"全组织共享"的公开受众设置都不属于任何用户请求：它们由启动流程
 * 在系统托管租户上执行，没有可授权的 actor。把它们写成"构造一个 super-admin actor"会掩盖真实的
 * 调用来源（并让审计看起来像有人操作过），因此这里提供一组显式的、绕过授权谓词的窄接口，名称与
 * 仓储层的 `*Unscoped` 前缀保持一致，调用点在代码评审中一眼可见。
 *
 * 接口只暴露系统编排真正需要的投影（id / 名称 / 描述 / 元数据），不回传数据库行：系统调用方不应该
 * 依赖归属列、时间戳这类与它的职责无关的存储细节。
 *
 * 与 Facade 的边界是**授权**而不是能力：内容与资源行的补偿顺序复用同一个 `writeSkillDocument`，
 * 因此系统路径与用户路径在"文件与行不许各说一套"上遵循同一套不变量。
 */

/** 系统路径读到的技能投影。 */
export interface SkillSystemRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 归属组织：系统编排按租户推进，调用方需要确认自己操作的是哪一个租户的资源。 */
  readonly organizationId: string;
  readonly metadata?: Record<string, string>;
}

export interface SkillSystemApi {
  /** 列出该组织的全部技能（不含跨组织公开资源：系统编排只关心托管租户自己的行）。 */
  listByOrganization(organizationId: string): Promise<readonly SkillSystemRecord[]>;
  findByName(input: { organizationId: string; name: string }): Promise<SkillSystemRecord | undefined>;
  /** 按资源 ID 读取（下载令牌路径用它复核令牌与资源的一致性）。 */
  findById(input: { resourceId: string }): Promise<SkillSystemRecord | undefined>;
  /**
   * 幂等写入文档内容与资源行（同组织同名走 upsert）。
   *
   * 归属列与 `visibility` 是创建期属性，重复同步不会改写（见仓储的 `upsertByOrgAndName`）。
   */
  writeDocument(input: {
    organizationId: string;
    ownerUserId: string;
    name: string;
    description: string;
    content: string;
    metadata?: Record<string, string>;
  }): Promise<SkillSystemRecord>;
  /**
   * 删除资源行并清理文档内容；行不存在时返回 false 且不触碰文件系统。
   *
   * 内容清理失败只留下不可达文件（与 Facade 的删除路径同序：先删行、再删内容），因此不阻断调用方。
   */
  removeByName(input: { organizationId: string; name: string }): Promise<boolean>;
  /**
   * 设置公开受众；返回是否命中了资源行。
   *
   * 不抛异常：调用方（builtin 同步）在启动流程里批量执行，单条行缺失不应该中断整个启动，但调用方
   * 必须把 false 记录为可见的告警，而不是当作成功。
   */
  setPublicReadable(input: { resourceId: string; publicReadable: boolean }): Promise<boolean>;
}

export function createSkillSystem(service: SkillService): SkillSystemApi {
  return {
    async listByOrganization(organizationId) {
      const rows = await service.listByOrganizationUnscoped(organizationId);
      return rows.map(toSystemRecord);
    },

    async findByName(input) {
      const row = await service.findByNameUnscoped(input);
      return row === undefined ? undefined : toSystemRecord(row);
    },

    async findById(input) {
      const row = await service.findRowUnscoped(input.resourceId);
      return row === undefined ? undefined : toSystemRecord(row);
    },

    async writeDocument(input) {
      const safeName = validateSkillName(input.name);
      const normalized = normalizeSkillWriteData({
        description: input.description,
        content: input.content,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });

      // 行写入放进文件快照的保护范围：行写失败先恢复文件内容，再上抛原始错误。
      await writeSkillDocument({
        organizationId: input.organizationId,
        name: safeName,
        description: normalized.description,
        content: normalized.content,
        ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
        persist: async (written) => {
          const resourceId = await service.upsertByOrgAndName({
            name: safeName,
            data: { description: written.description, metadata: written.metadata },
            organizationId: input.organizationId,
            ownerUserId: input.ownerUserId,
          });
          if (resourceId === undefined) {
            throw new Error(`Skill '${safeName}' 写入后未解析出资源行`);
          }
        },
      });

      // 回读而不是拼接入参：返回的投影必须是库里的真实状态，否则调用方会拿到"以为写进去了"的假象。
      const row = await service.findByNameUnscoped({ organizationId: input.organizationId, name: safeName });
      if (row === undefined) throw new Error(`Skill '${safeName}' 写入后回读失败`);
      return toSystemRecord(row);
    },

    async removeByName(input) {
      const deleted = await service.removeByName(input);
      if (!deleted) return false;
      await deleteSkillDocument(input);
      return true;
    },

    async setPublicReadable(input) {
      const visibility: ResourceVisibility = input.publicReadable ? "public" : "private";
      return service.setVisibilityUnscoped({ resourceId: input.resourceId, visibility });
    },
  };
}

function toSystemRecord(row: SkillRow): SkillSystemRecord {
  const metadata = toSkillMetadata(row.metadata);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    organizationId: row.organizationId,
    ...(metadata === undefined ? {} : { metadata }),
  };
}
