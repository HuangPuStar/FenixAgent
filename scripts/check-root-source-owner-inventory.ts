import {
  AmbiguousRootOwnerRuleError,
  getMostSpecificRootOwnerRule,
  RETAINED_HOST_TEST_RATIONALES,
  ROOT_OWNER_RULES,
  type RootOwner,
  type RootOwnerRule,
} from "./root-source-owner-rules";

/** 单个源码文件的最终归属。 */
export interface RootOwnerAssignment {
  file: string;
  rule: RootOwnerRule;
  targetPath: string | null;
  consumers: readonly string[];
  testOwner: string;
  hostRationale?: string;
}

/** 按迁移任务和最终 owner 汇总的文件数量。 */
export interface RootOwnerSummary {
  task: RootOwnerRule["task"];
  owner: RootOwner;
  count: number;
}

/** 一个无法由最长前缀唯一选择的路径及其竞争规则。 */
export interface RootOwnerAmbiguity {
  file: string;
  prefixes: string[];
}

/** 根目录源码归属审计的完整结果。 */
export interface RootOwnerAudit {
  files: string[];
  assignments: RootOwnerAssignment[];
  unowned: string[];
  ambiguous: RootOwnerAmbiguity[];
  unsafeDeletes: string[];
  summary: RootOwnerSummary[];
}

type RootOwnerRuleSelector = (path: string) => RootOwnerRule | undefined;

const INVENTORY_DOCUMENT_PATH = "docs/arch/root-source-owner-inventory.md";
const ROOT_SOURCE_DIRECTORIES = ["src", "web"] as const;
const REPOSITORY_SOURCE_DIRECTORIES = ["apps", "packages", "src", "web"] as const;
const IMPORTER_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
let directImporterIndex: Promise<Map<string, string[]>> | undefined;

/** delete 只允许清理已确认的 Finder 元数据或前端构建产物。 */
function isAllowedDeletePath(path: string): boolean {
  return path === "src/.DS_Store" || path.startsWith("web/dist/");
}

/** 用匹配规则的目标前缀替换原路径前缀，得到每个文件的精确迁移位置。 */
export function getRootOwnerTargetPath(file: string, rule: RootOwnerRule): string | null {
  if (rule.owner === "delete") return null;
  return `${rule.targetPrefix}${file.slice(rule.prefix.length)}`;
}

/** 为未拆分的 host 测试保留其直接验证的宿主领域依据。 */
function getHostTestRationale(file: string, owner: RootOwner): string | undefined {
  if (owner !== "apps-server" || !file.includes("__tests__/")) return;
  const rationale = RETAINED_HOST_TEST_RATIONALES[file];
  if (!rationale) throw new Error(`缺少 retained host test rationale：${file}`);
  return rationale;
}

/** 返回 delete 规则或实际分配超出允许清理范围时的安全诊断。 */
export function findUnsafeDeleteDiagnostics(
  assignments: readonly RootOwnerAssignment[],
  rules: readonly RootOwnerRule[] = ROOT_OWNER_RULES,
): string[] {
  const unsafeRuleDiagnostics = rules.flatMap((rule) => {
    return rule.owner === "delete" && !isAllowedDeletePath(rule.prefix)
      ? [`delete rule ${rule.prefix} 不在 delete allowlist 内`]
      : [];
  });
  const unsafeAssignmentDiagnostics = assignments.flatMap(({ file, rule }) => {
    return rule.owner === "delete" && !isAllowedDeletePath(file)
      ? [`delete assignment ${file} 不在 delete allowlist 内`]
      : [];
  });

  return [...unsafeRuleDiagnostics, ...unsafeAssignmentDiagnostics];
}

/** 列出给定根目录下的全部文件，并转换为稳定的 POSIX 路径。 */
export async function listRootSourceFiles(roots: readonly string[] = ROOT_SOURCE_DIRECTORIES): Promise<string[]> {
  const files = new Set<string>();

  for (const root of roots) {
    const pattern = `${root}/**/*`;
    for await (const path of new Bun.Glob(pattern).scan({ dot: true, onlyFiles: true })) {
      files.add(path.replaceAll("\\", "/"));
    }
  }

  return [...files].sort();
}

/** 从仓库源码中读取静态 import/export，构造当前文件的真实直接消费者索引。 */
async function buildDirectImporters(): Promise<Map<string, string[]>> {
  if (directImporterIndex) return directImporterIndex;
  directImporterIndex = buildDirectImportersUncached();
  return directImporterIndex;
}

/** 实际构建 import 索引；以 Promise 缓存保证同一审计进程只扫描一次。 */
async function buildDirectImportersUncached(): Promise<Map<string, string[]>> {
  const files: string[] = [];
  for (const root of REPOSITORY_SOURCE_DIRECTORIES) {
    for await (const file of new Bun.Glob(`${root}/**/*`).scan({ dot: true, onlyFiles: true })) {
      files.push(file);
    }
  }

  const knownFiles = new Set(files);
  const importers = new Map<string, Set<string>>();
  for (const importer of files) {
    if (!IMPORTER_EXTENSIONS.some((extension) => importer.endsWith(extension))) continue;
    const source = await Bun.file(importer).text();
    for (const specifier of source.matchAll(
      /(?:import|export)\s*(?:[^"']*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g,
    )) {
      const target = resolveImportedModule(importer, specifier[1] ?? specifier[2] ?? "", knownFiles);
      if (!target) continue;
      const targetImporters = importers.get(target) ?? new Set<string>();
      targetImporters.add(importer);
      importers.set(target, targetImporters);
    }
  }

  return new Map([...importers].map(([file, directImporters]) => [file, [...directImporters].sort()]));
}

/** 解析能指向根 src/web 文件的相对路径与项目别名；外部 package 不属于本清单。 */
function resolveImportedModule(
  importer: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  let base: string | undefined;
  if (specifier.startsWith(".")) {
    const lastSlash = importer.lastIndexOf("/");
    base = `${importer.slice(0, lastSlash + 1)}${specifier}`;
  } else if (specifier.startsWith("@server/")) {
    base = `src/${specifier.slice("@server/".length)}`;
  } else if (specifier.startsWith("@/src/")) {
    base = `web/src/${specifier.slice("@/src/".length)}`;
  } else if (specifier.startsWith("@/components/")) {
    base = `web/components/${specifier.slice("@/components/".length)}`;
  }
  if (!base) return;

  const parts: string[] = [];
  for (const segment of base.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const normalized = parts.join("/");
  const candidates = [
    normalized,
    ...IMPORTER_EXTENSIONS.map((extension) => `${normalized}${extension}`),
    ...IMPORTER_EXTENSIONS.map((extension) => `${normalized}/index${extension}`),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

/** 由当前 import 图记录某个文件的真实消费者，以及实际覆盖它的测试入口。 */
function getAssignmentMetadata(
  file: string,
  rule: RootOwnerRule,
  directImporters: ReadonlyMap<string, readonly string[]>,
): Pick<RootOwnerAssignment, "consumers" | "testOwner"> {
  if (rule.owner === "delete") {
    return { consumers: ["删除：非源码产物"], testOwner: "scripts/__tests__/root-source-owner-inventory.test.ts" };
  }
  const importers = directImporters.get(file) ?? [];
  const productionImporters = importers.filter((importer) => !importer.includes("/__tests__/"));
  const consumers = productionImporters.length
    ? productionImporters
    : [`无仓内生产 importer；RMD-${rule.task.slice(4)} 接线时确认 ${rule.targetRoot} 公开入口`];
  const testImporters = importers.filter((importer) => importer.includes("/__tests__/"));
  const testOwner = file.includes("/__tests__/")
    ? file
    : testImporters.length
      ? testImporters.join(", ")
      : `无直接专项测试；${rule.task} 迁移验收`;
  return { consumers, testOwner };
}

/** 审计给定或当前工作树的根目录源码归属。 */
export async function auditRootSourceOwners(
  files?: readonly string[],
  selectRule: RootOwnerRuleSelector = getMostSpecificRootOwnerRule,
): Promise<RootOwnerAudit> {
  const auditedFiles = files ? [...files] : await listRootSourceFiles();
  const directImporters = await buildDirectImporters();
  const assignments: RootOwnerAssignment[] = [];
  const unowned: string[] = [];
  const ambiguous: RootOwnerAmbiguity[] = [];

  for (const file of auditedFiles) {
    try {
      const rule = selectRule(file);
      if (rule) {
        const metadata = getAssignmentMetadata(file, rule, directImporters);
        assignments.push({
          file,
          rule,
          targetPath: getRootOwnerTargetPath(file, rule),
          ...metadata,
          hostRationale: getHostTestRationale(file, rule.owner),
        });
      } else {
        unowned.push(file);
      }
    } catch (error) {
      if (error instanceof AmbiguousRootOwnerRuleError) {
        ambiguous.push({ file, prefixes: error.competingRules.map((rule) => rule.prefix) });
      } else {
        throw error;
      }
    }
  }

  const summaryCounts = new Map<string, RootOwnerSummary>();
  for (const { rule } of assignments) {
    const key = `${rule.task}\0${rule.owner}`;
    const current = summaryCounts.get(key) ?? { task: rule.task, owner: rule.owner, count: 0 };
    current.count++;
    summaryCounts.set(key, current);
  }

  return {
    files: auditedFiles,
    assignments,
    unowned,
    ambiguous,
    unsafeDeletes: findUnsafeDeleteDiagnostics(assignments),
    summary: [...summaryCounts.values()].sort(
      (left, right) => left.task.localeCompare(right.task) || left.owner.localeCompare(right.owner),
    ),
  };
}

/** 比较期望和已提交的 Markdown 字节内容；不同步时返回可操作诊断。 */
export function compareRootOwnerInventoryMarkdown(expected: string, actual: string): string | undefined {
  return expected === actual
    ? undefined
    : `根目录源码归属清单不同步：请运行 bun run scripts/check-root-source-owner-inventory.ts --markdown > ${INVENTORY_DOCUMENT_PATH}`;
}

/** 将审计结果渲染为可提交至架构文档的完整 Markdown 清单。 */
export function renderRootOwnerInventoryMarkdown(audit: RootOwnerAudit): string {
  const summaryRows = audit.summary.map((entry) => `| ${entry.task} | ${entry.owner} | ${entry.count} |`).join("\n");
  const ruleRows = ROOT_OWNER_RULES.map(
    (rule) =>
      `| \`${rule.prefix}\` | ${rule.owner === "delete" ? "删除" : rule.targetPrefix} | ${rule.owner} | ${rule.task} |`,
  ).join("\n");
  const assignmentRows = [...audit.assignments]
    .sort((left, right) => left.file.localeCompare(right.file))
    .map(
      (assignment) =>
        `| \`${assignment.file}\` | ${assignment.targetPath ? `\`${assignment.targetPath}\`` : "删除"} | ${assignment.rule.owner} | ${assignment.consumers.join("; ")} | ${assignment.testOwner} | ${assignment.rule.task} |`,
    )
    .join("\n");
  const retainedHostTestRows = audit.assignments
    .filter(
      (assignment) =>
        assignment.rule.owner === "apps-server" &&
        (assignment.file.startsWith("src/__tests__/") || assignment.file.startsWith("web/src/__tests__/")),
    )
    .sort((left, right) => left.file.localeCompare(right.file))
    .map((assignment) => `| \`${assignment.file}\` | ${assignment.hostRationale} |`)
    .join("\n");

  return `# 根目录源码最终归属清单

此文件由 \`bun run scripts/check-root-source-owner-inventory.ts --markdown > docs/arch/root-source-owner-inventory.md\` 生成。请修改规则后重新生成，不要手工编辑。

> **历史快照**：「完整规则」表是 RMD-01 ~ RMD-09 的**声明式迁移规则**（\`Prefix\` → \`Target prefix\` / owner / 任务），记录各批次当时的判定与落点。根目录 \`src/\`、\`web/\` 迁移后已不存在（审计 \`files=0\`），且部分目标前缀在后续任务中被再次移动，故表中路径**不作为现状依据**；当前落位以各包内代码与 \`docs/design/ce-ee-refactoring/review/task-1.6-web-shell.md\` 为准。

## 审计结果

- 文件总数：${audit.files.length}
- 未归属：${audit.unowned.length}
- 歧义：${audit.ambiguous.length}
- 不安全删除：${audit.unsafeDeletes.length}

## 按任务和 owner 汇总

| 任务 | Owner | 文件数 |
| --- | --- | ---: |
${summaryRows}

RMD-01、RMD-02、RMD-03、RMD-04、RMD-05、RMD-06、RMD-07、RMD-08、RMD-09 按上表顺序执行。\`delete\` 仅允许 \`src/.DS_Store\` 与 \`web/dist/\` 下的构建产物。

## 完整规则

| Prefix | Target prefix | Owner | 任务 |
| --- | --- | --- | --- |
${ruleRows}

## 逐文件映射

| 原路径 | 明确目标路径 | Owner | 主要消费者 | 测试目标 | RMD 批次 |
| --- | --- | --- | --- | --- | --- |
${assignmentRows}

## RMD-07 retained host test rationale

| 保留的 host 测试 | 依据 |
| --- | --- |
${retainedHostTestRows}`;
}

/** 输出所有无法由汇总数字定位的审计失败项。 */
function printAuditDiagnostics(audit: RootOwnerAudit): void {
  for (const file of audit.unowned) {
    console.error(`unowned=${file}`);
  }
  for (const ambiguity of audit.ambiguous) {
    console.error(`ambiguous=${ambiguity.file} prefixes=${ambiguity.prefixes.join(",")}`);
  }
  for (const diagnostic of audit.unsafeDeletes) {
    console.error(`unsafe-delete=${diagnostic}`);
  }
}

/** 执行命令行清单审计，并以可供 CI 解析的摘要退出。 */
async function main(): Promise<void> {
  const audit = await auditRootSourceOwners();
  const markdown = process.argv.includes("--markdown");
  const check = process.argv.includes("--check") || !markdown;
  const renderedMarkdown = renderRootOwnerInventoryMarkdown(audit);
  const hasAuditFailures = audit.unowned.length > 0 || audit.ambiguous.length > 0 || audit.unsafeDeletes.length > 0;

  if (markdown) {
    process.stdout.write(renderedMarkdown);
  } else {
    console.log(`files=${audit.files.length} unowned=${audit.unowned.length} ambiguous=${audit.ambiguous.length}`);
    for (const entry of audit.summary) {
      console.log(`${entry.task} ${entry.owner}=${entry.count}`);
    }
  }

  if (hasAuditFailures) {
    printAuditDiagnostics(audit);
    process.exitCode = 1;
  }

  if (check) {
    const document = Bun.file(INVENTORY_DOCUMENT_PATH);
    const existingMarkdown = (await document.exists()) ? await document.text() : "";
    const diagnostic = compareRootOwnerInventoryMarkdown(renderedMarkdown, existingMarkdown);
    if (diagnostic) {
      console.error(diagnostic);
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  await main();
}
