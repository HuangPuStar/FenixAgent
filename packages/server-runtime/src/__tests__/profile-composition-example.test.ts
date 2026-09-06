import { describe, expect, test } from "bun:test";
import { createProfileCompositionExample } from "../examples/profile-composition";

type Assert<TValue extends true> = TValue;
type RouteKeys<TApp> = TApp extends { "~Routes": infer TRoutes } ? keyof TRoutes : never;
type HasRoute<TApp, TPath extends string> = TPath extends RouteKeys<TApp> ? true : false;
type LacksRoute<TApp, TPath extends string> = TPath extends RouteKeys<TApp> ? false : true;

describe("profile composition example", () => {
  // 两个 Profile 必须从同一组构件得到不同且精确的路由集合。
  test("builds applications with different routes", async () => {
    const { publicRuntime, internalRuntime } = createProfileCompositionExample();
    const publicHasMessages: Assert<HasRoute<typeof publicRuntime.app, "messages">> = true;
    const publicLacksAdmin: Assert<LacksRoute<typeof publicRuntime.app, "admin">> = true;
    const internalHasAdmin: Assert<HasRoute<typeof internalRuntime.app, "admin">> = true;

    expect([publicHasMessages, publicLacksAdmin, internalHasAdmin]).toEqual([true, true, true]);
    expect((await publicRuntime.app.handle(new Request("http://localhost/messages"))).status).toBe(200);
    expect((await publicRuntime.app.handle(new Request("http://localhost/admin"))).status).toBe(404);
    expect((await internalRuntime.app.handle(new Request("http://localhost/admin"))).status).toBe(200);

    await publicRuntime.stop();
    await internalRuntime.stop();
  });

  // 只有被 Profile 选中的模块才会启动，并按相反顺序释放资源。
  test("runs only the selected module lifecycles", async () => {
    const { events, internalRuntime } = createProfileCompositionExample();

    await internalRuntime.start({ hostname: "127.0.0.1", port: 0 });
    expect(events).toEqual(["start:messages", "start:admin"]);

    await internalRuntime.stop();
    expect(events).toEqual(["start:messages", "start:admin", "stop:admin", "stop:messages"]);
  });
});
