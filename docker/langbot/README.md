# LangBot（消息通道依赖）

平台的 **IM 网关**：LangBot 负责连接 QQ / 微信 / 飞书 / 钉钉 / Telegram / Discord / Slack 等消息平台，
平台侧只做 Agent 编排与通道管理。**本目录只使用上游发布镜像，不修改 LangBot 源码**；集成契约见
[docs/arch/30-langbot-channel-gateway.md](../../docs/arch/30-langbot-channel-gateway.md)。

镜像：`rockchin/langbot:v4.11.2`（多架构，2026-10-22 发布）。镜像内同时包含核心服务、WebUI 与插件运行时。

## 前置条件

1. Docker Engine 与 Docker Compose ≥ 2.20。
2. **主服务项目必须先启动**（`fenix-server` 由主服务项目创建：dev 是仓库根 `docker-compose.yml`，
   生产是 `docker/main/docker-compose.yml`；本目录以 `external: true` 引用）。
3. 宿主机建议 ≥ 2 GB 可用内存（镜像约 600 MB，插件运行时另占一个进程）。
4. `LANGBOT_API_KEY` 已生成并填入本目录 `.env`；主服务侧 `LANGBOT_API_KEY` 必须同值。

## 配置

| 键 | 位置 | 必需性 | 说明 |
| --- | --- | --- | --- |
| `LANGBOT_API_KEY` | 本目录 `.env`，主服务 env 同值 | 必需 | Service API / 内置 MCP 的全局密钥（`X-API-Key` 或 `Authorization: Bearer`）；`openssl rand -hex 32` |
| `LANGBOT_PUBLIC_BASE_URL` | 本目录 `.env` | 生产必需 | LangBot 对外可达的 HTTPS 源；IM 平台回调、`http_bot` 入站地址、邀请链接都由它拼出。缺省 `http://127.0.0.1:5300` 只适用于本机 |
| `LANGBOT_HTTP_PORT` | 本目录 `.env` | 可选 | 宿主回环端口，默认 5300 |
| `LANGBOT_BASE_URL` | 主服务 env | 启用通道时必填 | 主服务访问 LangBot 的基址：容器形态写 `http://langbot:5300`，源码运行写 `http://127.0.0.1:${LANGBOT_HTTP_PORT}` |
| `TZ` | 本目录 `.env` | 可选 | 容器时区，默认 `Asia/Shanghai` |

`docker/deploy.sh init` 会把本目录 `.env.example` 落成 `.env`（已存在不覆盖）。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `langbot` | 是 | 出口服务：主服务直连它的 Service API；它回调主服务的 `/hooks/langbot/*` |
| `langbot_plugin_runtime` | 否 | 只与核心通过项目默认网络通信；不需要跨项目访问 |

`langbot` 与 `langbot_plugin_runtime` 是 `fenix-server` 上的全局唯一服务名；插件运行时地址由
`PLUGIN__RUNTIME_WS_URL=ws://langbot_plugin_runtime:5400/control/ws` 固定，**不要改服务名**。

## 地址对照

| 场景 | 填什么 |
| --- | --- |
| 主服务容器访问 LangBot | `LANGBOT_BASE_URL=http://langbot:5300` |
| 本地源码运行（`bun run dev`） | `LANGBOT_BASE_URL=http://127.0.0.1:5300`（端口以 `LANGBOT_HTTP_PORT` 为准） |
| 管理员浏览器打开 WebUI | `http://127.0.0.1:5300` |
| LangBot 回调主服务 | `http://rcs:3000/hooks/langbot/<channelId>`（容器网络；channelId 由平台通道记录给出） |
| IM 平台回调 LangBot | `${LANGBOT_PUBLIC_BASE_URL}` 下的适配器路径（每个 Bot 的配置页会显示完整地址） |

## 首次启动与验证

```bash
cp docker/langbot/.env.example docker/langbot/.env   # 填 LANGBOT_API_KEY
docker compose -f docker/langbot/docker-compose.yml up -d
docker compose -f docker/langbot/docker-compose.yml ps
```

1. `curl -fsS http://127.0.0.1:5300/healthz` 返回 200（无需认证）。
2. `curl -fsS -H "X-API-Key: $LANGBOT_API_KEY" http://127.0.0.1:5300/api/v1/platform/bots` 返回
   `{"code":0,...}`；401 说明主服务侧密钥与本目录不一致。
3. 浏览器打开 `http://127.0.0.1:5300`，按页面初始化向导创建管理员（**上游没有默认账号密码**），
   再创建模型、流水线与 Bot。
4. 衔接层落地后，在 WebUI「API 集成 → Webhooks」新建指向 `http://rcs:3000/hooks/langbot/<channelId>`
   的 Webhook；该配置目前没有 Service API，只能从 WebUI 设置。

## 数据与备份

全部落在本目录 `./data/`（bind 挂载，禁止命名卷）：

| 路径 | 内容 |
| --- | --- |
| `data/config.yaml` | 生效配置，**包含明文 `api.global_api_key`**，权限按密钥对待 |
| `data/langbot.db` | 默认 SQLite 业务库（4.x 不再支持从 3.x 导入） |
| `data/plugins/` | 已安装插件 |
| `data/plugin-runtime/` | 插件产物缓存与每安装实例的私有数据 |

备份 `./data/` 即可；恢复时保持目录属主可写。`./data/` 不进版本控制。

## 升级

1. 两个服务的 `image:` 行同时改成目标 tag（版本写死在 compose，禁止 `latest`）。
2. `docker compose -f docker/langbot/docker-compose.yml pull && ... up -d`。
3. 升级前备份 `./data/`；4.x 的大版本升级可能包含不可逆数据库迁移，**不要在未备份时降级**。

## 可选项（默认不启用）

- **Box 沙箱**：官方编排用 `profiles: ["box", "all"]` 提供 `langbot_box`，需要挂载
  `/var/run/docker.sock` 并共享宿主工作区。本目录默认 `BOX__ENABLED=false`；需要执行类工具
  （exec / 文件读写 / stdio MCP）时再按官方 compose 追加该服务，并接受 Docker socket 的权限风险。
- **反向连接端口 2280-2285**：仅 `aiocqhttp`（OneBot）等反向连接适配器需要。需要时在
  `langbot` 服务上追加端口映射；按部署契约**只绑回环**（`127.0.0.1:2280-2285:2280-2285`），
  公网入口必须经主服务反向代理，不得直接发布。

## 已知项

1. LangBot 事件 Webhook **没有签名机制**（官方文档未提供签名头）。平台侧按「仅容器网络可达 +
   channelId 不可枚举」防护，不得把 `/hooks/langbot/*` 暴露到公网；详见 30 号文档 §9。
2. Service API 的机器人对象不暴露「启用/停用」与「已绑定流水线」字段；这些状态只能在 WebUI 查看或
   通过事件流推断。通道页面不展示无法验证的字段。
3. `api.webhook_prefix` 若保持默认 `http://127.0.0.1:5300`，IM 平台会拿到不可用的回调地址；
   生产必须设置 `LANGBOT_PUBLIC_BASE_URL`。
4. 许可证以仓库 `LICENSE` 为准（Apache-2.0）；官方 OpenAPI 元数据写 AGPL-3.0，但链接指向同一份 Apache `LICENSE`，属元数据冲突（OpenAPI 版本仍停在 4.9.5）。按 Apache-2.0 理解，商用前建议向上游书面确认。
