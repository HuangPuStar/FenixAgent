# Access Control

此包将承载默认的用户、组织、角色、资源范围和动作授权实现。

`fenix.module.ts` 已声明中性的稳定装配 ID `access-control`；PLT-01 实现公共授权契约时补充模块工厂。在此之前默认 CE profile 不是可启动组合，FND-03 不添加占位授权行为掩盖该阶段边界。
