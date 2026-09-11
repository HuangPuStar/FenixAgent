# Assembly profiles

此目录保存随构建版本交付的静态模块组合。profile 只能选择已经编译进 `apps/generated/module-registry.ts` 的模块 ID，不能声明路径、URL、包名或代码入口。

`ce.json` 预先固定 CE 产品线的目标 access-control、runtime 和 Web Shell ID，不代表 FND-03 阶段已经形成可启动组合。当前只注册 access-control 的 manifest 元数据；PLT-01 提供其真实工厂，AGT-01 提供 runtime manifest 和工厂。二者进入 registry 后由 AGT-01 在集成基线上补默认 bootstrap smoke test，server 才能切换到新入口。
