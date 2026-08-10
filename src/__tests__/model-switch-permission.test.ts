// 模型切换拦截校验（evaluateModelSwitchPermission）纯决策测试（设计 §7：
// set_session_model 预选外拒绝）。服务端权威规则：
// - modelIds 非空：候选行（按引擎标识反查）任一命中预选 UUID → 放行；
// - modelIds=[]（单模型 agent）：仅当 modelId 命中默认模型行 → 放行；
// - 候选行为空 → INVALID_STATE。
import { describe, expect, test } from "bun:test";
import { evaluateModelSwitchPermission } from "../services/chat-channel-bootstrap";

const preset = (modelIds: string[] | null, modelId: string | null) => ({ modelIds, modelId });

describe("evaluateModelSwitchPermission 模型切换拦截（设计 §5.2）", () => {
  // 预选列表外模型 → FORBIDDEN
  test("预选列表外的模型被保守拒绝", () => {
    const result = evaluateModelSwitchPermission(
      preset(["uuid-1"], "uuid-default"),
      [{ id: "uuid-2", modelId: "m2" }],
      "m2",
    );
    expect(result?.code).toBe("FORBIDDEN");
  });

  // 预选列表内模型 → 放行
  test("预选列表内的模型放行", () => {
    const result = evaluateModelSwitchPermission(
      preset(["uuid-1"], "uuid-default"),
      [{ id: "uuid-1", modelId: "m1" }],
      "m1",
    );
    expect(result).toBeNull();
  });

  // 单模型 agent（modelIds=[]）：当前模型即默认模型 → 放行；其他 → FORBIDDEN
  test("单模型 agent 重选当前模型放行、其他模型拒绝", () => {
    const single = preset([], "uuid-default");
    const rows = [{ id: "uuid-default", modelId: "default-m" }];
    expect(evaluateModelSwitchPermission(single, rows, "default-m")).toBeNull();
    expect(evaluateModelSwitchPermission(single, rows, "other-m")?.code).toBe("FORBIDDEN");
  });

  // 引擎标识反查无候选行（模型已删除/标识不存在）→ INVALID_STATE
  test("引擎标识反查无候选行时返回 INVALID_STATE", () => {
    const result = evaluateModelSwitchPermission(preset(["uuid-1"], "uuid-default"), [], "ghost-m");
    expect(result?.code).toBe("INVALID_STATE");
  });

  // modelIds=null（存量未配置）→ 调用方放行；纯函数路径与单模型一致（仅默认模型可切）
  test("modelIds 为 null 时仅默认模型放行（存量兼容）", () => {
    const legacy = preset(null, "uuid-default");
    const rows = [{ id: "uuid-default", modelId: "default-m" }];
    expect(evaluateModelSwitchPermission(legacy, rows, "default-m")).toBeNull();
    expect(evaluateModelSwitchPermission(legacy, rows, "other-m")?.code).toBe("FORBIDDEN");
  });
});
