import { describe, expect, test } from "bun:test";
import {
  extractModelStateFromConfigOptions,
  extractModeStateFromConfigOptions,
} from "../transport/relay/yjs-frontend/config-options";

describe("config options state extraction", () => {
  // group 内的模型选项应被拍平，并保留选中模型
  test("extracts grouped model options", () => {
    const state = extractModelStateFromConfigOptions([
      {
        type: "select",
        id: "model",
        currentValue: "model-pro",
        options: [
          {
            group: "models",
            options: [
              { value: "model-fast", name: "Fast" },
              { value: "model-pro", name: "Pro" },
            ],
          },
        ],
      },
    ]);

    expect(state).toEqual({
      currentModelId: "model-pro",
      availableModels: [
        { modelId: "model-fast", name: "Fast" },
        { modelId: "model-pro", name: "Pro" },
      ],
    });
  });

  // currentValue 不在 group 模型候选项中时，应回退到第一个平铺候选项
  test("falls back to the first grouped model when currentValue is unavailable", () => {
    const state = extractModelStateFromConfigOptions([
      {
        type: "select",
        id: "model",
        currentValue: "missing",
        options: [
          {
            group: "models",
            options: [
              { value: "model-fast", name: "Fast" },
              { value: "model-pro", name: "Pro" },
            ],
          },
        ],
      },
    ]);

    expect(state).toEqual({
      currentModelId: "model-fast",
      availableModels: [
        { modelId: "model-fast", name: "Fast" },
        { modelId: "model-pro", name: "Pro" },
      ],
    });
  });

  // currentValue 不在候选项中时，mode 必须回退到第一个选项
  test("falls back to the first mode when currentValue is unavailable", () => {
    const state = extractModeStateFromConfigOptions([
      {
        type: "select",
        category: "mode",
        currentValue: "missing",
        options: [
          { value: "ask", name: "Ask", description: "Ask before changes" },
          { value: "plan", name: "Plan" },
        ],
      },
    ]);

    expect(state).toEqual({
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask", description: "Ask before changes" },
        { id: "plan", name: "Plan", description: null },
      ],
    });
  });

  // 没有 model 或 mode select 配置时应返回 null
  test("returns null when no matching option exists", () => {
    const configOptions = [{ type: "select", id: "theme", options: [] }];

    expect(extractModelStateFromConfigOptions(configOptions)).toBeNull();
    expect(extractModeStateFromConfigOptions(configOptions)).toBeNull();
  });
});
