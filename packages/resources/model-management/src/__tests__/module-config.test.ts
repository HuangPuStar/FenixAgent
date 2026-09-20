import { afterEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { getModelManagementConfig } from "../server/config";
import { createModelGatewayRuntime } from "../server/model-gateway/runtime";
import { createModelManagementModuleConfig, initializeModelManagementModuleConfig } from "../server/testing";

/**
 * 模块配置的读取路径与失败模式。
 *
 * 配置改由平台契约注入后（`getModuleConfig("model-management")` + 包内 schema 校验），这里覆盖三件
 * 生产上必须成立的事：宿主注入的配置经夹具能原样读回；缺必填字段时在**启动期**失败并报字段路径；
 * 失败信息不回显字段值——这份配置含网关管理密钥与凭据加密密钥，错误会被日志与错误响应带走。
 *
 * 替身只到平台契约层：本文件不装配 Elysia、不建 DB 连接。
 */

/** 未使用的最小主体复验替身：`createModelGatewayRuntime` 在配置不完整时先返回 `null`，不会调用它。 */
const unusedSubjectVerification = {
  verify: async () => ({ valid: true as const }),
};

describe("模型管理模块配置", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 夹具经生产读取路径（getModuleConfig + schema 校验）能原样读回，说明字段清单两侧一致。
  test("测试夹具经生产读取路径返回同一份配置", () => {
    initializeModelManagementModuleConfig();

    expect(getModelManagementConfig()).toEqual(createModelManagementModuleConfig());
  });

  // 默认夹具不带管理凭证与加密密钥：网关运行时整体不启用，而不是用空凭证启动或落明文。
  test("默认夹具下网关运行时返回 null（不启用）", () => {
    initializeModelManagementModuleConfig();

    expect(createModelGatewayRuntime({ subjectVerification: unusedSubjectVerification })).toBeNull();
  });

  // 缺必填字段时在读取点立刻失败，并只报字段路径与错误码——不回显同批注入的密钥值。
  test("缺必填字段时报字段路径且不回显字段值", () => {
    resetAllStubs();
    initializeTestApplicationInfrastructure({
      moduleConfigs: {
        "model-management": {
          modelGatewayType: "litellm",
          modelGatewayPublicBaseUrl: "http://localhost:4000",
          modelGatewayAdminUiUrl: "http://localhost:4000/ui/",
          modelGatewayAdminKey: "sk-not-a-real-key",
        },
      },
    });

    let message = "";
    try {
      getModelManagementConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("modelGatewayBaseUrl");
    expect(message).toContain("invalid_type");
    expect(message).not.toContain("sk-not-a-real-key");
  });

  // 未声明的字段直接拒绝：宿主字段改名会当场失败，而不是被静默忽略成「网关未启用」。
  test("未声明字段被拒绝（宿主字段改名不被静默忽略）", () => {
    resetAllStubs();
    initializeTestApplicationInfrastructure({
      moduleConfigs: {
        "model-management": { ...createModelManagementModuleConfig(), modelGatewayBaseURL: "http://localhost:4000" },
      },
    });

    expect(() => getModelManagementConfig()).toThrow("unrecognized_keys");
  });
});
