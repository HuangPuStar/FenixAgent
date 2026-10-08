import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { createModuleRegistry, type DependencyService, type ModuleManifest } from "../index";

/**
 * 依赖服务声明（`dependencyServices`）的校验契约。
 *
 * 独立于 `assembly.test.ts`：那边验证装配顺序与生命周期，这里只验证「模块声明的依赖服务能不能被部署侧
 * 信任」——探针锚点、编排归属的必填字段、服务 ID 唯一性。这三条错了不会让应用起不来，但会让
 * `deploy/manifests` 与 `deploy/compose/overlays` 描述一个不存在的服务，所以必须在 registry 层拦下。
 */

/** 构造一个只带依赖服务声明的模块；`envKeys` 声明面刻意与探针锚点分开，便于构造非法组合。 */
function createManifest(dependencyServices: readonly DependencyService[], envKeys: readonly string[]): ModuleManifest {
  return {
    // 未注册进 registry 的模块不会被解析为依赖：这里直接构造声明面即可。
    dependencyServices,
    envDefinitions: envKeys.map((key) => ({
      defaultValue: "",
      description: `测试键 ${key}`,
      key,
      moduleId: "knowledge",
      restartRequired: true,
      schema: z.string(),
      secret: false,
    })),
    id: "knowledge",
    kind: "resource",
    dependsOn: [],
  };
}

/** 由本仓编排（overlay）的服务：必须声明 image，不得声明编排入口。 */
function overlayService(overrides: Partial<DependencyService> = {}): DependencyService {
  return {
    description: "测试服务",
    envKeys: ["SERVICE_URL"],
    healthCheck: { addressKey: "SERVICE_URL", kind: "http", path: "/health" },
    id: "test-service",
    image: "example/test-service:1",
    orchestration: "compose-overlay",
    required: false,
    ...overrides,
  };
}

// 合法的本仓编排声明必须通过：探针与 envKeys 都锚定在模块声明的键上。
test("接受锚定已声明环境变量的 compose-overlay 声明", () => {
  const registry = createModuleRegistry([createManifest([overlayService()], ["SERVICE_URL"])]);

  expect(registry).toBeDefined();
});

// 编排在别处的服务只留入口指针：composeFile 是部署方按顺序启动与排障的唯一线索，必须存在。
test("接受带入口指针的 separate 声明", () => {
  const registry = createModuleRegistry([
    createManifest(
      [
        {
          composeFile: "docker/ragflow/docker-compose.yml",
          description: "外部栈",
          envKeys: ["SERVICE_URL"],
          healthCheck: { addressKey: "SERVICE_URL", kind: "tcp" },
          id: "external-service",
          orchestration: "separate",
          required: false,
        },
      ],
      ["SERVICE_URL"],
    ),
  ]);

  expect(registry).toBeDefined();
});

// 探针锚点必须落在本模块声明过的键上：否则部署前自检会读一个不存在的键，静默探活失败。
test("拒绝探针引用未声明的环境变量键", () => {
  const manifest = createManifest(
    [overlayService({ healthCheck: { addressKey: "UNDECLARED_URL", kind: "http", path: "/health" } })],
    ["SERVICE_URL"],
  );

  expect(() => createModuleRegistry([manifest])).toThrow("引用了未声明的环境变量 UNDECLARED_URL");
});

// `envKeys` 是部署方查地址的口径，同样不能指向未声明的键。
test("拒绝 envKeys 引用未声明的环境变量键", () => {
  const manifest = createManifest([overlayService({ envKeys: ["OTHER_URL"] })], ["SERVICE_URL"]);

  expect(() => createModuleRegistry([manifest])).toThrow("引用了未声明的环境变量 OTHER_URL");
});

// 由本仓编排却没有镜像 = 生成的 overlay 里没有可运行的服务，等于声明了一句空话。
test("拒绝 compose-overlay 声明缺少 image", () => {
  const manifest = createManifest([overlayService({ image: undefined })], ["SERVICE_URL"]);

  expect(() => createModuleRegistry([manifest])).toThrow("由本仓编排时必须声明 image");
});

// 两种编排归属互斥：同时声明 image 与 composeFile 会让同一服务有两份定义。
test("拒绝 compose-overlay 声明 composeFile", () => {
  const manifest = createManifest([overlayService({ composeFile: "docker/x/docker-compose.yml" })], ["SERVICE_URL"]);

  expect(() => createModuleRegistry([manifest])).toThrow("不得声明 composeFile");
});

// 编排在别处却没有入口指针：部署方无从知道该先启动什么。
test("拒绝 separate 声明缺少 composeFile", () => {
  const manifest = createManifest([overlayService({ image: undefined, orchestration: "separate" })], ["SERVICE_URL"]);

  expect(() => createModuleRegistry([manifest])).toThrow("必须声明 composeFile");
});

// 编排不在本仓的镜像与端口由它自己的编排决定，模块再声明一份就是同一栈的第二份真相。
test("拒绝 separate 声明 image 或 ports", () => {
  const manifest = createManifest(
    [
      {
        composeFile: "docker/x/docker-compose.yml",
        description: "外部栈",
        healthCheck: { addressKey: "SERVICE_URL", kind: "tcp" },
        id: "external-service",
        image: "example/external:1",
        orchestration: "separate",
        required: false,
      },
    ],
    ["SERVICE_URL"],
  );

  expect(() => createModuleRegistry([manifest])).toThrow("不得声明 image 或 ports");
});

// 同一模块内服务 ID 唯一：合并是按 ID 做的，重名会让其中一个声明被静默吞掉。
test("拒绝同一模块内重复的依赖服务 ID", () => {
  const manifest = createManifest([overlayService(), overlayService()], ["SERVICE_URL"]);

  expect(() => createModuleRegistry([manifest])).toThrow("重复声明依赖服务 test-service");
});

// 服务 ID 与模块 ID 同规则：生成物里它就是 compose 的服务名与文件名的一部分，不能自由发挥。
test("拒绝非法依赖服务 ID", () => {
  const manifest = createManifest([overlayService({ id: "Test_Service" })], ["SERVICE_URL"]);

  expect(() => createModuleRegistry([manifest])).toThrow("不是合法模块 ID");
});

// 未声明依赖服务的既有模块零影响：这是把新字段做成可选字段的验收条件。
test("未声明依赖服务的模块照常注册", () => {
  const registry = createModuleRegistry([{ id: "task", kind: "resource", dependsOn: [] }]);

  expect(registry).toBeDefined();
});
