import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubModuleConfig } from "@fenix/platform-sdk/testing";
import { moduleManifest } from "@fenix/resource-channel/module";
import { resetChannelModule } from "@fenix/resource-channel/server";

/**
 * channel 模块装配期的配置完整性校验。
 *
 * 启用 LangBot 的部署里，API Key 与 token 密钥是每条消息的硬依赖；缺配置若拖到请求期，表现是「消息
 * 全部失败但服务看起来正常」。未配置基址的部署不启用数据面，不能被这条校验挡住。
 */

/** 走 registry 的真实 create 路径（与宿主装配同一入口）。 */
async function assemble(): Promise<unknown> {
  const create = moduleManifest.create;
  if (!create) throw new Error("channel manifest 未声明 create");
  return create({ env: {}, modules: new Map(), declarations: [], registerCleanup: () => {} });
}

async function assembleError(): Promise<Error> {
  try {
    await assemble();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("预期装配失败，但模块创建成功");
}

beforeEach(() => {
  resetAllStubs();
});

afterEach(() => {
  resetChannelModule();
  resetAllStubs();
});

describe("channel 模块装配期配置校验", () => {
  // 配置了 LangBot 基址却缺 token 密钥：启动即失败，且错误只列键名、不回显配置值。
  test("配置 LangBot 基址但缺少 IM_TOKEN_SECRET 时装配失败", async () => {
    stubModuleConfig("channel", {
      imEventTextTtlHours: 24,
      langbotBaseUrl: "http://langbot.test/api/v1",
      langbotApiKey: "api-key",
    });

    const error = await assembleError();

    expect(error.message).toContain("IM_TOKEN_SECRET");
    expect(error.message).not.toContain("langbot.test");
    expect(error.message).not.toContain("api-key");
  });

  // API Key 与 token 密钥同属数据面硬依赖，缺任一枚都必须拒绝启动。
  test("配置 LangBot 基址但缺少 LANGBOT_API_KEY 时装配失败", async () => {
    stubModuleConfig("channel", {
      imEventTextTtlHours: 24,
      langbotBaseUrl: "http://langbot.test/api/v1",
      imTokenSecret: "im-secret",
    });

    await expect(assemble()).rejects.toThrow("LANGBOT_API_KEY");
  });

  // 两个密钥同时缺失时一次列出全部键名，避免运维补一个再重启一次。
  test("两个数据面密钥都缺失时同时列出键名", async () => {
    stubModuleConfig("channel", {
      imEventTextTtlHours: 24,
      langbotBaseUrl: "http://langbot.test/api/v1",
    });

    const error = await assembleError();

    expect(error.message).toContain("LANGBOT_API_KEY");
    expect(error.message).toContain("IM_TOKEN_SECRET");
  });

  // 未配置 LangBot 基址的部署不使用数据面：缺密钥不能阻断服务启动。
  test("未配置 LangBot 基址时允许装配", async () => {
    stubModuleConfig("channel", { imEventTextTtlHours: 24 });

    await expect(assemble()).resolves.toBeDefined();
  });
});
