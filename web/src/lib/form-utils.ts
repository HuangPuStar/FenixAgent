import { z } from "zod";

/**
 * 创建名称字段的 zod schema（用于 Agent/Skill/Provider 的 ID/名称校验）
 * - 允许小写字母、数字、单连字符
 * - 长度 1-64
 */
export function nameSchema(opts?: { label?: string }) {
  const label = opts?.label ?? "Name";
  return z
    .string()
    .min(1, `${label} is required`)
    .max(64, `${label} must be at most 64 characters`)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${label} can only contain lowercase letters, digits, and hyphens`);
}

/**
 * 创建整数范围字段的 zod schema（用于步数等）
 */
export function intRangeSchema(opts: { label?: string; min?: number; max?: number }) {
  const label = opts.label ?? "Value";
  const min = opts.min ?? 1;
  const max = opts.max ?? 9999;
  return z
    .string()
    .transform((v, ctx) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be an integer`,
        });
        return z.NEVER;
      }
      return n;
    })
    .pipe(
      z
        .number()
        .int(`${label} must be an integer`)
        .min(min, `${label} must be between ${min} and ${max}`)
        .max(max, `${label} must be between ${min} and ${max}`),
    );
}

/**
 * 创建可选浮点范围字段的 zod schema（用于温度、Top P 等可选数值）
 * - 空字符串表示未填写（跳过验证）
 * - 非空时校验范围
 */
export function optionalFloatSchema(opts: { label?: string; min?: number; max?: number }) {
  const label = opts.label ?? "Value";
  const min = opts.min ?? 0;
  const max = opts.max ?? Infinity;
  return z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : parseFloat(v)))
    .pipe(
      z
        .number({ message: `${label} must be a number` })
        .min(min, `${label} must be between ${min} and ${max}`)
        .max(max, `${label} must be between ${min} and ${max}`)
        .optional(),
    );
}

/**
 * 创建非空字符串字段的 zod schema（用于 Skill 内容等必填文本）
 */
export function requiredStringSchema(opts?: { label?: string; max?: number }) {
  const label = opts?.label ?? "Content";
  const max = opts?.max ?? 65536;
  return z.string().min(1, `${label} is required`).max(max, `${label} must be at most ${max} characters`);
}

/**
 * 创建可选字符串字段的 zod schema（用于描述、许可证等选填文本）
 */
export function optionalStringSchema(opts?: { max?: number }) {
  const max = opts?.max ?? 65536;
  return z.string().max(max, `Must be at most ${max} characters`);
}

/**
 * 将 zod schema 解析结果转换为表单错误消息数组
 * - 供非 react-hook-form 场景手动调用验证
 * - 返回 null 表示验证通过
 */
export function validateWithSchema<T>(schema: z.ZodType<T>, data: unknown): string[] | null {
  const result = schema.safeParse(data);
  if (result.success) return null;
  return result.error.issues.map((issue) => issue.message);
}

/**
 * 创建 zod resolver 供 react-hook-form 的 useForm 使用
 * - 此函数是对 @hookform/resolvers/zod 的薄包装，统一导入路径
 */
export { zodResolver } from "@hookform/resolvers/zod";
