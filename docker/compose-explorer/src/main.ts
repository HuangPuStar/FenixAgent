/**
 * 入口：扫描 → 解析 → 拓扑 → 启动只读服务。
 *
 * 用法：
 *   cd docker/compose-explorer && bun install   # 首次
 *   bun run start                               # 默认 http://127.0.0.1:7411
 *   FENIX_COMPOSE_EXPLORER_PORT=8080 bun run start
 *
 * 每次启动重新扫描磁盘；运行中改完 compose 可以点界面上的「重新扫描」（POST /api/refresh）。
 */

import { type ComposeDoc, parseComposeDoc } from "./compose-doc";
import { type ExplorerConfig, isPubliclyExposed, resolveConfig } from "./config";
import { loadFeatureFlags } from "./deploy-config";
import { createFetchHandler, type ExplorerState } from "./http";
import { buildFileIndex, discoverComposeFiles, type FileIndex } from "./scan";
import { buildTopology } from "./topology";

type ScanResult = { docs: ComposeDoc[]; fileIndex: FileIndex; topologyJson: string; summary: string };

function scan(config: ExplorerConfig): ScanResult {
  const composeFiles = discoverComposeFiles(config);
  const docs: ComposeDoc[] = [];
  for (const file of composeFiles) {
    try {
      docs.push(parseComposeDoc(file.absPath, file.relPath, config.repoRoot));
    } catch (error) {
      // 单个文件读失败不应该让整个工具起不来：打印并跳过，其余编排照常可视化。
      console.error(
        `[compose-explorer] 解析失败 ${file.relPath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const flags = loadFeatureFlags(config.deployConfigFile, config.repoRoot);
  const topology = buildTopology(docs, flags, config.repoRoot);
  const fileIndex = buildFileIndex(config, docs);

  const serviceCount = docs.reduce((total, doc) => total + doc.services.length, 0);
  const summary = `${docs.length} 个 compose 文件 / ${serviceCount} 个服务 / ${topology.edges.length} 条依赖边 / ${fileIndex.all.length} 个可读文件`;

  return { docs, fileIndex, topologyJson: JSON.stringify(topology), summary };
}

function main(): void {
  const config = resolveConfig();
  const state: ExplorerState = {
    config,
    fileIndex: { all: [], byId: new Map(), byGroup: new Map() },
    topologyJson: () => ({ error: "尚未扫描" }),
    refresh: () => undefined,
  };

  const applyScan = (result: ScanResult): void => {
    state.fileIndex = result.fileIndex;
    state.topologyJson = () => JSON.parse(result.topologyJson) as unknown;
  };

  const first = scan(config);
  applyScan(first);
  state.refresh = () => {
    const next = scan(config);
    applyScan(next);
    console.log(`[compose-explorer] 已重新扫描：${next.summary}`);
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createFetchHandler(state),
  });

  console.log(`[compose-explorer] ${first.summary}`);
  console.log(`[compose-explorer] 拓扑来源：${config.deployConfigFile}`);
  console.log(`[compose-explorer] 打开 http://${config.host}:${server.port}/`);
  if (isPubliclyExposed(config)) {
    console.warn(
      `[compose-explorer] 警告：正在监听 ${config.host}，本工具无鉴权且会把仓库内编排与说明文件全文返回，请勿暴露到不可信网络。`,
    );
  }
}

main();
