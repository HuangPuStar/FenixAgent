# CloudDrive 本地联调与验收

> 适用：在本机把 Fenix 的 `/web/cloud-drive/*` 代理与真实 CloudDrive 跑通，并完成「两个模拟用户」的隔离验收。
> 架构事实见 [个人云盘（CloudDrive）](../arch/30-cloud-drive.md)。本文不含任何密钥值。

## 1. 前置

1. CloudDrive REST 可达：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz` 返回 200。
2. 本机 PostgreSQL 可用（例如 `fenix-postgres-1`，端口 `127.0.0.1:5432`），并有可用的 `DATABASE_URL`。
3. CloudDrive 侧已配置 master key、key id 与来源 CIDR；本地 demo 通常为 `demo` + `0.0.0.0/0`。
4. master key 放在受控文件里（如 `~/.config/clouddrive/fenix.key`，权限 600），**不要写进仓库、命令行或日志**。

## 2. 一次性数据库（推荐）

联调会创建用户、组织与 CloudDrive 数据；用独立数据库避免污染开发库，结束后整库删除即可完成清理。

```bash
# 1) 建库（容器内超级用户，按实际容器名调整）
docker exec fenix-postgres-1 psql -U rcs -d postgres -c 'CREATE DATABASE fenix_clouddrive_smoke'

# 2) 迁移（把 DATABASE_URL 换成指向新库；不要回显含口令的 URL）
DATABASE_URL='postgres://<user>:<password>@127.0.0.1:5432/fenix_clouddrive_smoke' bun run db:migrate
```

## 3. 启动本地 Fenix

在 worktree 根创建临时 env 文件（`chmod 600`，不要提交），至少包含：

| 变量 | 示例 / 说明 |
| --- | --- |
| `DATABASE_URL` | 指向第 2 步的独立库 |
| `RCS_PORT` | `3101`（避开已被占用的端口） |
| `RCS_BASE_URL` / `BETTER_AUTH_URL` | `http://localhost:3101` |
| `RCS_TRUSTED_ORIGINS` | `http://localhost:3101` |
| `CLOUDDRIVE_BASE_URL` | `http://127.0.0.1:8080` |
| `CLOUDDRIVE_MASTER_KEY` | `$(cat ~/.config/clouddrive/fenix.key)`（写入 env 文件，不打印） |
| `CLOUDDRIVE_KEY_ID` | `demo` |
| `CLOUDDRIVE_TIMEOUT_MS` | `180000`（联调可高于默认 120000） |

```bash
cd .worktrees/feat-clouddrive
set -a; . /tmp/clouddrive-smoke.env; set +a
bun run apps/server/src/main.ts
```

健康检查：`curl -s http://127.0.0.1:3101/health` 返回 `{"status":"ok",...}`。若 `/web/cloud-drive/me` 返回 `503 CLOUD_DRIVE_NOT_CONFIGURED`，先核对四个键的拼写与是否真的进入进程环境。

## 4. 运行验收脚本

`scripts/cloud-drive-local-smoke.ts` **默认跳过**，只有显式开启才运行，不进 CI。

```bash
CLOUD_DRIVE_SMOKE=1 \
FENIX_BASE_URL=http://127.0.0.1:3101 \
bun run scripts/cloud-drive-local-smoke.ts
```

脚本行为：

1. 未提供会话时，经 `/api/auth/sign-up/email` 创建两个一次性用户（随机邮箱与密码）；密码不打印。个人组织由注册钩子自动创建。
2. 通过真实 HTTP 依次验证：主体/配额、根列表、建目录、同名冲突（409）、保留字目录（422）、TUS 两片上传（中途查 offset）、finalize（含幂等重复提交）、已消费会话（410）、元数据、版本、整文件下载、Range 下载（206）、改名（中文名 RFC 5987）、搜索、删除、回收站、恢复，以及用户 B 对用户 A 的文件/目录/上传会话的全部 404 隔离。
3. 结束时打印 Markdown 结果表、两个用户邮箱与用户 ID。

复用已有会话时可提供 `CLOUD_DRIVE_SMOKE_COOKIE_A` / `CLOUD_DRIVE_SMOKE_COOKIE_B`（完整 Cookie 头）。

## 5. 清理

1. 停止 Fenix 进程（只结束监听 `RCS_PORT` 的那个 PID，不要误杀其它 worktree 的服务）。
2. 删除临时 env 文件：`rm -f /tmp/clouddrive-smoke.env`。
3. 独立库：`docker exec fenix-postgres-1 psql -U rcs -d postgres -c 'DROP DATABASE IF EXISTS fenix_clouddrive_smoke WITH (FORCE)'`。库删除后用户、组织、会话一并消失。
4. 若不得不复用共享库：在脚本运行环境中设置 `CLOUD_DRIVE_SMOKE_CLEANUP=1` 与 `DATABASE_URL`，脚本会按两个用户 ID 删除其个人组织与用户（`member` / `session` / `account` / `user_config` 级联）。

## 6. 预期结果与排障

| 现象 | 解释 / 处置 |
| --- | --- |
| 冷启动第一次写操作耗时约 65s | CloudDrive 首次为该主体 provision 空间；`CLOUDDRIVE_TIMEOUT_MS` 默认 120s 已覆盖，不要把超时调回 30s |
| `503 CLOUD_DRIVE_NOT_CONFIGURED` | 四个部署键未进入进程环境，或宿主投影键名不匹配；检查 `CLOUDDRIVE_BASE_URL` 拼写 |
| `409 CLOUD_DRIVE_CONFLICT` | 同名目标已存在，或元数据 revision 已推进；刷新后重试 |
| `422 CLOUD_DRIVE_INVALID_INPUT` | 用户输入问题（如保留目录名 `.clouddrive-trash` / `.clouddrive-retained`）；不是上游故障 |
| `410 CLOUD_DRIVE_UPLOAD_GONE` | 上传已 finalize / abandon；停止轮询，finalize 幂等可重复调用 |
| `404 CLOUD_DRIVE_UPLOAD_NOT_FOUND` | 会话不存在或属于其它用户；重新创建上传 |
| 下载没有文件名 | 确认走的是 Fenix `/web/cloud-drive/files/:id/content`，而不是 CloudDrive 的直链 |
| 搜索刚上传的文件为空 | 搜索最终一致；脚本会最多等待 15s |

## 7. 安全约束

1. master key 只在 Fenix 服务端配置与 CloudDrive 部署中存在；脚本只访问 Fenix `/web/*`，不读取也不打印它。
2. 不要把 `Authorization`、`upload_url`、下载票据或带签名的 URL 写入日志、工单或报告。
3. 联调用户使用一次性邮箱；共享库场景务必执行第 5 步清理。
