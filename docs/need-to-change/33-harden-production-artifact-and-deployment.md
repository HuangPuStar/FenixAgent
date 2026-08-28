# 33. 生产制品必须最小、可复现、非 root，部署默认值必须自洽

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 同 commit 镜像不同、源码/映射泄露、root blast radius、默认启动/认证失败 |

## 对抗判决

Docker 使用 mutable base tag，最终以 root 运行并装入 git/curl/Python/Agent CLI；全局 plugin 安装未固定版本。`.dockerignore` 未排 `.env`/`.agents`，Dockerfile 又复制本地 skills，使未跟踪文件进入 build context/image。dist 缺失时 static plugin fail-open 服务整个 `web/` 源目录。默认 compose 暴露端口与 `RCS_BASE_URL` 不一致，CORS 配置也无法支持 credential 分域部署。

## 已核验证据

- `Dockerfile:1-3,27,35`：mutable image tags；最终无 `USER`。
- `Dockerfile:52-90`：生产层安装大量工具、全局 plugin，并复制 `.agents/agents`/`skills`。
- `.dockerignore:1-9`：未 deny `.env`、`.agents`、通用 workspace/private assets。
- `src/plugins/static.ts:10-17`：两处 dist 均缺失时回退 `web/`。
- `web/vite.config.ts:27-30`：生产 sourcemap 全量公开。
- `docker-compose.prod.yml:17,26`：暴露 3001，但 base URL 是 localhost:3000；另一 production compose 暴露 38879 仍默认 3000。
- `src/plugins/cors.ts:5-22`：`origin:"*"` + `credentials:true`，allowed headers 缺组织/opId/条件请求头。
- `docker-compose.prod.yml:27` 默认 `RCS_API_KEYS` 为空，而 `src/env.ts:7-9` 要求非空；README clean-clone 未补齐。

## 架构诊断

repository checkout 被当作 production artifact 输入，没有清晰 allowlist；运行时镜像又兼任构建/调试/执行环境。External URL/CORS/auth trusted origin 分散配置，部署 topology 不是一个可验证 Module。

## 目标不变量

- 所有 base/image/action/plugin 使用 digest/lock；build 在 clean checkout 中可重复，artifact manifest 列明受版本控制输入。
- build context deny-by-default，不包含 `.env`、workspaces、data、未跟踪 `.agents`；运行资产由显式清单生成。
- production image 多阶段最小化、非 root、只读 rootfs（必要目录独立卷）、drop capabilities、受限 seccomp/no-new-privileges。
- dist 或关键 runtime asset 缺失直接启动失败；source map 私有上传，不公开托管。
- 单一 External URL 配置生成 Better Auth trustedOrigins、callback/link 和 CORS；credential CORS 只允许显式 origins/headers。
- quickstart 对所有 required env fail fast 并提供非真实安全默认/生成流程；仓库不硬编码生产 secret。

## 分阶段整改

1. static fail-closed、修 base URL/CORS/required env 文档。
2. 完善 `.dockerignore` 和显式资产清单，clean checkout 双构建比 digest/content。
3. 固定 digest/version，创建非 root 最小 runtime 和权限测试。
4. 在 [31](./31-gate-release-and-migration.md) 增加 image scan、SBOM、signature、startup smoke。

## 验收

- 相同 commit/lock/args 在本地与 CI 得到相同资产清单；未跟踪 skill/`.env` 不进入 context/image。
- 容器非 root、只读、无不必要包/能力，仍能完成受支持 Agent runtime；需要执行面的工具放到 [1](./1-isolate-workflow-execution-plane.md) runner。
- 缺 dist、错误 URL、空 required secret、错误 origin 在启动/预检时明确失败。

## 误报排除

官方镜像正常含 dist，源码 fail-open 主要影响错误打包/开发式生产部署；仍应移除，因为 production 安全不应依赖“通常会有文件”。分域 CORS 问题不影响当前同源 `/ctrl`，但默认配置宣称的部署能力不成立。
