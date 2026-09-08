# deploy

`assembly/ee.json` 选择已经构建进 EE 镜像的企业授权、CE runtime、资源和 web contribution。registry 来自构建期 `bun run generate:module-registry` 对 EE packages 与固定 CE submodule 的可信 `fenix.module.ts` 扫描，生成物只含静态 import。profile 可以随镜像交付，也可以由部署平台以只读文件挂载后在启动时读取；发布脚本固定其读取位置。配置只能引用生成 registry 中的模块 ID，不会加载路径、URL 或第三方包。

EE 发布脚本固定执行：校验 assembly profile → CE DDL → EE DDL → EE data migrations → server/web readiness。真实镜像记录 CE submodule commit、EE commit 与 assembly profile 的内容/摘要。
