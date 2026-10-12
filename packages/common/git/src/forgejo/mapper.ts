/**
 * Forgejo DTO → 公共领域类型的转换层（适配器的防腐边界）。
 *
 * 跨出本文件的值必须已经满足 `contracts/types.ts` 的形状，因此这里是**严格校验**发生的地方。
 * 缺字段的判定刻意分成两类，避免两个极端——「一个可选字段缺席就让整次读取失败」和「静默拿默认值
 * 顶替上游给错的值」：
 * - 身份与状态字段（id、编号、标题、作者、state）缺失或类型不符 → `INVALID_RESPONSE`：它们是寻址与
 *   判定的依据，猜一个值比报错危险得多；
 * - 内容与可选字段（body、labels、assignee、时间、颜色、描述）**缺失**时取安全默认（""、[]、null），
 *   但**存在却类型不符**仍是 `INVALID_RESPONSE`：默认值只用于「上游没给」，不用于「上游给错了」。
 *
 * 错误消息只带字段名，绝不回显响应体——上游正文可能包含用户内容。所有数字 ID 一律 `String(...)`：
 * Forgejo 用 int64，JavaScript 的 number 超过 2^53 后不再精确，退化成 number 会在某次比较里静默出错。
 */

import { GitError } from "../contracts/errors";
import type {
  GitActor,
  GitComment,
  GitIssue,
  GitLabel,
  GitObjectId,
  GitRepository,
  IssueState,
  RepositoryRef,
} from "../contracts/types";
import type { ForgejoCommentDto, ForgejoIssueDto, ForgejoLabelDto, ForgejoRepositoryDto, ForgejoUserDto } from "./dto";

function invalidResponse(detail: string): GitError {
  return new GitError("INVALID_RESPONSE", `Forgejo 响应不符合适配器合同：${detail}`);
}

/** JSON 对象收窄（数组与 null 都不算）；类型谓词让调用点不必断言。 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 对象形态校验；返回 DTO 类型不需要断言——DTO 的字段全部 optional + unknown。 */
function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw invalidResponse(`字段 ${field} 不是对象`);
  return value;
}

function asUserDto(value: unknown): ForgejoUserDto {
  return asObject(value, "user");
}

function asLabelDto(value: unknown): ForgejoLabelDto {
  return asObject(value, "label");
}

function asRepositoryDto(value: unknown): ForgejoRepositoryDto {
  return asObject(value, "repository");
}

function asIssueDto(value: unknown): ForgejoIssueDto {
  return asObject(value, "issue");
}

function asCommentDto(value: unknown): ForgejoCommentDto {
  return asObject(value, "comment");
}

/** 数字 ID（字符串承载）。接受 number 与字符串两种上游形态，其它类型拒绝。 */
function requireId(value: unknown, field: string): GitObjectId {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidResponse(`字段 ${field} 不是数字 ID`);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidResponse(`字段 ${field} 不是非空字符串`);
  }
  return value;
}

/** 可选文本：缺失或空串归一为 null（Forgejo 的空描述/空颜色与「没有值」等价）。 */
function readOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalidResponse(`字段 ${field} 不是字符串`);
  return value.length === 0 ? null : value;
}

/** 正文：缺失按空正文处理（Forgejo 的空正文可能是 null 或 ""），存在却非字符串则拒绝。 */
function readBodyText(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalidResponse(`字段 ${field} 不是字符串`);
  return value;
}

/** 能力开关：缺失按 false 处理，让上层走「确保开启」的自愈路径，而不是把缺字段升级成整次失败。 */
function readFlag(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw invalidResponse(`字段 ${field} 不是布尔值`);
  return value;
}

function readArray(value: unknown, field: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidResponse(`字段 ${field} 不是数组`);
  return value;
}

/** 时间戳归一为 ISO 字符串；非法值返回 null，不臆造时间（该字段不参与并发判定）。 */
function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function requireState(value: unknown): IssueState {
  if (value === "open" || value === "closed") return value;
  throw invalidResponse("字段 issue.state 不是 open/closed");
}

/**
 * 评论所属工单编号。
 *
 * 列表与创建路径已从请求路径知道编号，直接用；评论编辑端点（`PATCH /issues/comments/{id}`）的路径里
 * 没有工单编号，只能取响应 `issue_url` 的末段——Forgejo 的评论对象不单列编号字段。两处都拿不到说明
 * 响应不符合合同，绝不能猜一个编号填进去：评论会因此挂到错误工单上。
 */
function resolveIssueNumber(comment: ForgejoCommentDto, issueNumber: string | null | undefined): GitObjectId {
  if (issueNumber !== undefined && issueNumber !== null && issueNumber.length > 0) return issueNumber;
  if (typeof comment.issue_url === "string") {
    const path = comment.issue_url.split(/[?#]/)[0] ?? "";
    const last = path.split("/").pop() ?? "";
    if (/^\d+$/.test(last)) return last;
  }
  throw invalidResponse("评论响应缺少工单编号（comment.issue_url）");
}

/** 操作者投影；`id` 与 `login` 都是身份依据，缺失即拒绝。 */
export function toGitActor(dto: unknown): GitActor {
  const user = asUserDto(dto);
  return {
    id: requireId(user.id, "user.id"),
    name: requireText(user.login, "user.login"),
  };
}

export function toGitLabel(dto: unknown): GitLabel {
  const label = asLabelDto(dto);
  return {
    id: requireId(label.id, "label.id"),
    name: requireText(label.name, "label.name"),
    color: readOptionalText(label.color, "label.color"),
    description: readOptionalText(label.description, "label.description"),
  };
}

/**
 * 仓库投影。
 *
 * `ref` 为 null 表示调用方尚未持有仓库坐标（创建仓库：客户端只认 baseUrl，不感知连接标识与仓库 ID），
 * 此时身份全部取自响应；返回 ref 的 `connectionId` 是空串，**必须**由组合根在交给调用方前补齐。
 * `ref` 非 null 时它是权威坐标（来自绑定记录），DTO 的身份字段不再参与寻址。
 */
export function toGitRepository(ref: RepositoryRef | null, dto: unknown): GitRepository {
  const repository = asRepositoryDto(dto);
  return {
    ref: ref ?? repositoryRefFromDto(repository),
    isPrivate: readFlag(repository.private, "repository.private"),
    issuesEnabled: readFlag(repository.has_issues, "repository.has_issues"),
    defaultBranch: readOptionalText(repository.default_branch, "repository.default_branch"),
    description: readOptionalText(repository.description, "repository.description"),
  };
}

/**
 * 创建仓库后的坐标。
 *
 * `POST /user/repos` 只能建在凭据账号的命名空间下，owner/name/id 只能取自响应；`connectionId` 在本层
 * 不可得（构造参数只有 baseUrl 与 token），置空串。空串一旦泄漏进绑定记录，按连接寻址的后续操作会
 * 全部失配——所以组合根必须覆盖它。
 */
function repositoryRefFromDto(repository: ForgejoRepositoryDto): RepositoryRef {
  return {
    connectionId: "",
    providerRepositoryId: requireId(repository.id, "repository.id"),
    owner: requireText(asUserDto(repository.owner).login, "repository.owner.login"),
    name: requireText(repository.name, "repository.name"),
  };
}

export function toGitIssue(dto: unknown): GitIssue {
  const issue = asIssueDto(dto);
  return {
    number: requireId(issue.number, "issue.number"),
    title: requireText(issue.title, "issue.title"),
    body: readBodyText(issue.body, "issue.body"),
    state: requireState(issue.state),
    labels: readArray(issue.labels, "issue.labels").map((item) => toGitLabel(item)),
    author: toGitActor(issue.user),
    // assignee 是唯一负责人；assignees 数组只在创建时用于传参，不参与投影。
    assignee: issue.assignee === undefined || issue.assignee === null ? null : toGitActor(issue.assignee),
    providerUpdatedAt: toIsoOrNull(issue.updated_at),
  };
}

export function toGitComment(dto: unknown, issueNumber?: string | null): GitComment {
  const comment = asCommentDto(dto);
  return {
    id: requireId(comment.id, "comment.id"),
    issueNumber: resolveIssueNumber(comment, issueNumber),
    body: readBodyText(comment.body, "comment.body"),
    author: toGitActor(comment.user),
    providerUpdatedAt: toIsoOrNull(comment.updated_at),
  };
}
