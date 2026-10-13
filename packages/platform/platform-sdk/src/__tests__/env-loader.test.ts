import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { loadDeclaredEnv } from "../env-loader";

describe("loadDeclaredEnv", () => {
  // 只读取声明的模块变量，未启用模块的缺失变量不能阻止 CE 启动。
  test("loads selected definitions and ignores undeclared values", () => {
    const result = loadDeclaredEnv(
      [
        {
          moduleId: "ce-module",
          key: "CE_ENDPOINT",
          schema: z.string().url(),
          secret: false,
          restartRequired: true,
          description: "endpoint",
        },
      ],
      { CE_ENDPOINT: "https://example.test", EE_ONLY_SECRET: undefined },
    );

    expect(result).toEqual({ CE_ENDPOINT: "https://example.test" });
  });

  // 默认值由 manifest 定义提供，secret 值不会进入错误消息之外的诊断路径。
  test("applies manifest defaults", () => {
    const result = loadDeclaredEnv(
      [
        {
          moduleId: "ce-module",
          key: "CE_TIMEOUT",
          schema: z.coerce.number().int().positive(),
          defaultValue: 30,
          secret: false,
          restartRequired: true,
          description: "timeout",
        },
      ],
      {},
    );

    expect(result.CE_TIMEOUT).toBe(30);
  });

  // 同名变量的 schema、默认值或 secret 属性不一致时必须在启动前失败。
  test("rejects conflicting declarations", () => {
    const definition = {
      moduleId: "ce-module",
      key: "SHARED_KEY",
      schema: z.string(),
      secret: true,
      restartRequired: true,
      description: "shared",
    } as const;

    expect(() => loadDeclaredEnv([definition, { ...definition, moduleId: "ee-module", secret: false }], {})).toThrow(
      "环境变量 SHARED_KEY 被模块以不一致的契约重复声明",
    );
  });

  // 多个模块可以共享同一部署变量，但必须复用完全相同的校验和生命周期契约。
  test("allows compatible declarations from different modules", () => {
    const schema = z.string().min(1);
    const base = {
      key: "SHARED_ENDPOINT",
      schema,
      defaultValue: "https://example.test",
      secret: false,
      restartRequired: true,
      description: "endpoint",
    } as const;

    expect(
      loadDeclaredEnv(
        [
          { ...base, moduleId: "ce-module" },
          { ...base, moduleId: "ee-module" },
        ],
        {},
      ),
    ).toEqual({ SHARED_ENDPOINT: "https://example.test" });
  });
});
