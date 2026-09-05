# CE submodule 升级（Demo）

1. 创建 `chore/upgrade-ce-<tag>` 分支；将 `vendor/fenix-ce` 固定到明确 tag/commit。
2. 审查 CE 的公开 API、migration、env 与部署变化。
3. 运行 CE DDL → EE DDL 的升级验证，以及最小 AgentConfig run 链路。
4. 只提交 submodule 指针和 EE 适配；不得修改 vendor 内源码。
