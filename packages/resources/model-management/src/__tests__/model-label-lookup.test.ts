/**
 * 模型展示标签投影（`findModelLabelsByIds`）的取数契约。
 *
 * 本函数是任务 1.7 B3 之后 agent-config 侧「模型怎么显示」的唯一数据来源：宿主在装配期把它绑到
 * `ModelLookupPort`（见 `packages/resources/model-management/src/server.ts` 的说明）。用例关注**取数条件**
 * 而非拼接格式——Provider 行必须与模型行同组织才算命中。`model.organization_id` 是随 Provider 冗余下来的
 * 列，这条逐行比对是「脏数据不跨组织显示」的兜底，删掉它不会有任何编译或类型信号，因此必须有可执行断言
 * 钉住：一致 / 不一致两种输入下 Map 的内容必须不同。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { findModelLabelsByIds } from "@fenix/model-management/server";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";

type ModelRow = {
  id: string;
  modelId: string;
  displayName: string | null;
  providerId: string;
  organizationId: string;
};

type ProviderRow = {
  id: string;
  organizationId: string;
  name: string;
  displayName: string | null;
};

/**
 * 装配 DB 替身：`findModelLabelsByIds` 依次发两条 `select`，第一条取模型行、第二条取 Provider 行，
 * 因此桩按**调用序号**返回两批行，而不是按表名分派（替身看不见表，只看得见链式调用的形状）。
 *
 * 顺序同生产装配：先登记句柄替身，再初始化基础设施——基础设施持有的是**引用**。
 */
function stubLabelQueries(modelRows: ModelRow[], providerRows: ProviderRow[]): void {
  let call = 0;
  resetAllStubs();
  stubDb({
    select: () => ({
      from: () => ({
        where: async () => (call++ === 0 ? modelRows : providerRows),
      }),
    }),
  });
  initializeTestApplicationInfrastructure();
}

function modelRow(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: "model_1",
    modelId: "gpt-4",
    displayName: "GPT-4",
    providerId: "prov_1",
    organizationId: "org_a",
    ...overrides,
  };
}

function providerRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return { id: "prov_1", organizationId: "org_a", name: "openai", displayName: "OpenAI", ...overrides };
}

describe("模型展示标签投影", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 标签以 <Provider 展示名>/<模型展示名> 两段拼成，调用方只把结果当显示文本用。
  test("同组织 Provider 命中并拼出两段标签", async () => {
    stubLabelQueries([modelRow()], [providerRow()]);

    const labels = await findModelLabelsByIds(["model_1"]);

    expect(labels.size).toBe(1);
    expect(labels.get("model_1")).toBe("OpenAI/GPT-4");
  });

  // 模型行与 Provider 行组织不一致属脏数据：不得把另一个组织的 Provider 名显示出来，宁可让调用方退回 id。
  test("Provider 属另一组织时不产出标签", async () => {
    stubLabelQueries([modelRow()], [providerRow({ organizationId: "org_b" })]);

    const labels = await findModelLabelsByIds(["model_1"]);

    expect(labels.size).toBe(0);
    expect(labels.has("model_1")).toBe(false);
  });

  // Provider 行缺失同样是「查不到」，与「展示名就是 id」是两种不同结果，不得在 Map 里造值。
  test("Provider 行缺失时不产出标签", async () => {
    stubLabelQueries([modelRow()], []);

    const labels = await findModelLabelsByIds(["model_1"]);

    expect(labels.size).toBe(0);
  });

  // 任一段展示名为空时回退到 name / model_id，保证标签非空且能定位到具体模型。
  test("展示名缺失时回退到 name 与 model_id", async () => {
    stubLabelQueries([modelRow({ displayName: null })], [providerRow({ displayName: null })]);

    const labels = await findModelLabelsByIds(["model_1"]);

    expect(labels.get("model_1")).toBe("openai/gpt-4");
  });

  // 入参为空是调用方的常态（列表里没有模型）：直接返回空 Map，不产生 DB 往返。
  test("入参为空时不查库", async () => {
    resetAllStubs();

    const labels = await findModelLabelsByIds([]);

    expect(labels.size).toBe(0);
  });
});
