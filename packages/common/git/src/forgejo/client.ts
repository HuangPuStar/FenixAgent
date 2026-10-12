/**
 * Forgejo 适配器门面。
 *
 * 对外提供公共 Git 领域类型的仓库/工单/评论/标签操作：路径拼接、分页游标、DTO 转换与错误提升都在这里
 * 收口，调用方（组合根与作用域客户端）不需要知道 Forgejo 的端点形状。传输、超时、并发与错误码映射
 * 属于 `http.ts`；DTO → 领域类型的严格校验属于 `mapper.ts`。
 *
 * 三个刻意的取舍：
 * - 路径段一律编码并拒绝纯点段（`.` / `..`）：`PATCH /repos/{o}/{r}/issues/..` 会被 URL 归一化折叠成
 *   仓库设置端点，调用方传入的编号就能改写请求语义；
 * - 写方法在**映射阶段**失败时同样提升为 `WRITE_UNCERTAIN`：远端已经返回 2xx，写已落库，只是响应体
 *   不符合合同，此刻不能报 `INVALID_RESPONSE` 让上层当普通失败处理；
 * - 每个操作生成一个 `operationId`：错误码面向用户、日志面向运维，两者只能靠它串起来。
 */

import { createLogger } from "@fenix/logger";
import { GitError, isGitError, toWriteUncertain } from "../contracts/errors";
import type {
  CreateIssueInput,
  CreateLabelInput,
  CreateRepositoryInput,
  EditIssueInput,
  EditLabelInput,
  GitComment,
  GitIssue,
  GitIssueListQuery,
  GitLabel,
  GitListQuery,
  GitPage,
  GitRepository,
  RepositoryRef,
} from "../contracts/types";
import { type FetchLike, ForgejoHttpClient, type ForgejoRequestContext } from "./http";
import { toGitComment, toGitIssue, toGitLabel, toGitRepository } from "./mapper";

export interface ForgejoClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly requestTimeoutMs?: number; // 默认 15000
  readonly attachmentTimeoutMs?: number; // 默认 60000（T05 用，先声明）
  readonly maxConcurrentRequests?: number; // 默认 16
  /** 读重试退避基数（毫秒）；默认 200，测试注入 0 以消除等待。 */
  readonly readRetryDelayMs?: number;
  readonly fetchImpl?: FetchLike;
}

const DEFAULT_ATTACHMENT_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 100;
/** 标签翻页上限：1000 个标签已远超运营约定，达到上限只告警不继续，避免上游忽略 page 参数时死循环。 */
const MAX_LABEL_PAGES = 10;
const DECIMAL_PAGE = /^[1-9]\d*$/;
const DECIMAL_ID = /^\d+$/;
const DOTS_ONLY = /^\.+$/;
const NEXT_LINK_PATTERN = /<([^>]+)>\s*;\s*rel="?next"?/i;
/** `Link` 头里可能是相对 URL，解析需要一个不会真正被请求的占位基址。 */
const LINK_BASE_URL = "http://link.invalid";

const logger = createLogger("git");

/** 每次对外操作一个关联 ID：供运维把用户可见错误与请求日志对上。 */
const newOperationId = (): string => crypto.randomUUID();

function operationContext(ref: RepositoryRef, operationId: string): ForgejoRequestContext {
  return { operationId, connectionId: ref.connectionId, repositoryRef: `${ref.owner}/${ref.name}` };
}

/**
 * 路径段编码。
 *
 * `encodeURIComponent` 不转义 `.`，纯点段会让 URL 归一化把请求折叠到别的端点；调用方传入的坐标
 * 宁可判为不存在，也不能改写请求语义。
 */
function encodePathSegment(value: string, field: string): string {
  if (value.length === 0 || DOTS_ONLY.test(value)) {
    throw new GitError("NOT_FOUND", `${field} 不是合法的路径段`);
  }
  return encodeURIComponent(value);
}

/** Forgejo 的编号（工单/评论/标签）是十进制整数；非数字直接判为不存在。 */
function decimalId(value: string, field: string): string {
  if (!DECIMAL_ID.test(value)) throw new GitError("NOT_FOUND", `${field} 不是合法的十进制编号`);
  return value;
}

function repoBase(ref: RepositoryRef): string {
  return `/repos/${encodePathSegment(ref.owner, "仓库 owner")}/${encodePathSegment(ref.name, "仓库 name")}`;
}

function issueBase(ref: RepositoryRef, issueNumber: string): string {
  return `${repoBase(ref)}/issues/${decimalId(issueNumber, "工单编号")}`;
}

function commentBase(ref: RepositoryRef, commentId: string): string {
  return `${repoBase(ref)}/issues/comments/${decimalId(commentId, "评论编号")}`;
}

function labelBase(ref: RepositoryRef, labelId: string): string {
  return `${repoBase(ref)}/labels/${decimalId(labelId, "标签编号")}`;
}

/** 游标是「下一页页码的十进制字符串」；非法值按合同报 `INVALID_RESPONSE`，不替调用方猜意图。 */
function parseCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined) return 1;
  if (!DECIMAL_PAGE.test(cursor)) {
    throw new GitError("INVALID_RESPONSE", "分页 cursor 非法：应为十进制页码字符串");
  }
  return Number.parseInt(cursor, 10);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)));
}

function pageQuery(page: number, limit: number): string {
  return new URLSearchParams({ page: String(page), limit: String(limit) }).toString();
}

/**
 * 从 `Link` 头取下一页页码。
 *
 * Forgejo 会把 `limit` 按自身上限夹取，因此「本页条数 < 请求条数」既不能证明没有下一页，也不能证明有；
 * 只有 `rel="next"` 是分页事实源。头里可能同时带 prev/first/last，只认 next。
 */
function nextPageFromLink(linkHeader: string): string | null {
  const match = NEXT_LINK_PATTERN.exec(linkHeader);
  if (match === null) return null;
  try {
    const page = new URL(match[1], LINK_BASE_URL).searchParams.get("page");
    return page !== null && DECIMAL_PAGE.test(page) ? page : null;
  } catch (error) {
    logger.warn("git.forgejo.link_header_invalid", {
      reason: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

/**
 * 下一页游标。
 *
 * 头存在时以它为准（没有 `rel="next"` 即末页）；头整体缺失（中间代理剥离）时退化为「本页非空就有下
 * 一页」——宁可多读一个空页，也不静默截断列表。
 */
function resolveNextCursor(linkHeader: string | null, page: number, receivedCount: number): string | null {
  if (linkHeader !== null) return nextPageFromLink(linkHeader);
  return receivedCount > 0 ? String(page + 1) : null;
}

/** 列表响应必须是数组；单条元素的字段级校验由各自 mapper 完成。 */
function mapItems<TItem>(payload: unknown, field: string, map: (item: unknown) => TItem): readonly TItem[] {
  if (!Array.isArray(payload)) {
    throw new GitError("INVALID_RESPONSE", `Forgejo ${field} 响应不是数组`);
  }
  return payload.map((item) => map(item));
}

export class ForgejoClient {
  readonly #http: ForgejoHttpClient;
  readonly #attachmentTimeoutMs: number;

  constructor(options: ForgejoClientOptions) {
    this.#http = new ForgejoHttpClient({
      baseUrl: options.baseUrl,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      maxConcurrentRequests: options.maxConcurrentRequests,
      readRetryDelayMs: options.readRetryDelayMs,
      fetchImpl: options.fetchImpl,
    });
    const attachmentTimeoutMs = options.attachmentTimeoutMs;
    this.#attachmentTimeoutMs =
      attachmentTimeoutMs !== undefined && Number.isFinite(attachmentTimeoutMs) && attachmentTimeoutMs > 0
        ? attachmentTimeoutMs
        : DEFAULT_ATTACHMENT_TIMEOUT_MS;
  }

  /** 附件流的超时（T05 的上传/下载消费它）；普通请求走 `requestTimeoutMs`。 */
  get attachmentTimeoutMs(): number {
    return this.#attachmentTimeoutMs;
  }

  async getRepository(ref: RepositoryRef): Promise<GitRepository> {
    const operationId = newOperationId();
    const payload = await this.#http.getJson(repoBase(ref), operationContext(ref, operationId));
    return toGitRepository(ref, payload);
  }

  /**
   * 在凭据账号命名空间下建私有仓库。
   *
   * `POST /user/repos` 不接受 owner（只能建在凭据账号名下），`CreateRepositoryInput.owner` 由调用方
   * 用于授权核对，不发送。返回 ref 的 `connectionId` 为空串，组合根必须补齐（见 `mapper.ts`）。
   */
  async createRepository(input: CreateRepositoryInput): Promise<GitRepository> {
    const operationId = newOperationId();
    return this.#guardWrite(async () => {
      const payload = await this.#http.postJson(
        "/user/repos",
        {
          name: input.name,
          private: true,
          auto_init: true,
          ...(input.description === undefined || input.description === null ? {} : { description: input.description }),
        },
        { operationId, repositoryRef: `${input.owner}/${input.name}` },
      );
      return toGitRepository(null, payload);
    });
  }

  async setRepositoryIssuesEnabled(ref: RepositoryRef): Promise<GitRepository> {
    const operationId = newOperationId();
    return this.#guardWrite(async () => {
      const payload = await this.#http.patchJson(
        repoBase(ref),
        { has_issues: true },
        operationContext(ref, operationId),
      );
      return toGitRepository(ref, payload);
    });
  }

  async listIssues(ref: RepositoryRef, query: GitIssueListQuery): Promise<GitPage<GitIssue>> {
    const operationId = newOperationId();
    const page = parseCursor(query.cursor);
    const limit = clampLimit(query.limit);
    const params = new URLSearchParams(pageQuery(page, limit));
    if (query.state !== undefined) params.set("state", query.state);
    if (query.labels !== undefined && query.labels.length > 0) params.set("labels", query.labels.join(","));
    if (query.query !== undefined && query.query.length > 0) params.set("q", query.query);
    const { body, headers } = await this.#http.getJsonWithHeaders(
      `${repoBase(ref)}/issues?${params.toString()}`,
      operationContext(ref, operationId),
    );
    const items = mapItems(body, "工单列表", toGitIssue);
    return { items, nextCursor: resolveNextCursor(headers.get("link"), page, items.length) };
  }

  async getIssue(ref: RepositoryRef, issueNumber: string): Promise<GitIssue> {
    const operationId = newOperationId();
    const payload = await this.#http.getJson(issueBase(ref, issueNumber), operationContext(ref, operationId));
    return toGitIssue(payload);
  }

  async createIssue(ref: RepositoryRef, input: CreateIssueInput): Promise<GitIssue> {
    const operationId = newOperationId();
    return this.#guardWrite(async () => {
      const payload = await this.#http.postJson(
        `${repoBase(ref)}/issues`,
        {
          title: input.title,
          body: input.body,
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          // 负责人传数组：Forgejo 的创建接口只接受 assignees，单个负责人由调用方保证。
          ...(input.assignee === undefined || input.assignee === null ? {} : { assignees: [input.assignee] }),
        },
        operationContext(ref, operationId),
      );
      return toGitIssue(payload);
    });
  }

  async editIssue(ref: RepositoryRef, issueNumber: string, input: EditIssueInput): Promise<GitIssue> {
    const operationId = newOperationId();
    return this.#guardWrite(async () => {
      const payload = await this.#http.patchJson(
        issueBase(ref, issueNumber),
        {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.state === undefined ? {} : { state: input.state }),
        },
        operationContext(ref, operationId),
      );
      return toGitIssue(payload);
    });
  }

  /**
   * 全量替换工单标签，返回替换后的标签集合。
   *
   * Forgejo 的 `PUT .../labels` 正常返回标签数组；返回体不是数组（例如 204）时回读工单取真实集合——
   * 只凭「响应为空」报告空标签集合，会让调用方以为标签被清空了。
   */
  async setIssueLabels(
    ref: RepositoryRef,
    issueNumber: string,
    labels: readonly string[],
  ): Promise<readonly GitLabel[]> {
    const operationId = newOperationId();
    const mapped = await this.#guardWrite(async () => {
      const payload = await this.#http.putJson(
        `${issueBase(ref, issueNumber)}/labels`,
        { labels: [...labels] },
        operationContext(ref, operationId),
      );
      return Array.isArray(payload) ? payload.map((item) => toGitLabel(item)) : null;
    });
    if (mapped !== null) return mapped;
    return (await this.getIssue(ref, issueNumber)).labels;
  }

  async listComments(ref: RepositoryRef, issueNumber: string, query: GitListQuery): Promise<GitPage<GitComment>> {
    const operationId = newOperationId();
    const page = parseCursor(query.cursor);
    const limit = clampLimit(query.limit);
    const { body, headers } = await this.#http.getJsonWithHeaders(
      `${issueBase(ref, issueNumber)}/comments?${pageQuery(page, limit)}`,
      operationContext(ref, operationId),
    );
    const items = mapItems(body, "评论列表", (item) => toGitComment(item, issueNumber));
    return { items, nextCursor: resolveNextCursor(headers.get("link"), page, items.length) };
  }

  async createComment(ref: RepositoryRef, issueNumber: string, body: string): Promise<GitComment> {
    const operationId = newOperationId();
    return this.#guardWrite(async () => {
      const payload = await this.#http.postJson(
        `${issueBase(ref, issueNumber)}/comments`,
        { body },
        operationContext(ref, operationId),
      );
      return toGitComment(payload, issueNumber);
    });
  }

  async editComment(ref: RepositoryRef, commentId: string, body: string): Promise<GitComment> {
    const operationId = newOperationId();
    return this.#guardWrite(async () => {
      const payload = await this.#http.patchJson(
        commentBase(ref, commentId),
        { body },
        operationContext(ref, operationId),
      );
      // 该端点路径不含工单编号，mapper 从响应的 issue_url 取。
      return toGitComment(payload);
    });
  }

  /**
   * 取仓库的全部标签。
   *
   * 接口本身没有游标参数，但调用方期望拿到完整集合（标签选择器少一项就是静默丢数据），因此按 `Link`
   * 头翻页；`MAX_LABEL_PAGES` 只兜「上游忽略 page 参数」这类故障。
   */
  async listLabels(ref: RepositoryRef): Promise<readonly GitLabel[]> {
    const operationId = newOperationId();
    const context = operationContext(ref, operationId);
    const collected: GitLabel[] = [];
    for (let page = 1; page <= MAX_LABEL_PAGES; page += 1) {
      const { body, headers } = await this.#http.getJsonWithHeaders(
        `${repoBase(ref)}/labels?${pageQuery(page, MAX_PAGE_LIMIT)}`,
        context,
      );
      const items = mapItems(body, "标签列表", toGitLabel);
      collected.push(...items);
      if (resolveNextCursor(headers.get("link"), page, items.length) === null) return collected;
    }
    logger.warn("git.forgejo.labels_page_limit_reached", {
      connectionId: ref.connectionId,
      repositoryRef: `${ref.owner}/${ref.name}`,
      pages: MAX_LABEL_PAGES,
    });
    return collected;
  }

  async createLabel(ref: RepositoryRef, input: CreateLabelInput): Promise<GitLabel> {
    const operationId = newOperationId();
    return this.#guardWrite(async () => {
      const payload = await this.#http.postJson(
        `${repoBase(ref)}/labels`,
        {
          name: input.name,
          // null 与 undefined 一样按「不提供」处理：Forgejo 不接受 null 清空字段，清空要用空串。
          ...(input.color === undefined || input.color === null ? {} : { color: input.color }),
          ...(input.description === undefined || input.description === null ? {} : { description: input.description }),
        },
        operationContext(ref, operationId),
      );
      return toGitLabel(payload);
    });
  }

  async editLabel(ref: RepositoryRef, labelId: string, input: EditLabelInput): Promise<GitLabel> {
    const operationId = newOperationId();
    return this.#guardWrite(async () => {
      const payload = await this.#http.patchJson(
        labelBase(ref, labelId),
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.color === undefined || input.color === null ? {} : { color: input.color }),
          ...(input.description === undefined || input.description === null ? {} : { description: input.description }),
        },
        operationContext(ref, operationId),
      );
      return toGitLabel(payload);
    });
  }

  /**
   * 写操作的整体错误归一。
   *
   * 传输层已把网络故障与解析失败提升为 `WRITE_UNCERTAIN`，这里再包一层是为了覆盖**映射阶段**的失败：
   * 远端已返回 2xx（写已落库）但响应体不符合合同，此刻同样只能说「结果未知」，不能报
   * `INVALID_RESPONSE` 让上层当普通失败重发。`toWriteUncertain` 对已提升的错误是幂等的。
   */
  async #guardWrite<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw isGitError(error) ? toWriteUncertain(error) : error;
    }
  }
}
