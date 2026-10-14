import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitError } from "@fenix/git/server";
import {
  initializeTestApplicationInfrastructure,
  resetAllStubs,
  stubIdentityDirectory,
} from "@fenix/platform-sdk/testing";
import { resetTicketsServerModule } from "../server/runtime";
import { TICKET_OPERATION_STEP } from "../server/services/ticket-operation-service";
import {
  BINDING_A,
  BINDING_B,
  createTicketHarness,
  DATABASE_STUB,
  gitAttachment,
  IDEMPOTENCY_KEY,
  installSystemTicketRoutes,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  stubDirectory,
  type TicketHarness,
} from "./ticket-harness";

/**
 * `/api/system/tickets/:projectId/:number/attachments*` 协议层用例（**平台管理面的附件**）。
 *
 * 与 `/web` 面同形的部分：multipart 单文件形状（字段 `file`，一次一个）、大小上限、幂等键的三个稳定码、
 * 201/202、下载响应的 `Content-Disposition` 与 `nosniff`、上游不可用 503、项目暂停 503 且零上游调用。
 *
 * 本面**特有**的两点：
 *
 * 1. 上传的审计主体是系统托管租户（账本 `actor_id`），因此管理台传的附件在账本里可追溯到平台侧操作；
 * 2. 跨组织坐标：附件读写只落在被指向项目的仓库绑定上。
 */

const SYSTEM_KEY = "sys-key-ticket-attachments";
const SYSTEM_USER = "user_system_admin";
const ISSUE_NUMBER = "1";

function systemRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${SYSTEM_KEY}` },
  });
}

/** 构造 multipart 上传请求；`files` 为空表示表单里没有文件字段（模拟前端漏字段）。 */
function uploadRequest(path: string, files: readonly File[], idempotencyKey?: string): Request {
  const form = new FormData();
  for (const file of files) form.append("file", file);
  return systemRequest(path, {
    method: "POST",
    headers: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
    body: form,
  });
}

/** 两个组织的项目：仓库绑定不同，才能看出附件读写打到了哪一个组织的仓库。 */
function seedTwoOrganizations(harness: TicketHarness): void {
  harness.projectStore.seed({
    id: PROJECT_A,
    organizationId: "org_alpha",
    repositoryRef: BINDING_A,
    name: "alpha-repo",
  });
  harness.projectStore.seed({ id: PROJECT_B, organizationId: ORG_B, repositoryRef: BINDING_B, name: "beta-repo" });
}

let harness: TicketHarness;

beforeEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
  harness = createTicketHarness();
  stubDirectory({ users: [{ id: "user_member", name: "张三" }] });
  stubIdentityDirectory({
    resolveSystemTenant: async () => ({
      organizationId: "org_admin",
      organizationSlug: "admin",
      userId: SYSTEM_USER,
      email: "admin@example.test",
    }),
  });
  seedTwoOrganizations(harness);
});

afterEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
});

describe("管理面附件 — 凭据即判据", () => {
  // 业务意图：附件是二进制内容，无 key 时必须零读取零写入——这条面泄露字节就等于泄露用户上传的文件。
  test("无 key 时全部端点 401 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);
    const requests = [
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`, {
        method: "POST",
        headers: { "idempotency-key": IDEMPOTENCY_KEY },
        body: new FormData(),
      }),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments/8`),
    ];

    for (const request of requests) {
      const response = await app.handle(request);
      expect(response.status).toBe(401);
    }
    expect(harness.git.calls).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });
});

describe("管理面附件 — 列表", () => {
  // 业务意图：附件列表是详情页的一块，管理面必须与 web 面同形（视图不含任何下载地址，内容一律经代理路由取）。
  test("成功：返回附件视图且不含下载地址", async () => {
    harness.git.behaviour.listAttachments = async () => [gitAttachment({ id: "8", name: "截图.png", size: 1024 })];
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_B}/3/attachments`));
    const body = (await response.json()) as { data: { items: Array<Record<string, unknown>> } };

    expect(response.status).toBe(200);
    expect(body.data.items).toEqual([{ attachmentId: "8", name: "截图.png", size: 1024, createdAt: null }]);
    expect(harness.git.ops("createScopedClient").map((call) => call.bindingId)).toEqual([BINDING_B]);
  });

  // 业务意图：上游不可用必须 503 而不是空列表——空列表会被当成「这个工单没有附件」。
  test("上游不可用：503 而不是空列表", async () => {
    harness.git.behaviour.listAttachments = async () => {
      throw new GitError("UNAVAILABLE", "上游不可达");
    };
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("GIT_UNAVAILABLE");
  });

  // 业务意图：工单号形状非法在边界 400，不进入上游查询。
  test("工单号非法：400 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/abc/attachments`));

    expect(response.status).toBe(400);
    expect(harness.git.calls).toEqual([]);
  });
});

describe("管理面附件 — 上传", () => {
  // 业务意图：管理台要能补传截图；上传成功即终态（附件没有本地行），账本审计主体记系统租户。
  test("成功：201 + 附件视图，账本落 attachment_uploaded", async () => {
    harness.git.behaviour.uploadAttachment = async (_issueNumber, input) =>
      gitAttachment({ id: "9", name: input.name, size: input.content.byteLength });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      uploadRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`,
        [new File([new Uint8Array([1, 2, 3])], "截图.png", { type: "image/png" })],
        IDEMPOTENCY_KEY,
      ),
    );
    const body = (await response.json()) as {
      data: { attachment: { attachmentId: string; name: string }; operationId: string };
    };

    expect(response.status).toBe(201);
    expect(body.data.attachment).toEqual({ attachmentId: "9", name: "截图.png", size: 3, createdAt: null });
    const operation = harness.operationStore.rows[0];
    expect(operation?.actorId).toBe(SYSTEM_USER);
    expect(operation?.kind).toBe("attachment.upload");
    expect(operation?.status).toBe("succeeded");
    expect(operation?.step).toBe(TICKET_OPERATION_STEP.attachmentUploaded);
    expect(harness.git.ops("attachments.upload").map((call) => call.issueNumber)).toEqual([ISSUE_NUMBER]);
  });

  // 业务意图：缺 Idempotency-Key 是稳定 400（不是通用校验错误），且零远端写入——上传是会产生远端对象的写路径。
  test("缺幂等键：400 IDEMPOTENCY_KEY_REQUIRED 且零写入", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      uploadRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`, [
        new File([new Uint8Array([1])], "截图.png"),
      ]),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 业务意图：一次请求只收一个文件（一次请求 = 一个幂等键 = 一次远端写入），多文件必须当场 400 且零写入。
  test("一次传两个文件：400 且零写入", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      uploadRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`,
        [new File([new Uint8Array([1])], "a.png"), new File([new Uint8Array([2])], "b.png")],
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(400);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 业务意图：项目暂停只拦写——503 且零上游调用，管理面不得绕开组织的暂停决定。
  test("项目暂停：503 且零上游调用", async () => {
    const paused = harness.projectStore.rows.find((row) => row.id === PROJECT_B);
    if (paused === undefined) throw new Error("用例未种 PROJECT_B");
    paused.status = "paused";
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      uploadRequest(
        `/api/system/tickets/${PROJECT_B}/3/attachments`,
        [new File([new Uint8Array([1])], "截图.png")],
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("TICKETS_PAUSED");
    expect(harness.git.calls).toEqual([]);
  });

  // 业务意图：跨组织坐标互不串——乙组织工单的附件只写进乙组织的仓库绑定。
  test("跨组织坐标：上传落在被指向组织的仓库", async () => {
    harness.git.behaviour.uploadAttachment = async (_issueNumber, input) =>
      gitAttachment({ id: "9", name: input.name, size: input.content.byteLength });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      uploadRequest(
        `/api/system/tickets/${PROJECT_B}/3/attachments`,
        [new File([new Uint8Array([1])], "截图.png")],
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(201);
    expect(harness.git.ops("createScopedClient").map((call) => call.bindingId)).toEqual([BINDING_B]);
    expect(harness.operationStore.rows.map((row) => row.organizationId)).toEqual([ORG_B]);
  });
});

describe("管理面附件 — 字节读取", () => {
  /** 下载/预览共用的上游替身：内容与类型都由它给出，两种处置下必须完全一致。 */
  function stubDownload(harness: TicketHarness): void {
    harness.git.behaviour.downloadAttachment = async () => ({
      attachment: gitAttachment({ id: "8", name: "报告 v2.pdf", size: 3 }),
      contentType: "application/pdf",
      contentLength: 3,
      stream: new Blob([new Uint8Array([1, 2, 3])]).stream() as unknown as ReadableStream<Uint8Array>,
    });
  }

  // 业务意图：默认处置与 web 面逐字同形（下载），否则前端按同一份代码在两面写出不同行为。
  test("默认：字节流 + attachment 处置 + nosniff", async () => {
    stubDownload(harness);
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments/8`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition.startsWith("attachment;")).toBe(true);
    expect(disposition).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A%20v2.pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  // 业务意图：管理台的图片预览只能先取字节再展示（`<img src>` 带不上 Authorization），因此需要一条不强制下载的
  // 读取通道；字节、Content-Type 与安全头必须与下载完全一致，只有处置方式不同。
  test("inline：同一份字节、同一类型，处置改为 inline", async () => {
    stubDownload(harness);
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments/8?disposition=inline`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")?.startsWith("inline;")).toBe(true);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  // 业务意图：处置方式是闭集（响应头不得由请求传入任意字符串），非法取值在边界 400 且零上游调用。
  test("非法处置取值：400 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments/8?disposition=inline%0d%0aX-Evil:1`),
    );

    expect(response.status).toBe(400);
    expect(harness.git.calls).toEqual([]);
  });

  // 业务意图：附件编号不属于该工单（上游 404）与不存在同形 404，不给跨工单的附件编号留探测面。
  test("附件不属于该工单：404", async () => {
    harness.git.behaviour.downloadAttachment = async () => {
      throw new GitError("NOT_FOUND", "附件不存在", { status: 404 });
    };
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments/8`));

    expect(response.status).toBe(404);
  });

  // 业务意图：附件编号形状非法（非十进制串）在边界 400，不进入上游的归属判定。
  test("附件编号非十进制串：400 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments/0`));

    expect(response.status).toBe(400);
    expect(harness.git.calls).toEqual([]);
  });
});
