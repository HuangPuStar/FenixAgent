/**
 * 运行期配置解析（路径、监听地址、只读文件白名单）。
 *
 * 定位：这是**只读**的工具类服务，唯一的输入是仓库里的 docker 编排文件与说明文档。
 * 安全口径（三条都必须保留）：
 *   1. 默认只绑回环，且只有显式设置 host 才对外监听（README 有警告）。
 *   2. 文件读取只认「扫描期建立的 id → 绝对路径」索引，任何未索引的路径都拒绝，从根上避免路径穿越。
 *   3. `.env`、`*.key`、`*.pem` 一类可能含密钥的文件永不进索引（见 `files.ts` 的排除规则）。
 */

import { existsSync } from "node:fs";
import path from "node:path";

export type ExplorerConfig = {
  /** 仓库根（docker/ 的父目录），编排文件的相对路径都以它为基准展示 */
  repoRoot: string;
  /** docker/ 目录 */
  dockerDir: string;
  /** 顶层编排文件（仓库根 docker-compose.yml） */
  rootComposeFile: string;
  /** 部署配置文件（docker/deploy.env，可能不存在，缺失时回退 .example） */
  deployConfigFile: string;
  /** 前端静态资源目录 */
  publicDir: string;
  /** 监听地址与端口 */
  host: string;
  port: number;
  /** 与编排关系密切、但不在 docker/ 下的文件（顶层文档、部署入口脚本） */
  extraFiles: string[];
};

const DEFAULT_PORT = 7411;
const DEFAULT_HOST = "127.0.0.1";

/** 解析环境变量；缺省值服务本地开发，不猜部署形态。 */
export function resolveConfig(env: Record<string, string | undefined> = Bun.env): ExplorerConfig {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const dockerDir = path.join(repoRoot, "docker");
  const host = env.FENIX_COMPOSE_EXPLORER_HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.FENIX_COMPOSE_EXPLORER_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`FENIX_COMPOSE_EXPLORER_PORT 不是合法端口：${rawPort}`);
  }

  const deployEnv = path.join(dockerDir, "deploy.env");
  const deployExample = path.join(dockerDir, "deploy.env.example");

  return {
    repoRoot,
    dockerDir,
    rootComposeFile: path.join(repoRoot, "docker-compose.yml"),
    deployConfigFile: existsSync(deployEnv) ? deployEnv : deployExample,
    publicDir: path.join(import.meta.dir, "../public"),
    host,
    port,
    extraFiles: [
      path.join(repoRoot, "docker-compose.yml"),
      path.join(repoRoot, ".env.example"),
      path.join(repoRoot, "Dockerfile"),
      path.join(dockerDir, "deploy.sh"),
      path.join(dockerDir, "deploy.env"),
      path.join(dockerDir, "deploy.env.example"),
      path.join(dockerDir, "lib/config.sh"),
      path.join(repoRoot, "docs/operations/docker-topology.md"),
    ],
  };
}

/** 是否处于「对外监听」形态：用于启动日志里的显式提示。 */
export function isPubliclyExposed(config: ExplorerConfig): boolean {
  return config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1";
}
