import { ApplicationBuilder, type ApplicationProfile, type ModuleStartContext } from "@fenix/server-runtime";
import Elysia from "elysia";

function createExampleBaseApp() {
  return new Elysia().get("/health", () => "ok");
}

type ExampleBaseApp = ReturnType<typeof createExampleBaseApp>;

function createMessagesModule(events: string[]) {
  return {
    name: "messages",
    createRoutes: () => new Elysia({ name: "example-messages" }).get("/messages", () => "messages"),
    start(_context: ModuleStartContext) {
      events.push("start:messages");
      return () => {
        events.push("stop:messages");
      };
    },
  };
}

function createAdminModule(events: string[]) {
  return {
    name: "admin",
    createRoutes: () => new Elysia({ name: "example-admin" }).get("/admin", () => "admin"),
    start(_context: ModuleStartContext) {
      events.push("start:admin");
      return () => {
        events.push("stop:admin");
      };
    },
  };
}

/** 用同一套基础应用和模块构造两个具有不同路由与生命周期的 Profile。 */
export function createProfileCompositionExample() {
  const events: string[] = [];
  const messagesModule = createMessagesModule(events);
  const adminModule = createAdminModule(events);
  const publicConfigure = (builder: ApplicationBuilder<ExampleBaseApp>) => builder.use(messagesModule);
  const publicProfile = {
    name: "public-example",
    configure: publicConfigure,
  } satisfies ApplicationProfile<ExampleBaseApp, ReturnType<typeof publicConfigure>>;

  const internalConfigure = (builder: ApplicationBuilder<ExampleBaseApp>) =>
    builder.use(messagesModule).use(adminModule);
  const internalProfile = {
    name: "internal-example",
    configure: internalConfigure,
  } satisfies ApplicationProfile<ExampleBaseApp, ReturnType<typeof internalConfigure>>;

  const createBuilder = (profileName: string) =>
    ApplicationBuilder.create({
      profileName,
      createBaseApp: createExampleBaseApp,
    });

  const publicRuntime = publicProfile.configure(createBuilder(publicProfile.name)).build();
  const internalRuntime = internalProfile.configure(createBuilder(internalProfile.name)).build();

  return { events, publicRuntime, internalRuntime };
}

if (import.meta.main) {
  const { events, publicRuntime, internalRuntime } = createProfileCompositionExample();
  const publicAdmin = await publicRuntime.app.handle(new Request("http://localhost/admin"));
  const internalAdmin = await internalRuntime.app.handle(new Request("http://localhost/admin"));

  await internalRuntime.start({ hostname: "127.0.0.1", port: 0 });
  await internalRuntime.stop();
  await publicRuntime.stop();

  console.log(
    JSON.stringify(
      {
        routes: {
          publicAdmin: publicAdmin.status,
          internalAdmin: internalAdmin.status,
        },
        lifecycle: events,
      },
      null,
      2,
    ),
  );
}
