import { type ActorContext, ConflictError, NotFoundError, ValidationError } from "@fenix/platform-sdk";
import type { SkillDetailView, SkillListItem } from "../facades/skill-facade";
import { getSkillServerModule } from "../runtime";
import type { UploadSkillFile } from "./skill-content";

/** Independent public projection; filesystem paths do not cross this boundary. */
export function toApiSkill(row: SkillListItem | SkillDetailView) {
  const summary = { id: row.id, name: row.name, description: row.description, scope: row.scope, access: row.access };
  return "content" in row ? { ...summary, content: row.content, metadata: row.metadata } : summary;
}
/** Version application actions reuse the existing content lifecycle and compensation. */
export class ApiV1SkillService {
  private get facade() {
    return getSkillServerModule().facade;
  }
  async get(actor: ActorContext, id: string) {
    const row = await this.facade.readDetailById(actor, id);
    if (!row) throw new NotFoundError("Skill not found");
    return { ...toApiSkill(row), content: row.content, metadata: row.metadata };
  }
  async list(actor: ActorContext, query: { page: number; pageSize: number }) {
    const result = await this.facade.list(actor, { limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
    return { ...query, total: result.total, items: result.items.map(toApiSkill) };
  }
  async import(actor: ActorContext, files: UploadSkillFile[], overwrite: boolean) {
    const name = files[0]?.skillName;
    if (!name) throw new ValidationError("Skill files required");
    const result = await this.facade.importSingleSkill(actor, files, { overwrite });
    if (result.status === "conflict") throw new ConflictError("Skill already exists");
    return {
      created: result.created ?? true,
      data: { ...toApiSkill(result.detail), content: result.detail.content, metadata: result.detail.metadata },
    };
  }
  async patch(
    actor: ActorContext,
    id: string,
    input: { content?: string; description?: string; metadata?: Record<string, string>; publicReadable?: boolean },
  ) {
    const { publicReadable, ...data } = input;
    if (Object.keys(data).length === 0 && publicReadable !== undefined)
      await this.facade.setPublicReadableById(actor, id, publicReadable);
    else
      await this.facade.updateById(actor, id, data, { publicReadable, replaceMetadata: input.metadata !== undefined });
    return this.get(actor, id);
  }
  async remove(actor: ActorContext, id: string) {
    await this.facade.removeById(actor, id);
    return null;
  }
}
