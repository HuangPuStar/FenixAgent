# Agent Sites（agent-config 依赖）

站点发布运行时：平台通过它把 Agent 应用发布为可访问的站点。
镜像仓库：[ghcr.io/konghayao/agent-sites](https://github.com/konghayao/agent-sites)。

## 配置

| 键 | 位置 | 必需性 | 说明 |
| --- | --- | --- | --- |
| `AGENT_SITES_MASTER_KEY` | 根 `.env`（随主服务启动）/ 本目录 `.env`（独立部署） | 必需 | 与控制台一致的站点部署密钥 |
| `AGENT_SITES_PORT` | 本目录 `.env` | 默认值 26778 | 站点访问端口，对外发布 |

容器内连接地址固定 `http://agent-sites:3000`（经 `fenix-server`）；主服务用 `AGENT_SITES_BASE_URL` 指向它。

## 网络接入清单

| 服务 | 接入 fenix-server | 理由 |
| --- | --- | --- |
| `agent-sites` | 是 | 需要被主服务直连（站点部署与状态回传） |

## 验证

```bash
curl -fsS http://localhost:26778/ -o /dev/null -w '%{http_code}\n'   # 预期 200/302
```

## 升级

改 `docker-compose.yml` 的 `image` 行为目标版本，然后：

```bash
docker compose -f docker/agent-sites/docker-compose.yml up -d
```
