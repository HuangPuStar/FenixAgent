import { describe, expect, test } from "bun:test";

import {
  applySchemaMarker,
  canonicalize,
  findValuePaths,
  inspectConsoleEnvelope,
  inspectEnvelope,
  judgeBffFailure,
  judgeConsoleSuccess,
  judgeIndistinguishable,
  judgeUpstreamSuccess,
  readNodeTitle,
  redactConsoleSecrets,
  resolveConfig,
  toEvidence,
} from "../workflow-v2/lib/e2e-logic";

describe("resolveConfig", () => {
  // 只给 cookie 时不要求账号密码：浏览器里复制会话是最短的可用路径。
  test("accepts a session cookie without account credentials", () => {
    const resolution = resolveConfig({ WORKFLOW_V2_E2E_SESSION_COOKIE: "better-auth.session_token=abc" });
    expect(resolution.fatal).toHaveLength(0);
    expect(resolution.config.sessionCookie).toBe("better-auth.session_token=abc");
    expect(resolution.config.baseUrl).toBe("http://127.0.0.1:3000");
  });

  // 缺凭据必须在开跑前就判定：带着半个配置去发请求只会得到一串 401，掩盖真正原因。
  test("reports the missing variable names when no session source is given", () => {
    const resolution = resolveConfig({});
    expect(resolution.fatal).toHaveLength(1);
    expect(resolution.fatal[0]?.variables).toEqual([
      "WORKFLOW_V2_E2E_SESSION_COOKIE",
      "WORKFLOW_V2_E2E_EMAIL",
      "WORKFLOW_V2_E2E_PASSWORD",
    ]);
  });

  // 提示与报告只带变量名、不带值：报告会被贴进工单与聊天记录，密码绝不能顺路流出去。
  test("never puts credentials into the reported hints or notes", () => {
    const resolution = resolveConfig({
      WORKFLOW_V2_E2E_EMAIL: "ops@example.com",
      WORKFLOW_V2_E2E_PASSWORD: "s3cret-value",
    });
    const serialized = JSON.stringify({
      fatal: resolution.fatal,
      crossTenant: resolution.crossTenant,
      notes: resolution.notes,
    });
    expect(serialized).not.toContain("s3cret-value");
  });

  // 给了邮箱却没给密码是常见的手滑：这里要点名缺的那一枚，而不是笼统说「缺会话」。
  test("separates a missing password from a missing session source", () => {
    const resolution = resolveConfig({ WORKFLOW_V2_E2E_EMAIL: "ops@example.com" });
    expect(resolution.fatal).toHaveLength(1);
    expect(resolution.fatal[0]?.variables).toEqual(["WORKFLOW_V2_E2E_PASSWORD"]);
    expect(resolution.fatal[0]?.hint).toContain("WORKFLOW_V2_E2E_SESSION_COOKIE");
  });

  // 有会话 cookie 时账号密码是多余的：不该因为「邮箱没配密码」把一次可跑的运行拦下来。
  test("does not demand a password when a session cookie is present", () => {
    const resolution = resolveConfig({
      WORKFLOW_V2_E2E_EMAIL: "ops@example.com",
      WORKFLOW_V2_E2E_SESSION_COOKIE: "x=1",
    });
    expect(resolution.fatal).toHaveLength(0);
    expect(resolution.notes[0]).toContain("会话 cookie");
  });

  // 判据 C 的对照数据缺失不算致命：判据 A/B 仍然要跑，只是退出码非 0。
  test("treats the cross-tenant control as non-fatal but non-empty", () => {
    const resolution = resolveConfig({ WORKFLOW_V2_E2E_SESSION_COOKIE: "x=1" });
    expect(resolution.crossTenant).toHaveLength(1);
    expect(resolution.crossTenant[0]?.variables).toContain("WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID");
    const withForeign = resolveConfig({
      WORKFLOW_V2_E2E_SESSION_COOKIE: "x=1",
      WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID: "7601",
    });
    expect(withForeign.crossTenant).toHaveLength(0);
  });

  // 空白值等同于未设置：把 " " 当成配置会让脚本带着空基址去发请求。
  test("treats blank values as absent and trims the base url", () => {
    const resolution = resolveConfig({ WORKFLOW_V2_E2E_BASE_URL: "http://example.com/  ", WORKFLOW_V2_E2E_EMAIL: " " });
    expect(resolution.config.baseUrl).toBe("http://example.com");
    expect(resolution.config.email).toBeNull();
    expect(resolution.fatal).toHaveLength(1);
  });

  // 开关只认 0/false 为关闭：其余写法（含垃圾值）一律保持默认，避免误关自动绑定。
  test("parses boolean flags with 0/false as the only off values", () => {
    expect(resolveConfig({ WORKFLOW_V2_E2E_AUTO_BIND: "0" }).config.autoBind).toBe(false);
    expect(resolveConfig({ WORKFLOW_V2_E2E_AUTO_BIND: "false" }).config.autoBind).toBe(false);
    expect(resolveConfig({ WORKFLOW_V2_E2E_AUTO_BIND: "maybe" }).config.autoBind).toBe(true);
    expect(resolveConfig({ WORKFLOW_V2_E2E_KEEP_RESOURCES: "1" }).config.keepResources).toBe(true);
  });
});

describe("inspectEnvelope", () => {
  // 判读必须先能区分「上游信封」与「控制台信封」：两条面的成功判据不同，混判会给出假 PASS。
  test("distinguishes the 上游 envelope from the console envelope", () => {
    expect(inspectEnvelope({ code: 0, msg: "success", data: {} }).hasEnvelope).toBe(true);
    expect(inspectEnvelope({ success: true, data: {} }).hasEnvelope).toBe(false);
    expect(inspectEnvelope({ code: "0", msg: "success" }).hasEnvelope).toBe(false);
    expect(inspectEnvelope([{ code: 0 }]).hasEnvelope).toBe(false);
    expect(inspectEnvelope(null).keys).toEqual([]);
  });

  // `list_spans` 是裸对象（无 code/data），顶层键要如实带出来供人工比对。
  test("reports top-level keys for non-envelope payloads", () => {
    const inspection = inspectEnvelope({ spans: [], extra: 1 });
    expect(inspection.hasEnvelope).toBe(false);
    expect(inspection.keys).toEqual(["extra", "spans"]);
    expect(inspection.hasData).toBe(false);
  });

  // `msg` 与 `message` 必须各自原样带出、不合并：judgeBffFailure 的逐字比较只认 `msg`，合并会把它悄悄放宽。
  test("keeps msg and message as separate raw fields", () => {
    const byMsg = inspectEnvelope({ code: 0, msg: "success", data: {} });
    expect(byMsg.msg).toBe("success");
    expect(byMsg.message).toBeNull();
    const byMessage = inspectEnvelope({ code: 0, message: "success", data: {} });
    expect(byMessage.msg).toBeNull();
    expect(byMessage.message).toBe("success");
  });
});

describe("judgeUpstreamSuccess", () => {
  // 成功面必须同时满足 HTTP、业务码与 msg 三项：任一项缺失都是口径漂移，不能算过。
  test("requires http 2xx, code 0 and a message", () => {
    expect(judgeUpstreamSuccess(200, { code: 0, msg: "success", data: {} }).ok).toBe(true);
    expect(judgeUpstreamSuccess(200, { code: 0, data: {} }).ok).toBe(false);
    expect(judgeUpstreamSuccess(200, { code: 777777775, msg: "panic" }).ok).toBe(false);
    expect(judgeUpstreamSuccess(400, { code: 0, msg: "success" }).ok).toBe(false);
    expect(judgeUpstreamSuccess(null, undefined).ok).toBe(false);
  });

  // 每个失败面都要带下一步动作：没有建议的 FAIL 等于让使用者自己猜。
  test("carries an actionable suggestion per failure face", () => {
    expect(judgeUpstreamSuccess(null, undefined).suggestion).toContain("bun run dev");
    expect(judgeUpstreamSuccess(401, { code: 401, msg: "ticket_invalid" }).suggestion).toContain("会话");
    expect(judgeUpstreamSuccess(200, { success: true, data: {} }).suggestion).toContain("不是上游信封");
  });

  // HTTP 200 + 业务码 401 是画布换票链路的陷阱：它必须判失败（真实 401 才是换票信号）。
  test("fails http 200 responses that only carry a business-level 401", () => {
    const judged = judgeUpstreamSuccess(200, { code: 401, msg: "ticket_invalid" });
    expect(judged.ok).toBe(false);
    expect(judged.actual).toContain("code=401");
  });

  // `workflow_detail` 的原生成功信封是 `{code, data, message}`：文案装在 `message` 里也必须判过。
  test("accepts the message key as the upstream success carrier", () => {
    expect(judgeUpstreamSuccess(200, { code: 0, data: {}, message: "" }).ok).toBe(true);
    expect(judgeUpstreamSuccess(200, { code: 0, data: {}, message: "success" }).ok).toBe(true);
  });

  // `msg` 显式为 null 且没有 `message`：文案缺失就是口径漂移，不能因为「有 code=0」放行。
  test("fails when msg is null and message is absent", () => {
    expect(judgeUpstreamSuccess(200, { code: 0, data: {}, msg: null }).ok).toBe(false);
  });

  // 两个文案键都在但都是 null：同样是缺文案，仍判失败（回退不等于「随便有个键就算数」）。
  test("fails when both msg and message are null", () => {
    expect(judgeUpstreamSuccess(200, { code: 0, data: {}, msg: null, message: null }).ok).toBe(false);
  });

  // 既有形状行为不变：空串沿用原语义放行，非空串照常通过（回退不得改变 `msg` 分支的判读）。
  test("keeps the existing msg-only shapes unchanged", () => {
    expect(judgeUpstreamSuccess(200, { code: 0, msg: "", data: {} }).ok).toBe(true);
    expect(judgeUpstreamSuccess(200, { code: 0, msg: "ok" }).ok).toBe(true);
  });

  // 业务码非 0 时任何文案形状都不放行：成败由 code 定，与文案装在哪个键无关。
  test("fails any shape whose business code is not 0", () => {
    expect(judgeUpstreamSuccess(200, { code: 777777775, msg: "panic" }).ok).toBe(false);
    expect(judgeUpstreamSuccess(200, { code: 777777775, message: "panic" }).ok).toBe(false);
    expect(judgeUpstreamSuccess(200, { code: 401, message: "ticket_invalid" }).ok).toBe(false);
    expect(judgeUpstreamSuccess(200, { code: 720701013, msg: "run failed", message: "run failed" }).ok).toBe(false);
  });
});

describe("judgeBffFailure", () => {
  // 失败信封要求 HTTP 状态与业务码逐字一致：不一致说明失败不是本面产生的（上游被原样透传了）。
  test("requires the http status and the envelope code to match", () => {
    expect(judgeBffFailure(404, { code: 404, msg: "not_found" }, { status: 404, msg: "not_found" }).ok).toBe(true);
    expect(judgeBffFailure(404, { code: 0, msg: "success" }, { status: 404, msg: "not_found" }).ok).toBe(false);
    expect(judgeBffFailure(200, { code: 404, msg: "not_found" }, { status: 404, msg: "not_found" }).ok).toBe(false);
  });

  // msg 也是判据的一部分：跨租户 404 与「不存在」404 的文案不同就是存在性泄漏。
  test("treats a different message as a failure", () => {
    const judged = judgeBffFailure(
      404,
      { code: 404, msg: "forbidden_other_tenant" },
      { status: 404, msg: "not_found" },
    );
    expect(judged.ok).toBe(false);
    expect(judged.suggestion).toContain("文案");
  });
});

describe("judgeConsoleSuccess", () => {
  // 控制台面走 `{success,data}`：画布面的判读函数不能拿来复用，这里锁住两者的边界。
  test("accepts only the console envelope shape", () => {
    expect(judgeConsoleSuccess(200, { success: true, data: { appId: "1" } }).ok).toBe(true);
    expect(judgeConsoleSuccess(200, { code: 0, msg: "success", data: {} }).ok).toBe(false);
    expect(
      inspectConsoleEnvelope({ success: false, error: { code: "TENANT_NOT_BOUND", message: "未绑定" } }).errorCode,
    ).toBe("TENANT_NOT_BOUND");
  });

  // 未绑定是画布链路最常见的拦路状态，必须给出「怎么绑」而不是泛泛的上游错误。
  test("maps the not-bound error to a binding suggestion", () => {
    const judged = judgeConsoleSuccess(409, { success: false, error: { code: "TENANT_NOT_BOUND", message: "未绑定" } });
    expect(judged.ok).toBe(false);
    expect(judged.suggestion).toContain("POST /web/workflow-v2/org-app");
  });
});

describe("findValuePaths", () => {
  // 伪造值扫描是判据 B 的核心证据面：必须能穿透 data/workflow/数组，并且报出命中位置。
  test("reports the json path of every echoed needle", () => {
    const response = { code: 0, data: { workflow: { project_id: "real-1", name: "forged-project-x" } }, list: ["ok"] };
    expect(findValuePaths(response, ["forged-project-x"])).toEqual(["data.workflow.name=forged-project-x"]);
    expect(findValuePaths(response, ["real-1"])).toEqual(["data.workflow.project_id=real-1"]);
  });

  // 数组下标也要出现在路径里：命中在数组元素上时，光有键名无法定位。
  test("includes array indexes in the reported path", () => {
    expect(findValuePaths({ data: [{ project_id: "forged-1" }] }, ["forged-1"])).toEqual([
      "data[0].project_id=forged-1",
    ]);
  });

  // 全部未出现时返回空数组（判据 B 的 PASS 条件），并且不把 null/数字误判成命中。
  test("returns an empty list when nothing matches", () => {
    expect(findValuePaths({ code: 0, data: { project_id: "123" } }, ["forged-space", "forged-project"])).toEqual([]);
    expect(findValuePaths(null, ["forged"])).toEqual([]);
  });
});

describe("judgeIndistinguishable", () => {
  // 不泄漏存在性的判据是「逐字相同」，而不是「都是 404」。
  test("compares canonicalized bodies so key order does not matter", () => {
    expect(
      judgeIndistinguishable(
        { code: 404, msg: "not_found" },
        { msg: "not_found", code: 404 },
        { left: "a", right: "b" },
      ).ok,
    ).toBe(true);
    const leaked = judgeIndistinguishable(
      { code: 404, msg: "not_found" },
      { code: 404, msg: "not_found_other_tenant" },
      { left: "a", right: "b" },
    );
    expect(leaked.ok).toBe(false);
    expect(leaked.actual).toContain("not_found_other_tenant");
  });
});

describe("applySchemaMarker / readNodeTitle", () => {
  const schema = JSON.stringify({
    nodes: [
      { id: "node-1", type: "1", data: { nodeMeta: { title: "开始", icon: "x" } } },
      { id: "node-2", type: "2", data: {} },
    ],
    edges: [],
  });

  // 编辑必须落在能回读到的字段上（标题），否则「保存成功」证明不了任何事。
  test("appends the marker to the first editable node title", () => {
    const edit = applySchemaMarker(schema, " (e2e-ab12)");
    expect(edit.nodeId).toBe("node-1");
    expect(edit.before).toBe("开始");
    expect(edit.after).toBe("开始 (e2e-ab12)");
    expect(readNodeTitle(edit.schema, "node-1")).toBe("开始 (e2e-ab12)");
    // 只动被选中的那个节点：其它节点的内容必须逐字保持。
    expect(readNodeTitle(edit.schema, "node-2")).toBeNull();
  });

  // 无节点/非 JSON 时必须原样返回并给出原因，由调用方判失败——不能悄悄返回「改过了」。
  test("returns the input unchanged with a reason when nothing is editable", () => {
    const broken = applySchemaMarker("not-json", " (x)");
    expect(broken.nodeId).toBeNull();
    expect(broken.schema).toBe("not-json");
    expect(broken.detail).toContain("不是合法 JSON");

    const empty = applySchemaMarker(JSON.stringify({ nodes: [{ id: "n", type: "1" }] }), " (x)");
    expect(empty.nodeId).toBeNull();
    expect(empty.detail).toContain("无法编辑");
  });

  // 回读失败（节点不存在、schema 不合法）一律 null：调用方据此判 FAIL，而不是把 undefined 当成功。
  test("readNodeTitle returns null for missing nodes and malformed schema", () => {
    expect(readNodeTitle(schema, "node-missing")).toBeNull();
    expect(readNodeTitle("not-json", "node-1")).toBeNull();
    expect(readNodeTitle(JSON.stringify({ nodes: [] }), "node-1")).toBeNull();
  });
});

describe("redaction", () => {
  // 控制台会话与画布票据是两套独立凭据域，掩码必须各自覆盖，不能只靠上游侧规则。
  test("masks console cookies and canvas tickets in inline text", () => {
    const masked = redactConsoleSecrets(
      "Cookie: better-auth.session_token=secret-value; X-Fenix-Workflow-Ticket: abcdef123456",
    );
    expect(masked).not.toContain("secret-value");
    expect(masked).not.toContain("abcdef123456");
    expect(masked).toContain("better-auth.session_token=<redacted>");
  });

  // 证据文本先脱敏后截断：顺序反了会把截断点之后的凭据原样留下。
  test("redacts before truncating evidence", () => {
    const evidence = toEvidence(
      { ticket: "ticket-value", url: "http://upstream/api?sign=abc", note: "x".repeat(500) },
      100,
    );
    expect(evidence).not.toContain("ticket-value");
    expect(evidence).not.toContain("sign=abc");
    expect(evidence.length).toBeLessThanOrEqual(120);
    expect(evidence).toContain("<truncated>");
  });

  // 探针已有的口径（session_key 与签名 URL 查询串）必须继续生效：两条链路共用同一份脱敏。
  test("keeps the probe redaction rules for upstream-side values", () => {
    const masked = toEvidence("Cookie: session_key=abc123; url=https://minio/opencoze/a.png?X-Amz-Signature=zzz");
    expect(masked).not.toContain("abc123");
    expect(masked).not.toContain("X-Amz-Signature=zzz");
  });
});

describe("canonicalize", () => {
  // 规范化只影响键序，不改内容：同形比较据此避免键序造成的假失败。
  test("sorts object keys recursively without changing values", () => {
    expect(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] })).toEqual({ a: [{ c: 3, d: 2 }], b: 1 });
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize("x")).toBe("x");
  });
});
