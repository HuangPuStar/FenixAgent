# Assembly profiles

此目录保存随构建版本交付的静态模块组合。profile 只能选择已经编译进 `apps/generated/module-registry.ts` 的模块 ID，不能声明路径、URL、包名或代码入口。

`ce.json` 固定 CE 产品线选择的 access-control、Agent Runtime 和 Web Shell ID。profile 声明目标组合，不保证对应 manifest 已注册或基础模块工厂已经可用；registry 和 bootstrap 必须拒绝未知模块、类别不匹配及缺少工厂的基础模块。
