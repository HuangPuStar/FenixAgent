/**
 * CSS 注释清理：先扫描，后删除。
 *
 * 用法：
 * ```
 * bun run scripts/remove-css-comments.ts                      # 扫描：列出待删注释与统计，不修改文件
 * bun run scripts/remove-css-comments.ts --write              # 删除：移除注释并写回（默认保留工具指令）
 * bun run scripts/remove-css-comments.ts --write --include-directives   # 连 biome-ignore 等指令一起删
 * ```
 *
 * 默认保留**工具指令**注释（`biome-ignore` 等）：它们的作用不是记录说明，而是抑制 lint，
 * 删除会改变工具行为；确需全删时用 `--include-directives` 显式声明。
 *
 * 扫描范围是 `git ls-files "*.css"`——受版本控制的源码样式表；
 * dist / node_modules / .worktrees / tmp 等产物与副本目录天然不在其中。
 *
 * 注释定位与移除规则见 `scripts/lib/css-comments.ts`；本文件只负责
 * 遍历范围 → 调用核心 → 输出报告（与 `scripts/check-web-style.ts` 同构）。
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { type CssComment, isTightlyEmbeddedComment, removeCssComments, summarizeCssComment } from "./lib/css-comments";

const repositoryRoot = resolve(import.meta.dir, "..");

/** 工具指令型注释的特征：删除会使 lint / 构建工具的抑制或提示失效。 */
const TOOL_DIRECTIVE_PATTERN = /^\s*\/\*\s*(?:biome-ignore|stylelint|eslint|@ts-|prettier-ignore|@vite-ignore)/;

/** 列出受版本控制的 CSS 文件（仓库相对、POSIX、排序）。 */
function listTrackedCssFiles(root: string = repositoryRoot): string[] {
  const result = spawnSync("git", ["ls-files", "-z", "--", "*.css"], { cwd: root, encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`git ls-files 失败：${result.stderr?.trim() || `退出码 ${result.status}`}`);
  }

  return result.stdout.split("\0").filter(Boolean).sort();
}

/**
 * 打印某文件的注释清单。
 *
 * 标记：`[保留]` 条目不会在 `--write` 时删除；`[紧邻]` 条目两侧都紧贴非空白字符，
 * 删除存在 token 粘连与选择器关系变化的两难（见 `lib/css-comments.ts` 头部第 3 条），执行前需人工看一眼。
 */
function reportFile(
  relativePath: string,
  source: string,
  removal: { removed: CssComment[]; kept: CssComment[] },
): void {
  const suffix = removal.kept.length > 0 ? `，保留 ${removal.kept.length} 处指令` : "";
  console.log(`${relativePath}（删除 ${removal.removed.length} 处${suffix}）`);

  const print = (comment: CssComment, kept: boolean): void => {
    const tags = `${kept ? "[保留] " : ""}${isTightlyEmbeddedComment(source, comment) ? "[紧邻] " : ""}`;
    console.log(`  ${comment.line}: ${tags}${summarizeCssComment(comment)}`);
  };

  for (const comment of removal.kept) print(comment, true);
  for (const comment of removal.removed) print(comment, false);
}

/** 单次清理的统计口径。 */
interface CommentTally {
  scannedFiles: number;
  touchedFiles: number;
  removed: number;
  kept: number;
}

function accumulate(tally: CommentTally, removal: { removed: CssComment[]; kept: CssComment[] }): void {
  tally.touchedFiles += 1;
  tally.removed += removal.removed.length;
  tally.kept += removal.kept.length;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const includeDirectives = process.argv.includes("--include-directives");
  const keep = includeDirectives ? undefined : (comment: CssComment) => TOOL_DIRECTIVE_PATTERN.test(comment.text);
  const files = listTrackedCssFiles();

  console.log(write ? "CSS 注释清理（--write：删除并写回）" : "CSS 注释扫描（只读；执行删除请加 --write）");
  console.log(
    keep
      ? "保留策略：工具指令注释（biome-ignore 等）不删除；加 --include-directives 可一并删除\n"
      : "保留策略：工具指令注释一并删除\n",
  );

  const tally: CommentTally = { scannedFiles: files.length, touchedFiles: 0, removed: 0, kept: 0 };

  for (const relativePath of files) {
    const absolutePath = resolve(repositoryRoot, relativePath);
    const source = await Bun.file(absolutePath).text();
    const { output, removed, kept } = removeCssComments(source, { keep });

    if (removed.length === 0 && kept.length === 0) continue;

    if (write) {
      if (removed.length > 0) await Bun.write(absolutePath, output);
      const suffix = kept.length > 0 ? `，保留 ${kept.length} 处指令` : "";
      console.log(`  ${relativePath}  删除 ${removed.length} 处${suffix}`);
    } else {
      reportFile(relativePath, source, { removed, kept });
    }

    accumulate(tally, { removed, kept });
  }

  console.log("");
  console.log(
    write
      ? `已删除 ${tally.removed} 处注释（${tally.touchedFiles}/${tally.scannedFiles} 个文件）。`
      : `共 ${tally.removed + tally.kept} 处注释，分布在 ${tally.touchedFiles}/${tally.scannedFiles} 个文件。`,
  );

  if (tally.kept > 0) {
    console.log(
      write
        ? `保留 ${tally.kept} 处工具指令注释（需要全删时加 --include-directives）。`
        : `其中 ${tally.kept} 处是工具指令（[保留] 标记）：默认不删除，加 --include-directives 可一并删除。`,
    );
  }

  if (write) {
    console.log("下一步：`bun run format` 统一格式，`bun run build:web` 验证前端产物。");
  }
}

await main();
