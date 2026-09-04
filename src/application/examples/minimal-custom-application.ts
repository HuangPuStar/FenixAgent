import { ApplicationBuilder, type ApplicationProfile, type ServerModule } from "@fenix/server-runtime";
import Elysia from "elysia";
import { type CommunityBaseAppOptions, createCommunityBaseApp } from "../base-app";

const EXAMPLE_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fenix App Builder 示例</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f1f5f9; color: #0f172a; }
      main { width: min(680px, calc(100% - 48px)); padding: 40px; border: 1px solid #cbd5e1; border-radius: 20px; background: #fff; box-shadow: 0 18px 50px #0f172a14; }
      h1 { margin: 8px 0 12px; font-size: clamp(28px, 5vw, 44px); line-height: 1.1; }
      h2 { margin-top: 32px; font-size: 18px; }
      p { color: #475569; line-height: 1.7; }
      .eyebrow { margin: 0; color: #2563eb; font-size: 13px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 12px 24px; margin: 28px 0 0; padding: 20px; border-radius: 12px; background: #f8fafc; }
      dt { color: #64748b; }
      dd { margin: 0; font-weight: 650; }
      ul { display: grid; gap: 10px; padding: 0; list-style: none; }
      a { display: block; padding: 12px 14px; border: 1px solid #bfdbfe; border-radius: 10px; color: #1d4ed8; text-decoration: none; }
      a:hover { background: #eff6ff; }
      a:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }
      code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
      .note { margin: 28px 0 0; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">ApplicationProfile</p>
      <h1>自定义组合已启动</h1>
      <p>这个页面由最小示例 Module 提供，证明自定义 Profile 可以复用 Community base app，同时省略完整业务模块。</p>
      <dl>
        <dt>Profile</dt><dd><code>community-minimal-example</code></dd>
        <dt>Module</dt><dd><code>minimal-example</code></dd>
        <dt>Base app</dt><dd><code>createCommunityBaseApp</code></dd>
        <dt>已省略</dt><dd><code>legacy-community</code></dd>
      </dl>
      <h2>可验证路由</h2>
      <ul>
        <li><a href="/health"><code>GET /health</code> - Community base app</a></li>
        <li><a href="/example/ping"><code>GET /example/ping</code> - minimal-example Module</a></li>
      </ul>
      <p class="note">完整生产应用仍由 <code>community-default</code> Profile 装配；本页面只用于 App Builder 试用。</p>
    </main>
  </body>
</html>`;

type CommunityBaseApp = ReturnType<typeof createCommunityBaseApp>;

function createExamplePageResponse(): Response {
  return new Response(EXAMPLE_PAGE, {
    headers: {
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** 创建不依赖外部资源的最小示例模块。 */
export function createMinimalExampleModule() {
  return {
    name: "minimal-example",
    createRoutes: () =>
      new Elysia({ name: "minimal-example-routes" })
        .get("/example", createExamplePageResponse)
        .get("/example/ping", () => ({ ok: true })),
  } satisfies ServerModule;
}

/** 创建只挂载最小示例模块的 Community Profile。 */
export function createCommunityMinimalExampleProfile() {
  const minimalExampleModule = createMinimalExampleModule();
  const configure = (builder: ApplicationBuilder<CommunityBaseApp>) => builder.use(minimalExampleModule);

  return {
    name: "community-minimal-example",
    configure,
  } satisfies ApplicationProfile<CommunityBaseApp, ReturnType<typeof configure>>;
}

/** 构造 Community 最小示例应用，不启动或监听。 */
export function createCommunityMinimalExampleApplication(options: CommunityBaseAppOptions) {
  const profile = createCommunityMinimalExampleProfile();
  const builder = ApplicationBuilder.create({
    profileName: profile.name,
    createBaseApp: () => createCommunityBaseApp(options),
  });

  return profile.configure(builder).build();
}
