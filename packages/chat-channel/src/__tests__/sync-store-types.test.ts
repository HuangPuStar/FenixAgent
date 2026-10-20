// packages/chat-channel/src/__tests__/sync-store-types.test.ts
// 投影存储契约的静态守护：只断言类型与常量，不涉及任何存储行为。
//
// 目的：`ProjectionStore` 是 B 阶段内存 adapter 与接线阶段数据库 adapter 的共同基线，方法名、
// 参数个数或 `CommitOutcome` 取值漂移都会静默破坏另一实现；这里用「常量清单 + `satisfies` 桩 +
// 运行时集合比较」把双向包含关系钉死，使漂移在编译期或本测试中立刻暴露。

import { describe, expect, test } from "bun:test";
import {
  type AppendUpdatesInput,
  type AppendUpdatesResult,
  COMMIT_OUTCOMES,
  type CommitGenerationInput,
  type CommitGenerationResult,
  type CommitOutcome,
  type CreateDocInput,
  type CreateGenerationInput,
  type DirectoryPage,
  type DirectoryQuery,
  type DocStateSnapshot,
  type ProjectionStore,
  type PutSealedInput,
  type PutSealedResult,
  type RefQuery,
  type RegisterSuccessorInput,
  type RegistrationResult,
  type RetireResult,
  type RetireTarget,
  type SealDocInput,
  type SealDocResult,
  type SyncGenerationRecord,
  type SyncRefRecord,
  type SyncScopeRow,
  type SyncUpdateRecord,
  type WriterLease,
} from "../sync/store/types";

/** 接口方法名（编译期来源）。 */
type ProjectionStoreMethodName = keyof ProjectionStore;

/**
 * 冻结的方法名清单，与规格 §3.7 的 `ProjectionStore` 方法列表逐字同序。
 *
 * `satisfies readonly ProjectionStoreMethodName[]` 保证「清单 → 接口」方向：清单里出现非方法名即编译失败；
 * 反向由 `stub` 必须实现全部接口方法 + 运行时集合比较保证。
 */
const PROJECTION_STORE_METHODS = [
  "acquireWriter",
  "renewWriter",
  "createGeneration",
  "createDoc",
  "registerSuccessor",
  "appendUpdates",
  "putSealedIfAbsent",
  "sealDoc",
  "commitGeneration",
  "readDocStateAt",
  "readUpdatesAfter",
  "readScopePointer",
  "readGeneration",
  "readDirectory",
  "locateRefs",
  "retireAndCollect",
] as const satisfies readonly ProjectionStoreMethodName[];

/**
 * 每个方法的参数个数（原语签名的一部分：漏登记参数会让接线期传错实参）。
 *
 * `Record<ProjectionStoreMethodName, number>` 要求接口方法全部在此登记；接口新增方法却不登记即编译失败。
 */
const METHOD_ARITIES: Record<ProjectionStoreMethodName, number> = {
  acquireWriter: 3,
  renewWriter: 2,
  createGeneration: 1,
  createDoc: 1,
  registerSuccessor: 1,
  appendUpdates: 1,
  putSealedIfAbsent: 1,
  sealDoc: 1,
  commitGeneration: 1,
  readDocStateAt: 2,
  readUpdatesAfter: 3,
  readScopePointer: 1,
  readGeneration: 2,
  readDirectory: 1,
  locateRefs: 1,
  retireAndCollect: 2,
};

/**
 * 四值判定表在测试侧的镜像：`Record<CommitOutcome, string>` 要求每个取值都被登记，
 * `CommitOutcome` 新增取值而不在此分类即编译失败。
 */
const OUTCOME_HANDLING: Record<CommitOutcome, string> = {
  committed: "首次落地：推进",
  "already-committed": "同键已提交：按已提交事实继续",
  conflict: "同键异内容或预期不匹配：重读已提交边界",
  unknown: "结果未知：同键重试或读取已提交边界确认，不得推断任何一种结局",
};

/** 桩方法统一出口：契约测试不执行存储行为，调用即失败，避免被误当作可用实现。 */
function stubCall(method: string, ...args: unknown[]): never {
  throw new Error(`ProjectionStore stub does not implement ${method} (${String(args.length)} args)`);
}

/**
 * 最小内存桩：只为证明接口可被实现、方法名与参数个数不漂移，不含任何业务语义。
 *
 * 编译期由 `satisfies ProjectionStore` 校验全部签名（含「返回 Promise」与参数类型），
 * 运行时由本文件的方法名/参数个数断言校验。
 */
const stub = {
  async acquireWriter(scopeKey: string, owner: string, ttlMs: number): Promise<WriterLease> {
    return stubCall("acquireWriter", scopeKey, owner, ttlMs);
  },
  async renewWriter(lease: WriterLease, ttlMs: number): Promise<WriterLease> {
    return stubCall("renewWriter", lease, ttlMs);
  },
  async createGeneration(input: CreateGenerationInput): Promise<RegistrationResult> {
    return stubCall("createGeneration", input);
  },
  async createDoc(input: CreateDocInput): Promise<RegistrationResult> {
    return stubCall("createDoc", input);
  },
  async registerSuccessor(input: RegisterSuccessorInput): Promise<RegistrationResult> {
    return stubCall("registerSuccessor", input);
  },
  async appendUpdates(input: AppendUpdatesInput): Promise<AppendUpdatesResult> {
    return stubCall("appendUpdates", input);
  },
  async putSealedIfAbsent(input: PutSealedInput): Promise<PutSealedResult> {
    return stubCall("putSealedIfAbsent", input);
  },
  async sealDoc(input: SealDocInput): Promise<SealDocResult> {
    return stubCall("sealDoc", input);
  },
  async commitGeneration(input: CommitGenerationInput): Promise<CommitGenerationResult> {
    return stubCall("commitGeneration", input);
  },
  async readDocStateAt(docId: string, seq: number): Promise<DocStateSnapshot | null> {
    return stubCall("readDocStateAt", docId, seq);
  },
  async readUpdatesAfter(docId: string, seq: number, limit: number): Promise<SyncUpdateRecord[]> {
    return stubCall("readUpdatesAfter", docId, seq, limit);
  },
  async readScopePointer(scopeKey: string): Promise<SyncScopeRow | null> {
    return stubCall("readScopePointer", scopeKey);
  },
  async readGeneration(scopeKey: string, generation: string): Promise<SyncGenerationRecord | null> {
    return stubCall("readGeneration", scopeKey, generation);
  },
  async readDirectory(query: DirectoryQuery): Promise<DirectoryPage> {
    return stubCall("readDirectory", query);
  },
  async locateRefs(query: RefQuery): Promise<SyncRefRecord[]> {
    return stubCall("locateRefs", query);
  },
  async retireAndCollect(scopeKey: string, target: RetireTarget): Promise<RetireResult> {
    return stubCall("retireAndCollect", scopeKey, target);
  },
} satisfies ProjectionStore;

/** 穷举处理动作：新增 `CommitOutcome` 取值时此处因 `never` 赋值失败而编译不过。 */
function describeOutcome(outcome: CommitOutcome): string {
  switch (outcome) {
    case "committed":
      return OUTCOME_HANDLING.committed;
    case "already-committed":
      return OUTCOME_HANDLING["already-committed"];
    case "conflict":
      return OUTCOME_HANDLING.conflict;
    case "unknown":
      return OUTCOME_HANDLING.unknown;
    default: {
      const unclassified: never = outcome;
      return unclassified;
    }
  }
}

describe("CommitOutcome 常量契约", () => {
  // 四值判定表是调用方处理提交结果的唯一依据：取值集合、顺序与无重复必须稳定，改名或增删都要显式确认。
  test("COMMIT_OUTCOMES 穷举四值且顺序稳定无重复", () => {
    expect([...COMMIT_OUTCOMES]).toEqual(["committed", "already-committed", "conflict", "unknown"]);
    expect(new Set(COMMIT_OUTCOMES).size).toBe(COMMIT_OUTCOMES.length);
    expect(COMMIT_OUTCOMES.length).toBe(4);
  });

  // 每个取值都必须有明确的处理动作（unknown 尤其不能被当作成功或失败处理），否则结果表存在空洞。
  test("每个取值都被判定表覆盖且处理动作互不相同", () => {
    const actions = COMMIT_OUTCOMES.map((outcome) => describeOutcome(outcome));
    expect(actions).toHaveLength(4);
    expect(new Set(actions).size).toBe(4);
    expect(Object.keys(OUTCOME_HANDLING).sort()).toEqual([...COMMIT_OUTCOMES].sort());
  });
});

describe("ProjectionStore 接口形状", () => {
  // 方法名集合是跨实现基线：桩必须实现全部接口方法，清单与接口方法名必须互为子集，任何增删改名都要显式更新。
  test("内存桩具备全部方法且方法名集合与冻结清单一致", () => {
    expect(Object.keys(stub).sort()).toEqual([...PROJECTION_STORE_METHODS].sort());
    expect(Object.keys(METHOD_ARITIES).sort()).toEqual([...PROJECTION_STORE_METHODS].sort());
  });

  // 参数个数属于原语签名：接口单方面增加参数而实现与清单不跟随，会让接线期实参错位。
  test("每个方法的参数个数与冻结清单一致", () => {
    for (const name of PROJECTION_STORE_METHODS) {
      expect(stub[name].length).toBe(METHOD_ARITIES[name]);
      expect(METHOD_ARITIES[name]).toBeGreaterThan(0);
    }
  });
});
