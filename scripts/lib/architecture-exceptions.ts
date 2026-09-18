/**
 * 架构例外台账的加载与校验。
 *
 * 台账是**唯一**允许登记存量边界违规的地方：条目精确到「规则 + 来源包 + 目标包」，必须带
 * 所属任务号与移除条件。门禁只阻断未登记的违规，阶段末台账必须清空
 * （见 ce-ee-engineering-standards §10.7.4「未登记依赖为零」）。
 *
 * 禁止使用通配：`@fenix/agent-runtime -> packages/resources/*` 这类条目会让整类边界静默
 * 失效，因此校验拒绝包含 `*` 的包字段。
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";

/** 台账条目；`owner` 与 `removeWhen` 缺失视为门禁自身错误。 */
const architectureExceptionSchema = z.strictObject({
  rule: z.string().min(1),
  from: z
    .string()
    .min(1)
    .refine((value) => !value.includes("*"), "from 不得使用通配"),
  to: z
    .string()
    .min(1)
    .refine((value) => !value.includes("*"), "to 不得使用通配"),
  owner: z.string().min(1),
  removeWhen: z.string().min(1),
  rationale: z.string().min(1),
});

const architectureExceptionFileSchema = z.strictObject({
  // JSON 不能写注释，但台账需要一处解释字段语义与 owner 取值的地方，否则维护者只能翻文档。
  _comment: z.array(z.string()).optional(),
  /**
   * 手写注册表冻结基线：`apps/server/src/main.ts` 当前直接导入的 `@fenix/*` 包名。
   *
   * 它不是「包 A → 包 B」的边界边，而是一份现状快照，因此不放进 `exceptions`——放进去会污染
   * 台账的「不再违规即删除」语义。1.5 把宿主切换到 `bootstrapServerAssembly` 后，该字段与
   * `no-new-handwritten-registry` 规则一并删除。
   */
  handwrittenRegistryBaseline: z.array(z.string().min(1)).optional(),
  exceptions: z.array(architectureExceptionSchema),
});

export type ArchitectureException = z.infer<typeof architectureExceptionSchema>;

/** 违规指纹：同一规则下同一对包只登记一次，与涉及的文件数量无关。 */
export function exceptionFingerprint(rule: string, from: string, to: string): string {
  return `${rule} ${from} ${to}`;
}

/** 台账默认位置。 */
export const ARCHITECTURE_EXCEPTIONS_PATH = "scripts/architecture/exceptions.json";

/** 加载后的台账；`exceptions` 以指纹为键，`handwrittenRegistryBaseline` 是手写注册表冻结快照。 */
export interface ArchitectureLedger {
  readonly exceptions: ReadonlyMap<string, ArchitectureException>;
  readonly handwrittenRegistryBaseline: ReadonlySet<string>;
}

const EMPTY_LEDGER: ArchitectureLedger = { exceptions: new Map(), handwrittenRegistryBaseline: new Set() };

/**
 * 读取并校验台账。
 *
 * 指纹重复或格式非法都会直接抛错，避免台账出现「看起来有登记、实际不生效」的条目。
 *
 * 台账文件缺失时返回空台账而不是报错：门禁的行为夹具里不存在台账，而此时「没有任何已登记例外」
 * 恰好是正确的语义——所有违规都按新增处理。这个降级方向是更严格的一侧，不会放宽任何边界。
 */
export async function loadArchitectureLedger(
  repositoryRoot: string,
  relativePath: string = ARCHITECTURE_EXCEPTIONS_PATH,
): Promise<ArchitectureLedger> {
  let source: string;
  try {
    source = await readFile(resolve(repositoryRoot, relativePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_LEDGER;
    throw error;
  }

  const parsed = architectureExceptionFileSchema.safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new Error(`架构例外台账格式非法: ${relativePath}`, { cause: parsed.error });
  }

  const byFingerprint = new Map<string, ArchitectureException>();
  for (const exception of parsed.data.exceptions) {
    const fingerprint = exceptionFingerprint(exception.rule, exception.from, exception.to);
    if (byFingerprint.has(fingerprint)) {
      throw new Error(`架构例外台账重复登记: ${fingerprint}`);
    }
    byFingerprint.set(fingerprint, exception);
  }

  return {
    exceptions: byFingerprint,
    handwrittenRegistryBaseline: new Set(parsed.data.handwrittenRegistryBaseline ?? []),
  };
}
