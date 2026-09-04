import { describe, expect, test } from "bun:test";
import Elysia, { type AnyElysia } from "elysia";
import {
  type AnyServerModule,
  ApplicationBuilder,
  ApplicationProfileError,
  ApplicationStartError,
  ApplicationStopError,
  type ModuleDisposer,
  type ModuleStartContext,
  type ServerModule,
} from "..";

type Assert<TValue extends true> = TValue;
type RouteKeys<TApp> = TApp extends { "~Routes": infer TRoutes } ? keyof TRoutes : never;
type HasRoute<TApp, TRouteKey extends string> = TRouteKey extends RouteKeys<TApp> ? true : false;
type LacksRoute<TApp, TRouteKey extends string> = TRouteKey extends RouteKeys<TApp> ? false : true;
type HasNestedRoute<TApp, TParent extends string, TChild extends string> = TApp extends {
  "~Routes": infer TRoutes;
}
  ? TParent extends keyof TRoutes
    ? TChild extends keyof TRoutes[TParent]
      ? true
      : false
    : false
  : false;

function createLifecycleModule(
  name: string,
  start: (context: ModuleStartContext) => undefined | ModuleDisposer | Promise<undefined | ModuleDisposer>,
): ServerModule {
  return {
    name,
    createRoutes: () => new Elysia({ name: `test-${name}` }),
    start,
  };
}

function createRuntime(modules: readonly AnyServerModule[]) {
  let builder: ApplicationBuilder<AnyElysia, readonly AnyServerModule[]> = ApplicationBuilder.create({
    profileName: "test",
    createBaseApp: () => new Elysia(),
  });
  for (const module of modules) builder = builder.use(module);
  return builder.build();
}

describe("ApplicationBuilder", () => {
  // Profile 重名必须在构造 routes 和启动模块前失败，避免产生部分副作用。
  test("rejects duplicate module names before construction", () => {
    let createRoutesCalls = 0;
    const createModule = (): ServerModule => ({
      name: "duplicate",
      createRoutes: () => {
        createRoutesCalls++;
        return new Elysia();
      },
    });

    const builder = ApplicationBuilder.create({
      profileName: "test",
      createBaseApp: () => new Elysia(),
    });

    expect(() => builder.use(createModule()).use(createModule())).toThrow(ApplicationProfileError);
    expect(createRoutesCalls).toBe(0);
  });

  // 空 Profile 或模块名不能进入装配流程，避免不可诊断的生命周期日志。
  test("rejects empty profile and module names", () => {
    expect(() =>
      ApplicationBuilder.create({
        profileName: " ",
        createBaseApp: () => new Elysia(),
      }),
    ).toThrow("Application profile name must not be empty");

    expect(() =>
      ApplicationBuilder.create({
        profileName: "test",
        createBaseApp: () => new Elysia(),
      }).use({ name: "", createRoutes: () => new Elysia() }),
    ).toThrow("Server module name must not be empty");
  });

  // Base routes 与模块 routes 应按 Profile 顺序合并，并保留完整路由类型。
  test("preserves route order and inferred route types", async () => {
    const runtime = ApplicationBuilder.create({
      profileName: "typed",
      createBaseApp: () => new Elysia().get("/base", () => "base"),
    })
      .use({ name: "first", createRoutes: () => new Elysia().get("/first", () => "first") })
      .use({ name: "second", createRoutes: () => new Elysia().get("/second", () => "second") })
      .build();

    const baseRouteExists: Assert<HasRoute<typeof runtime.app, "base">> = true;
    const firstRouteExists: Assert<HasRoute<typeof runtime.app, "first">> = true;
    const secondRouteExists: Assert<HasRoute<typeof runtime.app, "second">> = true;
    const missingRouteIsExcluded: Assert<LacksRoute<typeof runtime.app, "missing">> = true;
    expect([baseRouteExists, firstRouteExists, secondRouteExists, missingRouteIsExcluded]).toEqual([
      true,
      true,
      true,
      true,
    ]);

    expect(await (await runtime.app.handle(new Request("http://localhost/base"))).text()).toBe("base");
    expect(await (await runtime.app.handle(new Request("http://localhost/first"))).text()).toBe("first");
    expect(await (await runtime.app.handle(new Request("http://localhost/second"))).text()).toBe("second");
  });

  // 非空 base prefix 必须同时作用于模块路由的运行时路径与 Eden 类型。
  test("applies the base prefix to module routes", async () => {
    const runtime = ApplicationBuilder.create({
      profileName: "prefixed",
      createBaseApp: () => new Elysia({ prefix: "/v1" }).get("/base", () => "base"),
    })
      .use({ name: "module", createRoutes: () => new Elysia().get("/module", () => "module") })
      .build();
    const moduleRouteExists: Assert<HasNestedRoute<typeof runtime.app, "v1", "module">> = true;

    expect(moduleRouteExists).toBe(true);
    expect(await (await runtime.app.handle(new Request("http://localhost/v1/module"))).text()).toBe("module");
    expect((await runtime.app.handle(new Request("http://localhost/module"))).status).toBe(404);
    await runtime.stop();
  });

  // 重复 build 必须创建相互独立的 Elysia wrapper，不能复用可变应用实例。
  test("builds independent application instances", () => {
    const builder = ApplicationBuilder.create({
      profileName: "repeatable",
      createBaseApp: () => new Elysia(),
    }).use({ name: "routes", createRoutes: () => new Elysia().get("/ok", () => "ok") });

    const first = builder.build();
    const second = builder.build();
    expect(first.app).not.toBe(second.app);
  });
});

describe("ApplicationRuntime", () => {
  // 正常启动按 Profile 顺序执行，停止时按成功模块的逆序释放资源。
  test("starts in profile order and disposes in reverse order", async () => {
    const events: string[] = [];
    const runtime = createRuntime([
      createLifecycleModule("first", () => {
        events.push("start:first");
        return () => {
          events.push("stop:first");
        };
      }),
      createLifecycleModule("second", () => {
        events.push("start:second");
        return () => {
          events.push("stop:second");
        };
      }),
    ] as const);

    await runtime.start({ hostname: "127.0.0.1", port: 0 });
    expect(runtime.state).toBe("listening");
    expect(events).toEqual(["start:first", "start:second"]);

    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    expect(events).toEqual(["start:first", "start:second", "stop:second", "stop:first"]);
  });

  // 正常停止必须先关闭监听，再广播取消并释放模块，重入 stop 仍共享同一 Promise。
  test("orders shutdown and handles reentrant stop", async () => {
    const events: string[] = [];
    let reentrantStop: Promise<void> | undefined;
    let requestStop = (): Promise<void> => Promise.resolve();
    const runtime = ApplicationBuilder.create({
      profileName: "shutdown-order",
      createBaseApp: () =>
        new Elysia().onStop(() => {
          events.push("stop:app");
        }),
    })
      .use({
        name: "resource",
        createRoutes: () => new Elysia(),
        start({ signal }: ModuleStartContext) {
          signal.addEventListener(
            "abort",
            () => {
              events.push("abort");
              reentrantStop = requestStop();
            },
            { once: true },
          );
          return () => {
            events.push("stop:resource");
          };
        },
      })
      .build();
    requestStop = () => runtime.stop();

    await runtime.start({ hostname: "127.0.0.1", port: 0 });
    const stop = runtime.stop();
    await stop;

    expect(reentrantStop).toBe(stop);
    expect(events).toEqual(["stop:app", "abort", "stop:resource"]);
  });

  // 模块启动失败时必须立即停止，跳过后续模块并释放此前成功模块。
  test("fails fast and unwinds only successful modules", async () => {
    const events: string[] = [];
    const primaryError = new Error("second failed");
    const runtime = createRuntime([
      createLifecycleModule("first", () => {
        events.push("start:first");
        return () => {
          events.push("stop:first");
        };
      }),
      createLifecycleModule("second", () => {
        events.push("start:second");
        throw primaryError;
      }),
      createLifecycleModule("third", () => {
        events.push("start:third");
      }),
    ] as const);

    const error = await runtime.start({ hostname: "127.0.0.1", port: 0 }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ApplicationStartError);
    expect(error.cause).toBe(primaryError);
    expect(error.moduleName).toBe("second");
    expect(error.unwindFailures).toEqual([]);
    expect(runtime.state).toBe("failed");
    expect(events).toEqual(["start:first", "start:second", "stop:first"]);
  });

  // Listen 失败时应释放所有成功模块，并保留端口绑定错误作为主错误。
  test("unwinds successful modules when listen fails", async () => {
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
    const events: string[] = [];
    const runtime = createRuntime([
      createLifecycleModule("resource", () => {
        events.push("start:resource");
        return () => {
          events.push("stop:resource");
        };
      }),
    ] as const);

    try {
      const error = await runtime.start({ hostname: "127.0.0.1", port: occupied.port }).catch((cause) => cause);
      expect(error).toBeInstanceOf(ApplicationStartError);
      expect(error.phase).toBe("listen");
      expect(error.cause).toBeDefined();
      expect(events).toEqual(["start:resource", "stop:resource"]);
      expect(runtime.state).toBe("failed");
    } finally {
      await occupied.stop(true);
    }
  });

  // 单个 disposer 失败不能阻断其余模块释放，最终错误应标明失败所有者。
  test("continues disposal after a module disposer fails", async () => {
    const events: string[] = [];
    const runtime = createRuntime([
      createLifecycleModule("first", () => () => {
        events.push("stop:first");
      }),
      createLifecycleModule("second", () => () => {
        events.push("stop:second");
        throw new Error("dispose failed");
      }),
    ] as const);

    await runtime.start({ hostname: "127.0.0.1", port: 0 });
    const error = await runtime.stop().catch((cause) => cause);
    expect(error).toBeInstanceOf(ApplicationStopError);
    expect(error.failures.map((failure: { moduleName: string }) => failure.moduleName)).toEqual(["second"]);
    expect(events).toEqual(["stop:second", "stop:first"]);
    expect(runtime.state).toBe("failed");
  });

  // 并发和重复 stop 必须共享同一结果，模块资源只能释放一次。
  test("makes stop idempotent across concurrent calls", async () => {
    let disposeCalls = 0;
    const runtime = createRuntime([
      createLifecycleModule("resource", () => async () => {
        disposeCalls++;
        await Promise.resolve();
      }),
    ] as const);

    await runtime.start({ hostname: "127.0.0.1", port: 0 });
    const first = runtime.stop();
    const second = runtime.stop();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await runtime.stop();
    expect(disposeCalls).toBe(1);
  });

  // 启动过程中收到 stop 时应传播取消信号、跳过后续模块并释放此前资源。
  test("stops safely while a module is starting", async () => {
    const events: string[] = [];
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const runtime = createRuntime([
      createLifecycleModule("first", () => {
        events.push("start:first");
        return () => {
          events.push("stop:first");
        };
      }),
      createLifecycleModule("second", async ({ signal }) => {
        events.push("start:second");
        markSecondStarted?.();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }),
      createLifecycleModule("third", () => {
        events.push("start:third");
      }),
    ] as const);

    const start = runtime.start({ hostname: "127.0.0.1", port: 0 });
    await secondStarted;
    const stop = runtime.stop();

    await expect(start).rejects.toBeInstanceOf(ApplicationStartError);
    await stop;
    expect(events).toEqual(["start:first", "start:second", "stop:first"]);
    expect(runtime.state).toBe("failed");
  });

  // Runtime 只能启动一次，防止重复分配同一组模块资源。
  test("rejects repeated starts", async () => {
    const runtime = createRuntime([] as const);
    await runtime.start({ hostname: "127.0.0.1", port: 0 });
    await expect(runtime.start({ hostname: "127.0.0.1", port: 0 })).rejects.toThrow(
      "Application cannot start from state 'listening'",
    );
    await runtime.stop();
  });
});
