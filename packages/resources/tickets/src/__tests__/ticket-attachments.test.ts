import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitError } from "@fenix/git/server";
import { NotFoundError, ValidationError } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import { resetTicketsServerModule } from "../server/runtime";
import { sanitizeAttachmentName } from "../server/services/ticket-attachment-service";
import { TICKET_ATTACHMENT_MAX_BYTES } from "../server/services/ticket-limits";
import { TICKET_OPERATION_STEP } from "../server/services/ticket-operation-service";
import {
  BINDING_A,
  createTicketHarness,
  DATABASE_STUB,
  gitAttachment,
  IDEMPOTENCY_KEY,
  installTicketRoutes,
  ORG_A,
  ORG_B,
  PROJECT_A,
  stubDirectory,
  type TicketHarness,
  testActor,
} from "./ticket-harness";

/**
 * 附件路径的契约（T05：方案 §8 的附件路由、§9.7「附件创建不盲目重试」）。
 *
 * 三条只有附件才有的判据，每条都对应一类线上事故：
 * 1. 上游的 413/422（大小上限、扩展名白名单）是**确定拒绝**，必须落 `failed` 终态并给 400；把它当成未定
 *    会让一次从未发生的写入进恢复核对，用户则在「结果确认中」里等一个不存在的结论。
 * 2. 下载必须经本服务代理（上游内容地址带服务账号凭据），且**归属校验只有一处**：附件编号在该工单的
 *    元数据端点下读取，不属于此工单时上游直接 404。
 * 3. 上传成功后没有本地行可补，但账本必须落终态并带可核对的坐标（文件名 + 字节数）——恢复核对就靠它们。
 */

const AUTHOR = "user_creator";
const ISSUE_NUMBER = "1";
const FILE_BYTES = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
const FILE_NAME = "复现截图.png";

async function setup(): Promise<{
  readonly harness: TicketHarness;
  readonly author: ReturnType<typeof testActor>;
}> {
  // 同一份成员表喂 `users`（展示名投影）与 `membersOf`（成员关系）：生产里两者读同一张成员表，
  // 只声明一份才不会造出「成员存在但查不到展示名」的不可能状态。
  const members = [{ userId: AUTHOR, name: "张创建" }];
  stubDirectory({
    users: members.map((member) => ({ id: member.userId, name: member.name })),
    membersOf: { [ORG_A]: members },
  });
  const harness = createTicketHarness();
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, repositoryRef: BINDING_A });
  return { harness, author: testActor(AUTHOR, ORG_A, "member") };
}

/** 上传入参的公共部分；用例按需覆盖 `name` / `content`。 */
function uploadInput(
  overrides: Partial<Parameters<TicketHarness["services"]["attachments"]["uploadAttachment"]>[0]> = {},
) {
  return {
    organizationId: ORG_A,
    projectId: PROJECT_A,
    bindingId: BINDING_A,
    issueNumber: ISSUE_NUMBER,
    actorId: AUTHOR,
    name: FILE_NAME,
    content: FILE_BYTES,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

beforeEach(() => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
});

afterEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
});

describe("附件领域服务", () => {
  // 上传成功后必须落账本终态：附件没有本地行，账本行就是「这次上传发生过」的唯一本端凭据。
  test("上传成功：远端收到文件、账本落 attachment_uploaded 与服务端归一后的文件名", async () => {
    const { harness } = await setup();
    harness.git.behaviour.uploadAttachment = async (_issueNumber, input) =>
      gitAttachment({ id: "8", name: input.name, size: input.content.byteLength });

    const outcome = await harness.services.attachments.uploadAttachment(uploadInput());

    expect(outcome).toMatchObject({ kind: "written" });
    const call = harness.git.ops("attachments.upload")[0];
    if (call?.op !== "attachments.upload") throw new Error("Git 替身未记录 attachments.upload");
    expect(call.issueNumber).toBe(ISSUE_NUMBER);
    expect(call.input.name).toBe(FILE_NAME);
    expect(call.input.content).toEqual(FILE_BYTES);
    const row = harness.operationStore.rows[0];
    expect(row?.kind).toBe("attachment.upload");
    expect(row?.status).toBe("succeeded");
    expect(row?.step).toBe(TICKET_OPERATION_STEP.attachmentUploaded);
    expect(row?.targetId).toBe("8");
    expect(row?.result).toMatchObject({ attachmentId: "8", name: FILE_NAME, size: FILE_BYTES.byteLength });
  });

  // 文件名是客户端输入：目录分隔符必须被剥掉（它同时进上游的 ?name= 与下载响应的响应头）。
  test("文件名归一：带目录分隔符的 filename 只保留基名", async () => {
    expect(sanitizeAttachmentName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeAttachmentName("C:\\Users\\a\\报告.pdf")).toBe("报告.pdf");
    // 控制字符（含 CR/LF）一律清除：它们是响应头注入的唯一载体。
    expect(sanitizeAttachmentName("a\r\nb.png")).toBe("ab.png");
    expect(() => sanitizeAttachmentName("   ")).toThrow(ValidationError);
  });

  // 大小上限必须在读入之后、发请求之前把关：超限时一次上游调用都不该发生（也就不会烧掉幂等键）。
  test("超过大小上限：直接 400 且不产生任何上游调用", async () => {
    const { harness } = await setup();
    harness.git.behaviour.uploadAttachment = async () => gitAttachment();
    const oversized = new Uint8Array(TICKET_ATTACHMENT_MAX_BYTES + 1);

    await expect(harness.services.attachments.uploadAttachment(uploadInput({ content: oversized }))).rejects.toThrow(
      ValidationError,
    );
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 空内容不落库：文件选择器选不出 0 字节文件，走到这里通常是 multipart 解析出了空 part。
  test("空内容：拒绝且不产生上游调用", async () => {
    const { harness } = await setup();
    await expect(
      harness.services.attachments.uploadAttachment(uploadInput({ content: new Uint8Array() })),
    ).rejects.toThrow(ValidationError);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 上游 422（扩展名白名单拒绝）是**确定**失败：账本落 failed + VALIDATION_ERROR，绝不能升级成未定。
  test("上游确定拒绝（422）：账本落 failed 并还原成同一个 400", async () => {
    const { harness } = await setup();
    harness.git.behaviour.uploadAttachment = async () => {
      throw new GitError("INVALID_REQUEST", "Forgejo 拒绝该附件：This file extension or type is not allowed");
    };

    await expect(harness.services.attachments.uploadAttachment(uploadInput({ name: "无扩展名" }))).rejects.toThrow(
      ValidationError,
    );
    const row = harness.operationStore.rows[0];
    expect(row?.status).toBe("failed");
    expect(row?.step).toBe(TICKET_OPERATION_STEP.upstreamFailed);
    expect(row?.result).toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    // 同键重放：不重发写入，还原同一个 400。
    harness.git.behaviour.uploadAttachment = async () => {
      throw new Error("重放不得再次调用远端");
    };
    await expect(harness.services.attachments.uploadAttachment(uploadInput({ name: "无扩展名" }))).rejects.toThrow(
      ValidationError,
    );
    expect(harness.git.writeCalls().length).toBe(1);
  });

  // 写请求超时属于「结果未定」：账本保持 uncertain + dispatching，由恢复核对回源认领（§9.7）。
  test("上游结果未定：账本落 uncertain 且 step 停在 dispatching", async () => {
    const { harness } = await setup();
    harness.git.behaviour.uploadAttachment = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };

    const outcome = await harness.services.attachments.uploadAttachment(uploadInput());

    expect(outcome).toMatchObject({ kind: "uncertain" });
    const row = harness.operationStore.rows[0];
    expect(row?.status).toBe("uncertain");
    expect(row?.step).toBe(TICKET_OPERATION_STEP.dispatching);
    // `intent` 保留可核对的坐标：远端没有身份头，恢复核对只认文件名与字节数。
    expect(row?.intent).toMatchObject({ name: FILE_NAME, size: FILE_BYTES.byteLength, issueNumber: ISSUE_NUMBER });
  });

  // 幂等键保护「重试不产生第二份」：同键同内容重放回原结果，同键不同内容 409。
  test("同键同内容重放返回原结果且不重发；同键不同内容 409", async () => {
    const { harness } = await setup();
    harness.git.behaviour.uploadAttachment = async (_issueNumber, input) =>
      gitAttachment({ id: "8", name: input.name, size: input.content.byteLength });

    const first = await harness.services.attachments.uploadAttachment(uploadInput());
    const replay = await harness.services.attachments.uploadAttachment(uploadInput());

    expect(first).toMatchObject({ kind: "written" });
    expect(replay).toMatchObject({ kind: "written" });
    expect(harness.git.writeCalls().length).toBe(1);
    await expect(
      harness.services.attachments.uploadAttachment(uploadInput({ content: new Uint8Array([1, 2, 3]) })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  // 列表回源托管平台：上游不可用必须 503 而不是空列表（空列表会让用户以为附件被删了）。
  test("列表：上游不可用返回 503，不退化成空列表", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.listAttachments = async () => {
      throw new GitError("UNAVAILABLE", "上游不可达");
    };

    await expect(harness.api.attachments.list(author, PROJECT_A, ISSUE_NUMBER)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  // 下载：归属由上游元数据端点判定，本端只做搬运；不属于该工单时上游 404 → 本端 404。
  test("下载：返回内容流；附件不属于该工单时 404", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.downloadAttachment = async () =>
      ({
        attachment: gitAttachment({ id: "8", name: FILE_NAME, size: FILE_BYTES.byteLength }),
        contentType: "image/png",
        contentLength: FILE_BYTES.byteLength,
        stream: new Response(FILE_BYTES).body,
      }) as Awaited<ReturnType<NonNullable<typeof harness.git.behaviour.downloadAttachment>>>;

    const download = await harness.api.attachments.download(author, PROJECT_A, ISSUE_NUMBER, "8");
    expect(download.contentType).toBe("image/png");
    expect(new Uint8Array(await new Response(download.stream).arrayBuffer())).toEqual(FILE_BYTES);

    harness.git.behaviour.downloadAttachment = async () => {
      throw new GitError("NOT_FOUND", "附件不存在");
    };
    await expect(harness.api.attachments.download(author, PROJECT_A, ISSUE_NUMBER, "9")).rejects.toThrow(NotFoundError);
  });

  // 跨组织与不存在同形：附件路径的授权入口是项目可见性，不能让调用方从状态码里探出别的组织有没有这个工单。
  test("跨组织：项目不可见时列表与上传都 404 且零上游调用", async () => {
    const { harness } = await setup();
    const outsider = testActor("user_other", ORG_B, "member");

    await expect(harness.api.attachments.list(outsider, PROJECT_A, ISSUE_NUMBER)).rejects.toThrow(NotFoundError);
    await expect(
      harness.api.attachments.upload(
        outsider,
        PROJECT_A,
        ISSUE_NUMBER,
        { name: FILE_NAME, content: FILE_BYTES },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(NotFoundError);
    expect(harness.git.calls).toEqual([]);
  });

  // 项目暂停：附件写入同样被暂停闸门拦下（读仍可用），且不产生任何上游调用。
  test("项目暂停：上传 503 且零上游调用", async () => {
    const { harness, author } = await setup();
    // 替身 store 的 seed 是追加而非覆盖，同一 id 再 seed 不会改变被读中的那一行，必须走仓储的状态写入口。
    await harness.projectStore.repository.setStatus({
      organizationId: ORG_A,
      projectId: PROJECT_A,
      status: "paused",
    });

    await expect(
      harness.api.attachments.upload(
        author,
        PROJECT_A,
        ISSUE_NUMBER,
        { name: FILE_NAME, content: FILE_BYTES },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toMatchObject({ code: "TICKETS_PAUSED" });
    expect(harness.git.writeCalls()).toEqual([]);
  });
});

describe("附件恢复核对", () => {
  // 远端已有同名同大小的附件 → 认领这次上传为成功（无本地行要补，终态即账本）。
  test("唯一匹配：核对把未定的上传补成 succeeded", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.uploadAttachment = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };
    const outcome = await harness.services.attachments.uploadAttachment(uploadInput());
    if (outcome.kind !== "uncertain") throw new Error("用例前置：上传应处于未定态");

    harness.git.behaviour.listAttachments = async () => [
      gitAttachment({ id: "9", name: "别的文件.txt", size: 3 }),
      gitAttachment({ id: "8", name: FILE_NAME, size: FILE_BYTES.byteLength }),
    ];
    const reconciled = await harness.services.recovery.reconcile({
      organizationId: ORG_A,
      actorId: author.userId,
      operationId: outcome.operationId,
    });

    expect(reconciled.kind).toBe("settled");
    expect(reconciled.operation.status).toBe("succeeded");
    expect(reconciled.operation.targetId).toBe("8");
    expect(reconciled.operation.step).toBe(TICKET_OPERATION_STEP.attachmentUploaded);
  });

  // 两条同名同大小 → 无法指认哪一条是本次结果：交人工核对，绝不猜一个 ID 当作成功。
  test("多条匹配：核对判为多义并转入 needs_review", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.uploadAttachment = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };
    const outcome = await harness.services.attachments.uploadAttachment(uploadInput());
    if (outcome.kind !== "uncertain") throw new Error("用例前置：上传应处于未定态");

    const sameNameSize = { name: FILE_NAME, size: FILE_BYTES.byteLength };
    harness.git.behaviour.listAttachments = async () => [
      gitAttachment({ id: "8", ...sameNameSize }),
      gitAttachment({ id: "9", ...sameNameSize }),
    ];
    const reconciled = await harness.services.recovery.reconcile({
      organizationId: ORG_A,
      actorId: author.userId,
      operationId: outcome.operationId,
    });

    expect(reconciled.kind).toBe("needs_review");
    expect(reconciled.operation.status).toBe("needs_review");
  });

  // 远端还没有这条附件：保持原状态（可能仍在存储或请求在途），绝不凭「暂时没有」判定失败。
  test("零匹配：保持未定状态而不是判失败", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.uploadAttachment = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };
    const outcome = await harness.services.attachments.uploadAttachment(uploadInput());
    if (outcome.kind !== "uncertain") throw new Error("用例前置：上传应处于未定态");

    harness.git.behaviour.listAttachments = async () => [gitAttachment({ id: "7", name: "无关.txt", size: 1 })];
    // 替身账本行的创建时间取自固定 fixture 时刻，已滑出 15 分钟核对窗口（`overWindow`），
    // 会把「窗口内零匹配」误推进 `needs_review`。本用例要验的是窗口内行为，把行挪到当下。
    const row = harness.operationStore.rows.find((candidate) => candidate.id === outcome.operationId);
    if (row === undefined) throw new Error("用例前置：账本行应存在");
    row.createdAt = new Date();

    const reconciled = await harness.services.recovery.reconcile({
      organizationId: ORG_A,
      actorId: author.userId,
      operationId: outcome.operationId,
    });

    expect(reconciled.kind).toBe("unchanged");
    expect(reconciled.operation.status).toBe("uncertain");
  });
});

describe("附件路由", () => {
  // 上传走 multipart：字段名 file，文件名取自 part 的 filename，成功返回 201 与附件视图。
  test("POST 上传：multipart 文件字段 → 201 与附件视图", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.uploadAttachment = async (_issueNumber, input) =>
      gitAttachment({ id: "8", name: input.name, size: input.content.byteLength });
    const app = new Elysia().use(installTicketRoutes(harness, author));

    const form = new FormData();
    form.append("file", new Blob([FILE_BYTES], { type: "image/png" }), FILE_NAME);
    const response = await app.handle(
      new Request(`http://localhost/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`, {
        method: "POST",
        headers: { "idempotency-key": IDEMPOTENCY_KEY },
        body: form,
      }),
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      success: boolean;
      data: { attachment: Record<string, unknown>; operationId: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.data.attachment).toMatchObject({ attachmentId: "8", name: FILE_NAME, size: FILE_BYTES.byteLength });
    // 响应里绝不出现上游的下载地址与 uuid：它们带服务账号凭据（或指向 API 前缀之外的路径）。
    expect(JSON.stringify(payload.data.attachment)).not.toContain("browser_download_url");
  });

  // 缺失幂等键必须在读表单之前拒绝：这类请求连文件都不必解析，更不该产生账本行。
  test("POST 上传：缺 Idempotency-Key 返回 400 且零写入", async () => {
    const { harness, author } = await setup();
    const app = new Elysia().use(installTicketRoutes(harness, author));

    const form = new FormData();
    form.append("file", new Blob([FILE_BYTES]), FILE_NAME);
    const response = await app.handle(
      new Request(`http://localhost/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`, { method: "POST", body: form }),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 一次请求只能带一个文件：多部件必须拆成多请求（一次远端写入对应一个幂等键）。
  test("POST 上传：一次两个文件返回 400 且零写入", async () => {
    const { harness, author } = await setup();
    const app = new Elysia().use(installTicketRoutes(harness, author));

    const form = new FormData();
    form.append("file", new Blob([FILE_BYTES]), "a.txt");
    form.append("file", new Blob([FILE_BYTES]), "b.txt");
    const response = await app.handle(
      new Request(`http://localhost/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`, {
        method: "POST",
        headers: { "idempotency-key": IDEMPOTENCY_KEY },
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 列表是 `/web` 信封：附件数与字段名固定，前端据此渲染（地址由前端按 attachmentId 拼）。
  test("GET 列表：返回 200 信封与附件数组", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.listAttachments = async () => [
      gitAttachment({ id: "8", name: FILE_NAME, size: FILE_BYTES.byteLength }),
    ];
    const app = new Elysia().use(installTicketRoutes(harness, author));

    const response = await app.handle(new Request(`http://localhost/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments`));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: { items: readonly Record<string, unknown>[] } };
    expect(payload.data.items).toEqual([
      { attachmentId: "8", name: FILE_NAME, size: FILE_BYTES.byteLength, createdAt: null },
    ]);
  });

  // 下载是字节流：内容原样透传 + Content-Disposition（中文名走 RFC 5987 与 ASCII 回退两个值）。
  test("GET 下载：透传字节流并给出 Content-Disposition", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.downloadAttachment = async () => ({
      attachment: gitAttachment({ id: "8", name: FILE_NAME, size: FILE_BYTES.byteLength }),
      contentType: "image/png",
      contentLength: FILE_BYTES.byteLength,
      stream: new Response(FILE_BYTES).body as ReadableStream<Uint8Array>,
    });
    const app = new Elysia().use(installTicketRoutes(harness, author));

    const response = await app.handle(
      new Request(`http://localhost/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments/8`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES);
  });

  // 附件编号不是数字是协议错误（400），与「附件不存在或不属于该工单」（404）必须区分开。
  // 400 而非裸 Elysia 的 422：校验失败由宿主 error-handler 统一改写成 `VALIDATION_ERROR`，
  // 替身 app 挂了等价映射（见 `installTicketRoutes`），断言的是线上真实状态码。
  test("GET 下载：非数字附件编号返回 400", async () => {
    const { harness, author } = await setup();
    const app = new Elysia().use(installTicketRoutes(harness, author));

    const response = await app.handle(
      new Request(`http://localhost/tickets/${PROJECT_A}/${ISSUE_NUMBER}/attachments/abc`),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { type: string } };
    expect(payload.error.type).toBe("VALIDATION_ERROR");
    expect(harness.git.calls).toEqual([]);
  });
});
