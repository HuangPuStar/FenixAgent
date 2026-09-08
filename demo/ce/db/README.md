# db

此目录只保存 CE 仓库统一的 DDL migration 链。表定义与业务数据迁移仍归各资源模块：

- `packages/resources/*/db/schema.ts`
- `packages/resources/*/db/data-migrations/`

发布时 CE runner 使用独立 migration journal；EE 部署先运行本链，再运行 EE 自己的链。
