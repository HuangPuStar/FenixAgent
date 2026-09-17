import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCtrlStaticAssetsDirectory } from "../../apps/server/src/plugins/static";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

/** 将续行合并为可独立检查的 Dockerfile 指令。 */
function readDockerInstructions(dockerfile: string): string[] {
  const instructions: string[] = [];
  let current = "";

  for (const rawLine of dockerfile.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const continued = line.endsWith("\\");
    const content = continued ? line.slice(0, -1).trimEnd() : line;
    current = current ? `${current} ${content}` : content;
    if (!continued) {
      instructions.push(current);
      current = "";
    }
  }

  if (current) instructions.push(current);
  return instructions;
}

/** 返回命名 Docker stage 的指令，不包含相邻 stage 的内容。 */
function readDockerStageInstructions(dockerfile: string, stageName: string): string[] {
  const instructions = readDockerInstructions(dockerfile);
  const stageStart = instructions.findIndex((instruction) => {
    const match = instruction.match(/^FROM\s+\S+\s+AS\s+(\S+)$/i);
    return match?.[1]?.toLowerCase() === stageName.toLowerCase();
  });
  if (stageStart === -1) throw new Error(`Docker stage not found: ${stageName}`);

  const nextStageOffset = instructions.slice(stageStart + 1).findIndex((instruction) => /^FROM\s+/i.test(instruction));
  const stageEnd = nextStageOffset === -1 ? instructions.length : stageStart + 1 + nextStageOffset;
  return instructions.slice(stageStart + 1, stageEnd);
}

/** 按 Docker shell form 所需的最小规则拆词，并拒绝未闭合的引号或转义。 */
function parseDockerShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let wordStarted = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      wordStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      wordStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      wordStarted = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      wordStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (wordStarted) {
        words.push(current);
        current = "";
        wordStarted = false;
      }
      continue;
    }
    current += character;
    wordStarted = true;
  }

  if (quote || escaped) throw new Error(`Unclosed shell COPY operand: ${value}`);
  if (wordStarted) words.push(current);
  return words;
}

/** 找出 COPY source 中仍指向仓库根 src 或 web 的路径。 */
function findLegacyRootCopySources(dockerfile: string): string[] {
  const legacySources: string[] = [];

  for (const instruction of readDockerInstructions(dockerfile)) {
    const copyMatch = instruction.match(/^COPY\s+(.+)$/i);
    if (!copyMatch?.[1]) continue;

    const copyBody = copyMatch[1].replace(/^(?:--\S+\s+)*/, "");
    let operands: string[];
    if (copyBody.startsWith("[")) {
      const parsed = JSON.parse(copyBody) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((operand) => typeof operand === "string")) {
        throw new Error(`Invalid JSON COPY instruction: ${instruction}`);
      }
      operands = parsed;
    } else {
      operands = parseDockerShellWords(copyBody);
    }

    if (operands.length < 2) throw new Error(`COPY requires source and destination: ${instruction}`);

    for (const source of operands.slice(0, -1)) {
      if (/^(?:\.\/)?(?:src|web)(?:\/|$)/.test(source)) legacySources.push(source);
    }
  }

  return legacySources;
}

const dockerCopyCases = [
  { instruction: "COPY package.json src ./dest/", violatesRoot: true },
  { instruction: 'COPY ["src", "./src"]', violatesRoot: true },
  { instruction: 'COPY ["web", "./web"]', violatesRoot: true },
  { instruction: "COPY apps/server/src ./apps/server/src", violatesRoot: false },
  { instruction: "COPY apps/web ./apps/web", violatesRoot: false },
  { instruction: "COPY packages/example/src ./packages/example/src", violatesRoot: false },
];

// Docker COPY 解析必须识别 shell/JSON 多源根路径，同时放行 apps 与 packages 内部源码。
test.each(dockerCopyCases)("Docker COPY 根路径识别：$instruction", ({ instruction, violatesRoot }) => {
  expect(findLegacyRootCopySources(instruction).length > 0).toBe(violatesRoot);
});

// Shell form COPY 必须解开成对引号和转义，同时只把真正的根 src/web source 判为违规。
test("Docker COPY 识别 quoted shell source 且放行嵌套路径", () => {
  expect(findLegacyRootCopySources('COPY "src" /dest/')).toEqual(["src"]);
  expect(findLegacyRootCopySources("COPY 'web' /dest/")).toEqual(["web"]);
  expect(findLegacyRootCopySources('COPY "apps/server/src" /dest/')).toEqual([]);
  expect(findLegacyRootCopySources("COPY apps/web/my\\ file /dest/")).toEqual([]);
});

// 反斜杠续行中的独立注释不能截断 COPY，后续根 source 仍必须参与检查。
test("Docker COPY 跨独立注释续行识别根 source", () => {
  const instruction = `COPY package.json \\
    # 说明下一行 source 的独立注释
    src \\
    /dest/`;

  expect(findLegacyRootCopySources(instruction)).toEqual(["src"]);
});

// 应用启动只能从 apps 目录进入，根目录不再保留第二个入口。
test("server 与 web 只有 apps 下的应用入口", () => {
  expect(existsSync(resolve(repoRoot, "apps/server/src/main.ts"))).toBe(true);
  expect(existsSync(resolve(repoRoot, "apps/web/src/main.tsx"))).toBe(true);
  expect(existsSync(resolve(repoRoot, "src/index.ts"))).toBe(false);
  expect(existsSync(resolve(repoRoot, "web/src/main.tsx"))).toBe(false);
  expect(existsSync(resolve(repoRoot, "web/src/bootstrap.ts"))).toBe(false);
  expect(readRepoFile("apps/server/src/main.ts")).toContain("new Elysia");
  expect(readRepoFile("apps/web/src/main.tsx")).toContain("createRoot");
});

// 根命令、Vite 和静态托管必须一致地指向新应用入口与产物。
test("开发、构建和静态托管使用 apps 入口", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
  const viteConfig = readRepoFile("apps/web/vite.config.ts");
  const staticPlugin = readRepoFile("apps/server/src/plugins/static.ts");
  const dockerfile = readRepoFile("Dockerfile");

  expect(packageJson.scripts.dev).toBe("bun run apps/server/src/main.ts");
  expect(packageJson.scripts.start).toBe("bun run apps/server/src/main.ts");
  expect(packageJson.scripts["dev:web"]).toContain("apps/web/vite.config.ts");
  expect(packageJson.scripts["build:web"]).toContain("apps/web/vite.config.ts");
  expect(viteConfig).toContain("root: __dirname");
  expect(viteConfig).toContain('path.resolve(__dirname, "index.html")');
  expect(staticPlugin).toContain('"apps/web/dist"');
  expect(staticPlugin).toContain("RCS_APPLICATION_ROOT");
  expect(staticPlugin).not.toContain('resolve(__dirname, "../../../web/dist")');
  expect(dockerfile).toContain("COPY apps/web ./apps/web");
  expect(dockerfile).toContain("bun build apps/server/src/main.ts");
  expect(dockerfile).toContain("/app/apps/web/dist ./apps/web/dist");
  expect(dockerfile).toContain("ENV RCS_APPLICATION_ROOT=/app");
  expect(dockerfile).toContain('CMD ["bun", "dist/index.js"]');
  expect(readRepoFile("docker-compose.yml")).toContain("run dist/index.js");
  expect(readRepoFile("docker/prod/docker-compose.yml")).toContain("run dist/index.js");
});

// 生产镜像必须安装 apps workspace 依赖、构建完整 server，并只复制 apps 下的运行产物。
test("Docker 生产交付路径使用 apps workspace", () => {
  const dockerfile = readRepoFile("Dockerfile");
  const depsInstructions = readDockerStageInstructions(dockerfile, "deps");
  const buildInstructions = readDockerStageInstructions(dockerfile, "build");
  const runtimeInstructions = readDockerStageInstructions(dockerfile, "runtime");
  const installIndex = depsInstructions.indexOf("RUN bun install --frozen-lockfile");
  const serverManifestIndex = depsInstructions.indexOf("COPY apps/server/package.json apps/server/package.json");
  const webManifestIndex = depsInstructions.indexOf("COPY apps/web/package.json apps/web/package.json");

  expect(dockerfile).toMatch(/^FROM\s+deps\s+AS\s+build\s*$/m);
  expect(installIndex).toBeGreaterThan(-1);
  expect(serverManifestIndex).toBeGreaterThan(-1);
  expect(webManifestIndex).toBeGreaterThan(-1);
  expect(serverManifestIndex).toBeLessThan(installIndex);
  expect(webManifestIndex).toBeLessThan(installIndex);
  expect(buildInstructions).toContain("COPY apps/server ./apps/server");
  expect(
    buildInstructions.some((instruction) =>
      /^RUN\s+bun\s+build\s+apps\/server\/src\/main\.ts(?:\s|$)/.test(instruction),
    ),
  ).toBe(true);
  expect(runtimeInstructions).toContain("COPY --from=build /app/apps/web/dist ./apps/web/dist");
  expect(findLegacyRootCopySources(dockerfile)).toEqual([]);
});

// 源码模式必须从模块位置推导应用根，不能受调用进程的工作目录影响。
test("静态资源 fallback 指向 apps web 构建产物", () => {
  expect(resolveCtrlStaticAssetsDirectory(undefined)).toBe(resolve(repoRoot, "apps/web/dist"));
});

// Bun bundle 会将 server 模块输出到 /app/dist；静态资源必须仍从运行时应用根读取，不能按 bundle 文件位置回退到 /web。
test("编译 bundle 在非仓库工作目录仍从应用根读取静态资源", () => {
  expect(resolveCtrlStaticAssetsDirectory("/app")).toBe("/app/apps/web/dist");
});

// 编译产物的 import.meta.url 位于 dist；即使进程工作目录不在仓库，Docker 声明的应用根仍必须定位到控制台资源。
test("编译后的静态插件从非仓库工作目录读取应用根", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "fenix-static-bundle-"));

  try {
    const bundleDir = join(fixtureRoot, "bundle");
    const applicationRoot = join(fixtureRoot, "app");
    const isolatedWorkingDirectory = join(fixtureRoot, "non-repository-cwd");
    await Promise.all([
      mkdir(bundleDir, { recursive: true }),
      mkdir(join(applicationRoot, "apps/web/dist"), { recursive: true }),
      mkdir(isolatedWorkingDirectory, { recursive: true }),
    ]);

    const result = await Bun.build({
      entrypoints: [resolve(repoRoot, "apps/server/src/plugins/static.ts")],
      outdir: bundleDir,
      target: "bun",
    });
    expect(result.success).toBe(true);
    const bundlePath = result.outputs[0]?.path;
    expect(bundlePath).toBeDefined();

    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { resolveCtrlStaticAssetsDirectory } from ${JSON.stringify(bundlePath)}; console.log(resolveCtrlStaticAssetsDirectory());`,
      ],
      {
        cwd: isolatedWorkingDirectory,
        env: { ...process.env, RCS_APPLICATION_ROOT: applicationRoot },
        stdout: "pipe",
      },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(join(applicationRoot, "apps/web/dist"));
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

// 质量门禁必须扫描唯一的 server 源码目录，避免根 src 删除后脚本悄悄跳过后端代码。
test("质量脚本使用 apps server 源码目录", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
  const ciScript = readRepoFile("scripts/ci.ts");
  const githubWorkflow = readRepoFile(".github/workflows/ci.yml");

  for (const script of ["lint", "lint:fix", "format", "format:check"]) {
    expect(packageJson.scripts[script]).toContain("apps/server/src/");
    expect(packageJson.scripts[script]).not.toMatch(/(?:^|\s)src\//);
  }
  const testEntries = [
    "bun test apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/",
    "bun test packages/",
    "bun test apps/web/src/__tests__/",
  ];
  for (const entry of testEntries) {
    expect(ciScript).toContain(entry);
    expect(githubWorkflow).toContain(entry);
  }
  expect(ciScript).not.toContain("bun test src/__tests__/");
  expect(githubWorkflow).not.toContain("find src/__tests__");
});

// 前端类型检查必须包含 apps 入口，否则 Router 的全局类型注册会在迁移后丢失。
test("前端类型检查使用 apps web 配置", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
  const webTsconfig = readRepoFile("apps/web/tsconfig.json");

  expect(packageJson.scripts["typecheck:web"]).toContain("apps/web/tsconfig.json");
  expect(webTsconfig).toContain('"src/**/*.tsx"');
});

// 前端组件迁入 apps 与 package Web 边界后，Tailwind 必须扫描两侧源码以生成页面 utility 样式。
test("Tailwind 扫描 apps 与 package web 源码以生成页面 utility 样式", () => {
  const styles = readRepoFile("apps/web/src/index.css");

  expect(styles).toContain('@source "../**/*.{ts,tsx}";');
  expect(styles).toContain('@source "../../../packages/**/web/**/*.{ts,tsx}";');
});
