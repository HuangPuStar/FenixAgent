// 发布步骤的**计划与执行**：把「DDL 迁移 → 数据迁移 → 容器部署」排成有序步骤，失败即停并给出定位与重跑说明。
//
// 与 `release.ts` 分工：那边读 profile、校验声明、生成/比对部署产物（只读或写产物），这里只把已经确定的外部
// 命令排成序列并执行。分开的理由与 `deploy-artifacts.ts` 相同——「步骤顺序错了」与「产物内容不对」是两类
// 失败，混在一起会让定位成本翻倍；而且步骤序列必须能被单测用假执行器直接断言，真连数据库、真起容器不在
// 单元测试的成本范围内。
//
// 三条不变量：
// - **不复制权威入口**：迁移两步调用仓库既有入口（`scripts/migrate.ts` / `db/data-migration-runner.ts`）；
//   容器部署的命令文本由生成的部署视图（`deploy/manifests/profiles/<profile>.json` 的 `compose.up`）给出——
//   在脚本里再拼一份命令，改了 profile 生成规则也不会同步；
// - **失败即停**：前一步非零退出就不进入下一步，失败输出必须回答「哪一步、为什么、能不能直接重跑」；
// - **本文件不读写部署产物**：文件 IO 与字节比对留在 `release.ts`，这里只管命令序列与退出码。

/** 发布步骤的定位信息。失败输出必须能回答「在哪一步失败」，因此标题与重跑说明与命令同等重要。 */
export interface ReleaseStepDescriptor {
  /** 稳定标识；用例与日志按它对齐步骤，不靠标题字符串。 */
  readonly id: string;
  /** 人类可读的步骤名。 */
  readonly title: string;
  /** 该步骤失败后的可重跑性：是否幂等、重跑会不会重复执行副作用、需要先补什么。 */
  readonly rerun: string;
}

/** 一条可执行的发布步骤：描述符 + 完整 argv。 */
export interface ReleaseStep extends ReleaseStepDescriptor {
  /** 命令与参数分开给出，不拼 shell 字符串：引号与空格在不同 shell 下的解释不一致，而这里必须可复现。 */
  readonly command: readonly string[];
}

/** 执行一步并返回退出码（0 = 成功）。注入替身即可在不触数据库、不起容器的前提下断言序列与失败即停。 */
export type ReleaseStepRunner = (step: ReleaseStep) => Promise<number>;

/** 步骤输出端口；与 `db/data-migration-runner.ts` 的 deps 同形，便于用例收拢断言。 */
export interface ReleaseStepIo {
  readonly log: (message: string) => void;
  readonly logError: (message: string) => void;
}

/**
 * 步骤失败：调用方据此输出「在哪一步失败、失败原因、可重跑性」，不需要再解析文本。
 *
 * 携带 `remaining`（失败时尚未执行的步骤）是因为「未进入下一步」本身是发布结论的一部分：它说明运行环境
 * 被本次发布改到哪一步为止，操作者据此判断能不能直接重跑整条命令。
 */
export class ReleaseStepError extends Error {
  readonly step: ReleaseStepDescriptor;
  readonly reason: string;
  readonly remaining: readonly ReleaseStepDescriptor[];
  /** 步骤序号：部署面校验是第 0 步（不启容器、不读数据库），命令步骤从 1 开始。 */
  readonly position: number;

  constructor(
    step: ReleaseStepDescriptor,
    reason: string,
    remaining: readonly ReleaseStepDescriptor[],
    position: number,
  ) {
    super(`第 ${position} 步「${step.title}」失败：${reason}`);
    this.name = "ReleaseStepError";
    this.reason = reason;
    this.remaining = remaining;
    this.position = position;
    this.step = step;
  }
}

/**
 * 部署面校验（第 0 步）的描述符。
 *
 * 它没有外部命令——校验是同一进程里的纯计算（读 profile、比对产物字节），所以不出现在 `buildReleaseSteps()`
 * 的返回值里；`release.ts` 在校验失败时用它构造同形的失败报告，让第 0 步与后续步骤的输出格式一致。
 */
export const DEPLOY_SURFACE_STEP: ReleaseStepDescriptor = {
  id: "verify-deploy-surface",
  title: "部署面校验",
  rerun: "只读声明与产物、不写任何文件；产物与声明不一致时先运行 `bun run release` 重新生成，再重跑本命令即可。",
};

/** 三步的描述符；命令部分见 `buildReleaseSteps()`——容器部署的命令文本只能来自部署视图。 */
const STEPS = {
  compose: {
    id: "compose-up",
    rerun:
      "`compose up -d` 是声明式收敛，已就绪的容器不会被重复创建；但它不会自动换镜像——升级到新版本要先把目标镜像拉到位，再重跑本命令。",
    title: "容器部署",
  },
  dataMigrate: {
    id: "data-migrate",
    rerun:
      "幂等：`data_migrate_record` 已有的迁移按记录跳过，修因后重跑即可收敛。必须与应用挂同一数据卷（含 `SKILL_DIR`），否则会留下「记录已落库、迁移写出的文件却读不到」的状态，而记录已写入会让重跑变成跳过。",
    title: "数据迁移",
  },
  ddlMigrate: {
    id: "ddl-migrate",
    rerun:
      "幂等：已应用的迁移由 Drizzle 的迁移记录跳过；缺 `DATABASE_URL` 时入口直接退出 1（不回退到源码默认连接串），补上环境变量后重跑即可。",
    title: "DDL 迁移",
  },
} as const satisfies Record<string, ReleaseStepDescriptor>;

/** 发布步骤的描述符（不含命令），顺序即执行顺序；失败报告的「未执行步骤」按它列出。 */
export function releaseStepDescriptors(): readonly ReleaseStepDescriptor[] {
  return [STEPS.ddlMigrate, STEPS.dataMigrate, STEPS.compose];
}

/**
 * 组装完整步骤序列。
 *
 * `composeUp` 由调用方从部署视图读出后原样传入——本函数不生成命令文本，只把它放进 argv 的最后一个位置。
 * 迁移两步写死在仓库既有入口上：它们是发布契约（`docs/operations/upgrade.md` §1）的一部分，不随 profile 变。
 */
export function buildReleaseSteps(composeUp: string): readonly ReleaseStep[] {
  return [
    { ...STEPS.ddlMigrate, command: ["bun", "run", "scripts/migrate.ts"] },
    { ...STEPS.dataMigrate, command: ["bun", "run", "run-data-migrations"] },
    // 部署命令由生成器产出（`docker compose -f … -f … up -d`），因此经 `sh -c` 执行而不是自行拆词。
    { ...STEPS.compose, command: ["sh", "-c", composeUp] },
  ];
}

/** 默认执行器：真起子进程，stdout/stderr 透传给操作者——迁移与 compose 的诊断原文比转述有用。 */
export function createReleaseStepRunner(): ReleaseStepRunner {
  return async (step) => {
    const child = Bun.spawn([...step.command], { stderr: "inherit", stdin: "inherit", stdout: "inherit" });
    return await child.exited;
  };
}

/**
 * 顺序执行步骤；前一步非零退出或无法执行即停。
 *
 * 返回值是**实际执行成功**的步骤，调用方据此输出通过结论；失败时抛 {@link ReleaseStepError}，其中
 * `remaining` 只包含确实没有执行的后续步骤。
 */
export async function runReleaseSteps(
  steps: readonly ReleaseStep[],
  runner: ReleaseStepRunner,
  io: ReleaseStepIo,
): Promise<readonly ReleaseStepDescriptor[]> {
  const executed: ReleaseStepDescriptor[] = [];

  for (const [index, step] of steps.entries()) {
    io.log(`[release] 第 ${index + 1} 步「${step.title}」：${step.command.join(" ")}`);

    let exitCode: number;
    try {
      exitCode = await runner(step);
    } catch (error) {
      throw new ReleaseStepError(step, `无法执行：${describeError(error)}`, steps.slice(index + 1), index + 1);
    }

    if (exitCode !== 0) {
      io.logError(`[release] 第 ${index + 1} 步「${step.title}」退出码 ${exitCode}。`);
      throw new ReleaseStepError(step, `退出码 ${exitCode}`, steps.slice(index + 1), index + 1);
    }

    executed.push(step);
  }

  return executed;
}

/**
 * 失败报告：在哪一步失败、失败原因、后续是否已执行、能不能直接重跑。
 *
 * 「后续未执行」是发布结论的一部分，不是修辞：发布任务失败时操作者要立刻知道运行环境被改到哪一步为止，
 * 才能判断能不能整条重跑。因此这里把剩余的步骤列出来，而不是只说「失败」。
 */
export function describeReleaseFailure(error: ReleaseStepError): readonly string[] {
  const remaining =
    error.remaining.length === 0
      ? "这是最后一步，后续没有未执行的步骤。"
      : `后续步骤未执行：${error.remaining.map((step) => `「${step.title}」`).join("、")}。`;

  return [
    `[release] 发布中止于第 ${error.position} 步「${error.step.title}」：${error.reason}`,
    `[release] ${remaining}`,
    `[release] 可重跑性：${error.step.rerun}`,
  ];
}

/** 错误文本：保留原始 message，非 Error 的抛出物按其字符串形态处理。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
