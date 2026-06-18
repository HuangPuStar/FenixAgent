# System API Demo

这个目录提供了一组可直接运行的 System API 示例脚本，主要演示：

- 查询用户列表
- 系统级创建用户
- 查询组织列表
- 系统级创建组织

建议从仓库根目录执行，统一使用 `bun` 运行。

目录定位：

- 这一组 demo 关注 `/api/system/*` 这类系统管理接口
- 这组接口使用 `RCS_SYSTEM_API_KEYS` 对应的 system key，不是普通 External API Key

## 前置准备

确认你已经拿到一枚 system key，也就是服务启动时通过 `RCS_SYSTEM_API_KEYS` 配置的 key。

## 文件说明

- `common.js`
  公共工具：参数校验、带鉴权的 HTTP 请求、URL 处理
- `system-api-demo.js`
  System API 示例脚本，支持 list/create 等常用动作

## 1. 用户相关 Demo

查看用户列表：

```bash
bun docs/developer/api-demo/system/system-api-demo.js list-users \
  --system-api-key 123456 \
  --base-url http://localhost:3000
```

创建一个用户：

```bash
bun docs/developer/api-demo/system/system-api-demo.js create-user \
  --system-api-key 123456 \
  --base-url http://localhost:3000 \
  --email system-demo@example.com \
  --name "System Demo User" \
  --password supersecret123 \
  --email-verified true
```

## 2. 组织相关 Demo

查看组织列表：

```bash
bun docs/developer/api-demo/system/system-api-demo.js list-organizations \
  --system-api-key 123456 \
  --base-url http://localhost:3000
```

创建一个组织：

```bash
bun docs/developer/api-demo/system/system-api-demo.js create-organization \
  --system-api-key 123456 \
  --base-url http://localhost:3000 \
  --name "System Demo Org" \
  --slug system-demo-org
```

如果需要在创建组织时直接绑定 owner，还可以额外传：

```bash
bun docs/developer/api-demo/system/system-api-demo.js create-organization \
  --system-api-key 123456 \
  --base-url http://localhost:3000 \
  --name "System Demo Org" \
  --slug system-demo-org \
  --owner-user-id <existing-user-id>
```

## 推荐体验顺序

建议按下面顺序体验最顺：

1. `bun docs/developer/api-demo/system/system-api-demo.js list-users`
2. `bun docs/developer/api-demo/system/system-api-demo.js create-user --system-api-key <key> --email <email> --name <name> --password <password>`
3. `bun docs/developer/api-demo/system/system-api-demo.js list-organizations --system-api-key <key>`
4. `bun docs/developer/api-demo/system/system-api-demo.js create-organization --system-api-key <key> --name <name> --slug <slug>`
