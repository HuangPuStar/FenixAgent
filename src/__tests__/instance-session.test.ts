// ── instance-session.ts 确定性实例会话 ID 生成/解析验证 ──
// agent_session 表废弃后，实例会话标识改为确定性生成（ses_inst_{environmentId}_{instanceNumber}），
// 前端透传后由 YJS WS 连接解析回实例编号（多实例 doc 隔离），控制台路由用解析结果做
// 环境归属校验（解析失败保守拒绝）。本文件覆盖生成/解析的 round-trip 与异常输入。
import { describe, expect, test } from "bun:test";
import { createInstanceSessionId, parseInstanceSessionId } from "../services/instance-session";

describe("createInstanceSessionId", () => {
  // 同一环境 + 同一实例编号始终得到相同 ID（确定性，刷新后仍可解析）
  test("produces deterministic id for same environment and instance number", () => {
    const a = createInstanceSessionId("env_abc", 3);
    const b = createInstanceSessionId("env_abc", 3);
    expect(a).toBe(b);
    expect(a).toBe("ses_inst_env_abc_3");
  });

  // 不同实例编号生成不同 ID，保证多实例 YJS doc 隔离
  test("different instance numbers produce different ids", () => {
    expect(createInstanceSessionId("env_abc", 1)).not.toBe(createInstanceSessionId("env_abc", 2));
  });
});

describe("parseInstanceSessionId", () => {
  // round-trip：生成后再解析可还原环境与实例编号
  test("round-trips with createInstanceSessionId", () => {
    const sessionId = createInstanceSessionId("env_abc", 5);
    expect(parseInstanceSessionId(sessionId)).toEqual({ environmentId: "env_abc", instanceNumber: 5 });
  });

  // environmentId 可能包含下划线（贪婪匹配最后一个 _数字 后缀），不能误切
  test("parses environment ids containing underscores", () => {
    const sessionId = "ses_inst_env_ab_cd_7";
    expect(parseInstanceSessionId(sessionId)).toEqual({ environmentId: "env_ab_cd", instanceNumber: 7 });
  });

  // 非 ses_inst_ 前缀（历史 session_* 或伪造标识）一律拒绝
  test("rejects ids without the ses_inst_ prefix", () => {
    expect(parseInstanceSessionId("session_env_abc_1")).toBeNull();
    expect(parseInstanceSessionId("ses_instx_env_abc_1")).toBeNull();
  });

  // 缺少实例编号后缀（不以 _数字 结尾）无法解析，调用方应保守拒绝
  test("rejects ids without a trailing instance number", () => {
    expect(parseInstanceSessionId("ses_inst_env_abc")).toBeNull();
    expect(parseInstanceSessionId("ses_inst_")).toBeNull();
  });

  // 负数编号不在协议内，返回 null 而非解析出非法编号
  test("rejects negative instance numbers", () => {
    expect(parseInstanceSessionId("ses_inst_env_abc_-5")).toBeNull();
  });

  // 前导零编号按数值解析（parseInt 语义），与生成端整数编号一致
  test("parses zero-padded instance numbers as numbers", () => {
    expect(parseInstanceSessionId("ses_inst_env_abc_007")).toEqual({ environmentId: "env_abc", instanceNumber: 7 });
  });
});
