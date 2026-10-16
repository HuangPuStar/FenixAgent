/**
 * `docker/<组件>/` 的自包含契约：把该目录整体拷到目标机，只用它自己的 `.env`（由该目录 `.env.example` 的
 * 有效赋值行填成）就必须能 `docker compose config` 通过并起容器——不读别的目录的配置，也不靠调用方 export。
 *
 * 为什么要测：这条约束只靠「编排里当前恰好这么写」维持，review 时看不出来。典型回退是把 `${VAR:?}` 的键在
 * `.env.example` 里只留一行注释（`docker/agent-sites/` 曾经如此）：独立部署会在 `config` 阶段直接失败，
 * 而那行注释往往正是「以为主服务 env 会带过来」的痕迹——独立部署没有主服务。
 *
 * 判定对象是交付面文件（compose 与 `.env.example`），不看 README 的说明文字。除「配置从哪来」外，还有一条
 * 「数据往哪去」：编排声明的容器内数据路径（`*_PATH` / `*_DIR` 取值）必须落在同文件的挂载目标上，否则这份
 * 交付面在自己的目录里跑起来也不完整。三处例外：
 *   - `docker/dev/`：本地开发编排，设计上由仓库根 `docker-compose.yml` 通过 `include` 拼进同一个项目；
 *     `docker/lib/` 是脚本库、`docker/compose-explorer/` 是只读工具，都不是组件目录，一律不在范围。
 *   - **生成物模板**（`.env.example`、`docker/main/.env.example`：`scripts/lib/env-example-spec.ts` 的
 *     `ENV_TEMPLATES`）：键行一律是注释行，必填键由 `./docker/deploy.sh validate` 汇总点名，因此「有效赋值行」
 *     这条口径只对手写模板的组件目录成立——生成物目录本身仍受 env_file 与挂载两条判定约束。
 *   - 网络：组件以 `external: true` 引用 `fenix-server`（由主服务项目创建）是**编排契约**而非配置依赖，逐目录写在
 *     各自 README 的「前置条件」里，本文件不做判定。
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ENV_TEMPLATES } from "../lib/env-example-spec";

const DOCKER_ROOT = resolve(import.meta.dir, "../../docker");

/** 非组件目录见文件头说明。 */
const NON_COMPONENT_DIRECTORIES = new Set(["dev", "lib", "compose-explorer"]);

interface ComponentContract {
  readonly name: string;
  readonly compose: string;
  readonly envTemplate: string;
}

const components: readonly ComponentContract[] = readdirSync(DOCKER_ROOT)
  .filter((name) => !NON_COMPONENT_DIRECTORIES.has(name) && statSync(join(DOCKER_ROOT, name)).isDirectory())
  .filter((name) => existsSync(join(DOCKER_ROOT, name, "docker-compose.yml")))
  .map((name) => {
    const envTemplatePath = join(DOCKER_ROOT, name, ".env.example");
    return {
      name,
      compose: readFileSync(join(DOCKER_ROOT, name, "docker-compose.yml"), "utf8"),
      envTemplate: existsSync(envTemplatePath) ? readFileSync(envTemplatePath, "utf8") : "",
    };
  });

/**
 * `.env.example` 由生成器产出的组件目录（键行一律注释）：判定口径与手写模板不同，见文件头说明。
 * 取自生成器自己的模板清单，避免在这里手抄一份会漂移的名单。
 */
const GENERATED_TEMPLATE_DIRECTORIES: ReadonlySet<string> = new Set(
  ENV_TEMPLATES.map((template) => dirname(template.path))
    .filter((directory) => directory.startsWith("docker/"))
    .map((directory) => directory.slice("docker/".length)),
);

/** `.env.example` 里**有效赋值行**的键；注释行不算——注释掉的必填键等于没提供，目标机照样报缺变量。 */
function activeAssignmentKeys(envTemplate: string): Set<string> {
  const keys = new Set<string>();
  for (const line of envTemplate.split("\n")) {
    const matched = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (matched?.[1] !== undefined) keys.add(matched[1]);
  }
  return keys;
}

interface InterpolationUsage {
  /** 有 `${KEY:?}` 用法：缺失或为空时 compose 在 `config` 阶段就失败。 */
  readonly required: boolean;
  /** 有**无缺省值**的用法（`${KEY}` / `${KEY:?}`）：不提供时会被替换成空串。 */
  readonly undefaulted: boolean;
}

/** 按行扫出 compose 用到的插值键；注释行不是插值，必须排除，否则注释里的 `${VAR:?}` 会被当成真实依赖。 */
function interpolationUsage(compose: string): Map<string, InterpolationUsage> {
  const usage = new Map<string, InterpolationUsage>();
  for (const line of compose.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const matched of line.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:[-?])?/g)) {
      const key = matched[1] ?? "";
      const marker = matched[2] ?? "";
      const current = usage.get(key) ?? { required: false, undefaulted: false };
      usage.set(key, {
        required: current.required || marker === ":?",
        undefaulted: current.undefaulted || marker !== ":-",
      });
    }
  }
  return usage;
}

/**
 * 取某个顶层块（`volumes:` / `env_file:`）的直接子行；只够本文件用，按缩进判定块边界，不追求通用 YAML 解析。
 * 为什么不用 YAML 库：`yaml` 只是 `packages/workflow-engine` 的依赖，scripts 侧引用它等于新增依赖。
 */
function blockEntries(compose: string, blockKey: string): string[] {
  const lines = compose.split("\n");
  const entries: string[] = [];
  lines.forEach((line, index) => {
    const head = new RegExp(`^(\\s*)${blockKey}:\\s*$`).exec(line);
    if (head?.[1] === undefined) return;
    const blockIndent = head[1].length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const current = lines[cursor] ?? "";
      const trimmed = current.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (current.length - current.trimStart().length <= blockIndent) break;
      entries.push(trimmed);
    }
  });
  return entries;
}

/** `volumes:` 里的挂载源（`- src:dst` 短式与 `source: src` 长式）；命名卷的短式（`- data:/x`）在这里也算源，不越界即可。 */
function volumeSources(compose: string): string[] {
  const sources: string[] = [];
  for (const entry of blockEntries(compose, "volumes")) {
    const longForm = /^(type|source|target|read_only|consistency):\s*(\S+)$/.exec(entry);
    if (longForm?.[1] !== undefined) {
      if (longForm[1] === "source") sources.push(longForm[2] ?? "");
      continue;
    }
    const shortForm = /^-\s*(\S+)/.exec(entry);
    if (shortForm?.[1] !== undefined) sources.push((shortForm[1].split(":")[0] ?? "").replace(/^["']|["']$/g, ""));
  }
  return sources;
}

/** `volumes:` 里的挂载目标（容器内路径），口径与 {@link volumeSources} 对称。 */
function mountTargets(compose: string): string[] {
  const targets: string[] = [];
  for (const entry of blockEntries(compose, "volumes")) {
    const longForm = /^(type|source|target|read_only|consistency):\s*(\S+)$/.exec(entry);
    if (longForm?.[1] !== undefined) {
      if (longForm[1] === "target") targets.push(longForm[2] ?? "");
      continue;
    }
    const shortForm = /^-\s*(\S+)/.exec(entry);
    const parts = (shortForm?.[1] ?? "").replace(/^["']|["']$/g, "").split(":");
    if (parts.length >= 2 && parts[1] !== undefined) targets.push(parts[1]);
  }
  return targets;
}

/**
 * 按 `services:` 下的一级子键切出各服务块。缩进由文件自己决定（`docker/workflow/` 是 2 空格、其余目录是 4 空格），
 * 因此这里先探到第一个服务名所在的缩进，再以它为准；只够本文件用，不追求通用 YAML 解析。
 */
function serviceBlocks(compose: string): Map<string, string[]> {
  const lines = compose.split("\n");
  const blocks = new Map<string, string[]>();
  const headIndex = lines.findIndex((line) => /^\s*services:\s*$/.test(line));
  if (headIndex < 0) return blocks;
  let serviceIndent = -1;
  let current: string | undefined;
  for (let index = headIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (serviceIndent < 0) serviceIndent = indent;
    if (indent < serviceIndent) break;
    if (indent === serviceIndent) {
      const name = /^([a-z][a-z0-9_-]*):\s*$/.exec(line.trim())?.[1];
      if (name === undefined) break;
      current = name;
      blocks.set(name, []);
      continue;
    }
    if (current !== undefined) blocks.get(current)?.push(line);
  }
  return blocks;
}

/** 服务里声明的**容器内**绝对路径：`*_PATH` / `*_DIR` 类环境变量的取值。 */
function containerPathValues(block: readonly string[]): string[] {
  const values: string[] = [];
  for (const line of block) {
    if (/^\s*#/.test(line)) continue;
    const matched = /^\s+[A-Z_]*?(?:PATH|DIR)[A-Z_]*:\s*(\/[^\s#]*)/.exec(line);
    if (matched?.[1] !== undefined) values.push(matched[1].replace(/["']/g, ""));
  }
  return values;
}

/** `env_file:` 的取值：`- .env` 与 `- path: .env` 两种写法（后者用于带 `required:` 的映射形式）。 */
function envFilePaths(compose: string): string[] {
  const paths: string[] = [];
  for (const entry of blockEntries(compose, "env_file")) {
    const stripped = entry.replace(/^-\s*/, "");
    const mapped = /^([a-z_]+):\s*(\S+)$/.exec(stripped);
    if (mapped?.[1] === "path") paths.push(mapped[2] ?? "");
    else if (mapped?.[1] !== undefined) continue;
    else paths.push(stripped.replace(/^["']|["']$/g, ""));
  }
  return paths;
}

/** 构建上下文的取值（`build.context`）。 */
function buildContexts(compose: string): string[] {
  return [...compose.matchAll(/^\s*context:\s*(\S+)\s*$/gm)].map((matched) => matched[1] ?? "");
}

/**
 * 允许越出本目录的引用：都是**数据与构建**形态，不是配置依赖，且各自写在 README 里。
 * 新增条目必须回答「为什么不能落在本目录内」——否则独立部署会把交付面重新绑回本仓的目录结构。
 */
const ALLOWED_OUTSIDE_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  // 无发布镜像，必须从源码构建，构建上下文只能是仓库根（README「前置条件」）。
  "sandbox-dsh": ["../../"],
  // 本地开发时容器内 agent 与宿主共用同一份 workspaces，避免文件分裂；独立节点机器上应换成本机路径（README）。
  "sandbox-peri": ["../../workspaces"],
};

// 组件目录清单非空是本文件其余判定的前提：目录发现写得不对时，后面的断言会「零违规」地假通过。
test("docker/ 下的组件目录都带 docker-compose.yml 且被本文件采集到", () => {
  expect(components.length).toBeGreaterThan(10);
  expect(components.map((component) => component.name)).toContain("main");
});

// 手写模板目录清单非空：口径差异（生成物模板不走「有效赋值行」判定）不能把范围整片吃掉。
test("手写 .env.example 的组件目录清单非空", () => {
  const handwritten = components.filter((component) => !GENERATED_TEMPLATE_DIRECTORIES.has(component.name));
  expect(handwritten.length).toBeGreaterThan(10);
  expect(handwritten.map((component) => component.name)).not.toContain("main");
});

// `${VAR:?}` 是 compose 的必填插值：目标机上唯一的取值来源是该目录 `.env`，模板必须给出**有效赋值行**。
test("compose 的必填插值键在本目录 .env.example 里是有效赋值行", () => {
  const offenders: string[] = [];
  let requiredKeyCount = 0;
  for (const component of components) {
    if (GENERATED_TEMPLATE_DIRECTORIES.has(component.name)) continue;
    const activeKeys = activeAssignmentKeys(component.envTemplate);
    for (const [key, usage] of interpolationUsage(component.compose)) {
      if (!usage.required) continue;
      requiredKeyCount += 1;
      if (!activeKeys.has(key)) offenders.push(`${component.name}: ${key}`);
    }
  }
  expect(requiredKeyCount).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

// 无缺省值的插值键同样必须能从本目录取得：`.env.example` 里没有的键只能靠调用方 export，独立部署会拿到空值。
test("compose 中无缺省值的插值键都能从本目录 .env.example 取得", () => {
  const offenders: string[] = [];
  for (const component of components) {
    if (GENERATED_TEMPLATE_DIRECTORIES.has(component.name)) continue;
    const activeKeys = activeAssignmentKeys(component.envTemplate);
    for (const [key, usage] of interpolationUsage(component.compose)) {
      if (usage.undefaulted && !activeKeys.has(key)) offenders.push(`${component.name}: ${key}`);
    }
  }
  expect(offenders).toEqual([]);
});

// `env_file` 指向目录外时，「拷走这个目录」就不再等价：那句 `.env` 会跟着落到别的目录上。
test("compose 的 env_file 只指向本目录", () => {
  const offenders: string[] = [];
  for (const component of components) {
    for (const path of envFilePaths(component.compose)) {
      if (path !== ".env" && path !== "./.env") offenders.push(`${component.name}: ${path}`);
    }
  }
  expect(offenders).toEqual([]);
});

// 编排声明了容器内数据落点（`*_PATH` / `*_DIR` 的绝对路径取值）就必须有对应挂载：两者都写在同一个文件里，
// 少一行 `volumes:` 等于把数据写到容器可写层——容器一重建就丢，且目录不存在时进程直接启动失败。
// 真实回退：`docker/opensandbox-cluster` 的命名卷被删掉后没换成 bind，`DATABASE_PATH: /data/…` 无挂载，
// 服务以 SQLITE_CANTOPEN 无限重启。
// 只认**不加引号**的取值：真实数据落点都这么写；加引号的同类键在现有编排里是 URL 前缀（litellm 的
// SERVER_ROOT_PATH），按文件路径判定会误报。
test("编排声明的容器内数据路径都落在挂载目标上", () => {
  const offenders: string[] = [];
  let pathCount = 0;
  for (const component of components) {
    for (const [service, block] of serviceBlocks(component.compose)) {
      const targets = mountTargets(block.join("\n")).map((target) => target.replace(/\/+$/, ""));
      for (const value of containerPathValues(block)) {
        pathCount += 1;
        const covered = targets.some((target) => value === target || value.startsWith(`${target}/`));
        if (!covered) offenders.push(`${component.name}/${service}: ${value}`);
      }
    }
  }
  expect(pathCount).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

// 绝对路径与 `..` 都让交付面失效：绝对路径绑死构建机，`..` 要求仓库目录结构保持不变。
test("compose 的挂载源与构建上下文不越出本目录（例外见 ALLOWED_OUTSIDE_REFERENCES）", () => {
  const offenders: string[] = [];
  for (const component of components) {
    const allowed = ALLOWED_OUTSIDE_REFERENCES[component.name] ?? [];
    for (const reference of [...volumeSources(component.compose), ...buildContexts(component.compose)]) {
      const escapes = reference.startsWith("/") || reference.split("/").includes("..");
      if (escapes && !allowed.includes(reference)) offenders.push(`${component.name}: ${reference}`);
    }
  }
  expect(offenders).toEqual([]);
});

// 例外清单本身不能残留：条目所指的引用一旦消失，清单会静默掩盖同目录下新出现的越界写法。
test("越界引用的例外清单不残留已不存在的条目", () => {
  const stale: string[] = [];
  for (const [name, references] of Object.entries(ALLOWED_OUTSIDE_REFERENCES)) {
    const component = components.find((candidate) => candidate.name === name);
    if (component === undefined) {
      stale.push(`${name}: 组件目录不存在`);
      continue;
    }
    const present = [...volumeSources(component.compose), ...buildContexts(component.compose)];
    for (const reference of references) {
      if (!present.includes(reference)) stale.push(`${name}: ${reference}`);
    }
  }
  expect(stale).toEqual([]);
});
