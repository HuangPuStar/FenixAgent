# deploy

部署目录只放装配 profile、镜像、Compose/Helm、无密钥 env 模板和发布编排。

`assembly/ce.json` 选择当前 CE 镜像中已经注册的模块。registry 来自构建期 `bun run generate:module-registry` 对可信 `fenix.module.ts` 的扫描，生成物只含静态 import。profile 可以随镜像交付，也可以由部署平台以只读文件挂载后在启动时读取；发布脚本固定其读取位置。它不是插件下载清单：只允许稳定模块 ID，不能声明本地路径、URL、包名或代码。发布前先校验 profile 的模块存在性、依赖、env 和 migration，再执行 DDL migration → 模块 data migration → 新 server/web → readiness。
