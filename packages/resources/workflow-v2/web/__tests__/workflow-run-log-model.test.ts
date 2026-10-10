// web/__tests__/workflow-run-log-model.test.ts
// 运行日志视图的纯函数层用例：错误码 → 文案键必须**按码分流**（未绑定 / 会话 / 超时 / 上游的下一步动作不同），
// 状态必须把「未知」与「失败」分开，缺失字段必须定型成可显示的兜底而不是 null。
//
// 为什么钉这些：弹窗的失败描述就是 `t(runErrorKey(error))` 的返回值，漏一个码就会掉进通用文案——「空间没初始化」
// 与「上游崩了」在界面上长得一样，用户按提示做的动作就会错；同理，把上游读不懂的状态显示成「失败」会让用户去
// 排查一次并没有失败的运行。视图层只做「键 → 文案」，取值口径全在这里。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { WorkflowV2RunRecord } from "../api/workflow-runs";
import {
  formatRunDuration,
  formatRunIoValue,
  formatRunTime,
  RUN_MODE_LABEL_KEYS,
  RUN_STATUS_LABEL_KEYS,
  resolveRunSelection,
  runErrorKey,
  runModeKey,
  runSelectionKey,
  runStatusKey,
  toPlatformRunRow,
  toRunRecordRow,
} from "../pages/list/workflow-run-log-model";

/** 一条完整记录；用例按需覆盖字段（形态与上游库行一致：BIGINT 走字符串、时间走 ISO）。 */
const record = (overrides: Partial<WorkflowV2RunRecord> = {}): WorkflowV2RunRecord => ({
  executeId: "7694582493076258816",
  workflowId: "7694581096108785664",
  workflowName: "客服问答流程",
  version: "v0.0.2",
  mode: "release",
  status: "succeeded",
  durationMs: 1_500,
  createdAt: "2026-10-09T02:00:00.000Z",
  errorCode: null,
  nodeCount: 2,
  logId: "log-1",
  ...overrides,
});

describe("运行记录读取失败的错误码映射", () => {
  // 每一类失败都必须落到自己那条键上：未绑定要回列表页初始化、会话与降级要找管理员、超时与上游不可达重试即可。
  test("按稳定错误码分流到不同文案键", () => {
    const cases: Array<[string, string]> = [
      ["UNAUTHENTICATED", "run.failed_unauthorized"],
      ["UNAUTHORIZED", "run.failed_unauthorized"],
      ["FORBIDDEN", "run.failed_unauthorized"],
      ["WORKFLOW_NOT_FOUND", "run.failed_not_found"],
      ["ORG_APP_NOT_BOUND", "run.failed_unbound"],
      ["PLATFORM_ACCOUNT_DEGRADED", "run.failed_degraded"],
      // 台账缺行且按需引导没成功：用户修不了的状态，文案必须与「本组织还没绑定」分开（后者才引导去列表页初始化）。
      ["PLATFORM_ACCOUNT_NOT_PROVISIONED", "run.failed_account_not_provisioned"],
      ["PLATFORM_SESSION_UNAVAILABLE", "run.failed_session"],
      ["UPSTREAM_TIMEOUT", "run.failed_timeout"],
      ["UPSTREAM_UNAVAILABLE", "run.failed_upstream"],
      ["UPSTREAM_REJECTED", "run.failed_upstream"],
    ];
    for (const [code, key] of cases) {
      expect(runErrorKey(new ApiError("upstream said something", code))).toBe(key);
    }
  });

  // 不认识的失败（含请求层归一出的码与根本不是 ApiError 的异常）一律走通用文案：把未知失败翻译成一句看似
  // 精确的承诺，比说「读取失败，请重试」更糟。
  test("未知错误与非法入参回落通用文案", () => {
    expect(runErrorKey(new ApiError("boom", "SERVER_ERROR"))).toBe("run.failed");
    expect(runErrorKey(new ApiError("boom", "NETWORK_ERROR"))).toBe("run.failed");
    expect(runErrorKey(new Error("boom"))).toBe("run.failed");
    expect(runErrorKey(null)).toBe("run.failed");
  });
});

describe("运行状态 / 模式 → 文案键", () => {
  // 四档状态与「未知」必须分开：`null` 是「上游给了认不出的码」，显示成失败会让用户去排查一次并没有失败的运行。
  test("五档状态与未知各归其键", () => {
    expect(runStatusKey("running")).toBe(RUN_STATUS_LABEL_KEYS.running);
    expect(runStatusKey("succeeded")).toBe(RUN_STATUS_LABEL_KEYS.succeeded);
    expect(runStatusKey("failed")).toBe(RUN_STATUS_LABEL_KEYS.failed);
    expect(runStatusKey("canceled")).toBe(RUN_STATUS_LABEL_KEYS.canceled);
    expect(runStatusKey("interrupted")).toBe(RUN_STATUS_LABEL_KEYS.interrupted);
    expect(runStatusKey(null)).toBe(RUN_STATUS_LABEL_KEYS.unknown);
  });

  // 模式是上游库里的整数码（1/2/3），映射到「试运行 / 发布运行 / 节点调试」三档；认不出的码显示未知模式。
  test("三档模式与未知各归其键", () => {
    expect(runModeKey("debug")).toBe(RUN_MODE_LABEL_KEYS.debug);
    expect(runModeKey("release")).toBe(RUN_MODE_LABEL_KEYS.release);
    expect(runModeKey("node_debug")).toBe(RUN_MODE_LABEL_KEYS.node_debug);
    expect(runModeKey(null)).toBe(RUN_MODE_LABEL_KEYS.unknown);
  });
});

describe("记录行的视图模型", () => {
  // 行键用 execute id（主键必填，服务端已保证非空）：不需要序号兜底，重排也不会让 key 抖动。
  test("行键用 execute id 且字段逐项定型", () => {
    const row = toRunRecordRow(record(), 0, "zh-CN");

    expect(row.key).toBe("7694582493076258816");
    expect(row.executeId).toBe("7694582493076258816");
    expect(row.modeKey).toBe(RUN_MODE_LABEL_KEYS.release);
    expect(row.statusKey).toBe(RUN_STATUS_LABEL_KEYS.succeeded);
    expect(row.nodeCount).toBe(2);
    expect(row.errorCode).toBeNull();
  });

  // 上游 ID 必须原样带到详情取数目标上：出入参数的详情查询按它做归属校验（清单的筛选用的是本地主键，
  // 两套标识不能混）。上游没给时定型成 null——视图据此不提供选中入口，而不是拼出一个查不到的请求。
  test("上游 ID 原样带上，缺失时为 null", () => {
    expect(toRunRecordRow(record(), 0, "zh-CN").io).toEqual({
      executeId: "7694582493076258816",
      upstreamWorkflowId: "7694581096108785664",
    });
    expect(toRunRecordRow(record({ workflowId: null }), 0, "zh-CN").io).toBeNull();
    expect(toRunRecordRow(record({ executeId: null }), 0, "zh-CN").io).toBeNull();
  });

  // 时间、耗时、节点数与错误码缺失时必须是 null / null（由视图换成「上游未提供」），不能落成空串或 `Invalid Date`。
  test("缺失字段定型为 null 且行键退化为序号", () => {
    const row = toRunRecordRow(
      record({ executeId: null, createdAt: null, durationMs: null, nodeCount: null, status: null, mode: null }),
      3,
      "zh-CN",
    );

    expect(row.key).toBe("run-3");
    expect(row.executeId).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.duration).toBeNull();
    expect(row.nodeCount).toBeNull();
    expect(row.statusKey).toBe(RUN_STATUS_LABEL_KEYS.unknown);
    expect(row.modeKey).toBe(RUN_MODE_LABEL_KEYS.unknown);
  });

  // 失败运行的错误码要原样带上（上游库里的 `error_code` 是排查入口，不在前端翻译）。
  test("错误码原样通过", () => {
    expect(toRunRecordRow(record({ status: "failed", errorCode: "777777778" }), 0, "zh-CN").errorCode).toBe(
      "777777778",
    );
  });
});

describe("时间与耗时格式化", () => {
  // 无效时间串（上游给了坏值）必须回落 null：`new Date("x").toLocaleString()` 会印出 "Invalid Date"。
  test("无效时间串回落 null，有效时间按 locale 输出", () => {
    expect(formatRunTime(null, "zh-CN")).toBeNull();
    expect(formatRunTime("not-a-date", "zh-CN")).toBeNull();
    expect(formatRunTime("2026-10-09T02:00:00.000Z", "zh-CN")).toBe(
      new Date("2026-10-09T02:00:00.000Z").toLocaleString("zh-CN"),
    );
  });

  // 两档单位：秒以下整毫秒、秒以上一位小数；负数与非法值回落 null（上游不该给，但给了也不能印在界面上）。
  test("耗时按毫秒与秒两档格式化", () => {
    expect(formatRunDuration(0)).toBe("0 ms");
    expect(formatRunDuration(999)).toBe("999 ms");
    expect(formatRunDuration(1_500)).toBe("1.5 s");
    expect(formatRunDuration(60_000)).toBe("60.0 s");
    expect(formatRunDuration(null)).toBeNull();
    expect(formatRunDuration(-1)).toBeNull();
    expect(formatRunDuration(Number.NaN)).toBeNull();
  });
});

describe("出入参数上屏格式化", () => {
  // 上游回的是 JSON 序列化字符串（无缩进、中国话里的字段名全挤在一行）：按两空格缩进重排，用户才看得出结构。
  test("JSON 字符串按两空格缩进重排", () => {
    expect(formatRunIoValue('{"hello":"io-probe"}')).toBe('{\n  "hello": "io-probe"\n}');
    expect(formatRunIoValue("[1,2]")).toBe("[\n  1,\n  2\n]");
  });

  // 形态不受我方能控（可能是纯文本、也可能是上游自己的截断形态）：解析失败保持原文，比报错或隐藏更能说明现状。
  // 引号包裹的字符串是**合法 JSON**，重排后是带引号的字面量——照实显示，不替上游「还原」成裸文本。
  test("非 JSON 原文照抄，null 保持 null", () => {
    expect(formatRunIoValue("上游截断的输出…")).toBe("上游截断的输出…");
    expect(formatRunIoValue('"plain"')).toBe('"plain"');
    expect(formatRunIoValue("")).toBe("");
    expect(formatRunIoValue(null)).toBeNull();
  });
});

describe("平台侧运行记录的视图模型", () => {
  // 平台记录与执行记录共处一个选中空间，键必须带前缀且含归属与时刻：撞车会让右栏显示另一次运行的详情；
  // 时间在模型层就格式化（无效串回落 null），视图不再碰 `Date`。
  test("键带平台前缀、时间已格式化、结果与错误码原样带上", () => {
    const row = toPlatformRunRow(
      {
        upstreamWorkflowId: "7694581096108785664",
        occurredAt: "2026-10-09T02:00:00.000Z",
        result: "ok",
        errorCode: null,
      },
      "zh-CN",
    );

    expect(row.key).toBe("platform:7694581096108785664-2026-10-09T02:00:00.000Z");
    expect(row.time).toBe(new Date("2026-10-09T02:00:00.000Z").toLocaleString("zh-CN"));
    expect(row.result).toBe("ok");
    expect(row.errorCode).toBeNull();
  });

  // 上游归属缺失（平台侧也没记上）与坏时间串都不能让键或时间变成 `undefined` / `Invalid Date`。
  test("归属缺失与坏时间串都有兜底", () => {
    const row = toPlatformRunRow(
      { upstreamWorkflowId: null, occurredAt: "not-a-date", result: "upstream_rejected", errorCode: "502" },
      "zh-CN",
    );

    expect(row.key).toBe("platform:unknown-not-a-date");
    expect(row.time).toBeNull();
    expect(row.errorCode).toBe("502");
  });
});

describe("左栏选中项的解析", () => {
  const row = (overrides: Partial<WorkflowV2RunRecord> = {}, index = 0) =>
    toRunRecordRow(record(overrides), index, "zh-CN");
  const platform = (occurredAt: string, result = "ok") =>
    toPlatformRunRow({ upstreamWorkflowId: "7694581096108785664", occurredAt, result, errorCode: null }, "zh-CN");

  // 打开即选中第一条**可查看详情**的执行记录：空态等待会让用户以为这里没东西可看；缺执行 ID 的行不算候选，
  // 否则右栏会停在一个永远取不到数的选中项上。
  test("默认选中第一条可查看详情的执行记录", () => {
    const rows = [row({ executeId: null }, 0), row({ executeId: "id-2" }, 1)];
    const selection = resolveRunSelection(rows, [], null);

    expect(selection.key).toBe(runSelectionKey(rows[1]));
    expect(selection.run?.executeId).toBe("id-2");
    expect(selection.platform).toBeNull();
  });

  // 选中键在**当前这一批**里不存在时（切换筛选换了一批）必须回落，不能保留一条已经不在列表里的记录：
  // 右栏显示的运行必须能在左栏找到。
  test("选中键不在本批内时回落到第一条", () => {
    const rows = [row({ executeId: "id-9" }, 0)];
    const selection = resolveRunSelection(rows, [], "run:已删除的记录");

    expect(selection.key).toBe(runSelectionKey(rows[0]));
    expect(selection.run?.executeId).toBe("id-9");
  });

  // 平台记录也可选中（右栏据它的字段给「没有输入输出」的说明）：执行记录一条都不可选时它是默认选中，
  // 但只要有可选的执行记录，默认就轮不到它——执行记录才是主内容。
  test("无可选执行记录时选中第一条平台记录，有则不抢默认", () => {
    const platformRows = [platform("2026-10-09T02:00:00.000Z")];
    const withoutRuns = resolveRunSelection([row({ executeId: null })], platformRows, null);
    const withRuns = resolveRunSelection([row({ executeId: "id-1" })], platformRows, null);

    expect(withoutRuns.key).toBe(platformRows[0].key);
    expect(withoutRuns.platform?.result).toBe("ok");
    expect(withoutRuns.run).toBeNull();
    expect(withRuns.key).toBe("run:id-1");
    expect(withRuns.platform).toBeNull();
  });

  // 一条都选不中（记录缺执行 ID、也没有平台记录）时给空选中：右栏据此说明「缺执行 ID」而不是留白，
  // 崩溃或硬塞一条不存在的记录都不可接受。
  test("没有任何可选中项时给出空选中", () => {
    const selection = resolveRunSelection([row({ executeId: null })], [], null);

    expect(selection.key).toBeNull();
    expect(selection.run).toBeNull();
    expect(selection.platform).toBeNull();
  });
});
