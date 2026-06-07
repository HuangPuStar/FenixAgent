# 系统 Admin 初始化与内置 Skill 统一托管

**日期**: 2026-06-07
**状态**: Draft

## 背景

当前内置 skill 的同步逻辑是：

- 服务启动时遍历当前已有组织
- 将 `.agents/skills/` 下的内置 skill 同步到每个组织自己的 skill 目录
- 每个组织都持有一份 builtin skill 的物理副本

这种方式的问题是：

1. 内置 skill 的物理副本分散在多个组织下，系统资源没有统一归属
2. 启动流程耦合“组织枚举 + skill 复制”，不利于后续维护
3. 新增组织的 builtin skill 获取时机不稳定
4. 系统没有一个显式的系统管理员账号和系统组织来承载系统级资源

## 目标

1. 启动时自动初始化一个系统级 `admin` 用户和 `admin` 组织
2. 内置 skill 不再复制到每个组织，而是统一托管在系统 `admin` 组织下
3. 所有 builtin skill 统一设置为公开可读，其他组织通过现有共享资源机制读取
4. 首次创建系统 admin 时，将账号密码打印到日志并落到密码文件

## 不做的事

- 不对已存在的 `admin@fenix.com` 用户做修复、补齐或密码重置
- 不引入新的“系统域”或“全局资源域”，仍复用现有 user / organization / resource_permission 模型
- 不在本次改动中处理“运行中新建组织自动感知 builtin skill”的额外机制

## 设计

### 1. 系统 Admin 初始化

新增启动初始化逻辑 `ensureSystemAdmin()`，在服务启动时执行：

1. 查询邮箱为 `admin@fenix.com` 的用户
2. 如果用户已存在：
   - 直接跳过
   - 不检查组织是否完整
   - 不重置密码
   - 不重写密码文件
3. 如果用户不存在：
   - 创建用户：
     - `name: admin`
     - `email: admin@fenix.com`
     - `password: <16位随机字符串>`
   - 创建组织：
     - `name: admin`
     - `slug: admin`
   - 创建 membership：
     - 该用户是 `admin` 组织的 `owner`
   - 打印账号日志
   - 写入密码文件

这里沿用现有多租户模型，不单独引入“系统组织”特殊类型。
`admin` 组织就是一个正常的 organization，只是约定它承载系统级资源。

### 2. 密码文件配置

新增显式环境变量：

- `RCS_SYSTEM_ADMIN_PASSWORD_FILE`

默认值：

```text
./data/password.txt
```

仅在首次创建系统 admin 时写入。

文件内容固定为：

```text
system admin account
username: admin
email: admin@fenix.com
password: <generated-password>
organization: admin
```

同时在首次创建时打印一条日志，输出同样的信息，便于部署方从日志中获取初始密码。

### 3. Builtin Skill 统一托管

内置 skill 的同步策略改为：

- 不再遍历每个组织同步一份
- 启动时通过 `syncBuiltin()` 统一执行系统内置资源同步
- 当前 `syncBuiltin()` 内部先调用 `syncBuiltinSkillsToSystemAdmin()`
- 当前 builtin 范围只包括 skill，因此首个落地点仍是系统 `admin` 组织
- 所有 builtin skill 都挂在系统 admin 账号 / admin 组织下

存储路径仍沿用当前组织级 skill 结构：

```text
data/skills/<adminOrganizationId>/<skillName>/SKILL.md
data/skills/<adminOrganizationId>/<skillName>.zip
```

同步完成后，将这些 builtin skill 全部设置为 `publicReadable = true`。

这样其他组织不再拥有 builtin skill 的本地物理副本，而是通过已有的资源共享与公开读能力访问它们。

### 4. `meta-agent` 语义调整

当前 `meta-agent.ts` 中的 builtin skill 同步，需要从“面向每个组织复制 builtin skill”调整为“面向系统组织维护 builtin skill 源”。

具体约束：

- `syncBuiltin()` 作为启动期统一入口，负责组织后续所有系统内置资源同步
- 当前 `syncBuiltin()` 内部先调用 `syncBuiltinSkillsToSystemAdmin()`
- `syncBuiltinSkills(ctx)` 仍可以保留“把 builtin skill 同步到指定组织”的底层能力
- 但启动入口只会使用系统 admin 的 `AuthContext` 调用 system-admin 这一条路径
- 其写入目标是 `admin` 组织，而不是所有组织
- 同步完成后，要补公开读设置

同时，`ensureMetaConfig()` 不应再承担“顺手为当前业务组织同步 builtin skill”这类副作用，否则会重新回到“多组织复制副本”的旧模型。

### 5. 启动顺序

启动顺序调整为：

1. `initDb()`
2. `ensureSystemAdmin()`
3. `runDataMigrations()`
4. `syncBuiltin()`
5. 其他启动逻辑

原因：

- system admin 必须先存在，builtin skill 才有归属组织
- data migration 仍在 builtin skill 同步前执行，避免旧文件结构影响后续系统资源写入
- 启动时不再遍历所有组织做 builtin skill 同步

### 6. 对现有资源访问模型的影响

builtin skill 统一托管后：

- `admin` 组织是 builtin skill 的 source organization
- 其他组织读取这些 skill 时，会通过现有 external/public readable 路径访问
- 现有 skill 文件路径解析已经基于“skill 所属组织 + name”推导，因此与本次设计兼容

换句话说，这次改动主要影响的是“谁持有 builtin skill 的物理副本”，而不是 skill 的读取协议。

### 7. 测试

需要补充或调整以下验证：

1. `ensureSystemAdmin()` 首次启动创建用户、组织、membership、密码文件
2. `ensureSystemAdmin()` 在 `admin@fenix.com` 已存在时完全跳过
3. builtin skill 启动时只同步到系统 admin 组织，不再遍历所有组织
4. builtin skill 同步后被设置为 `publicReadable`
5. `ensureMetaConfig()` 不再隐式给业务组织写 builtin skill 副本

## 验证标准

1. 系统首次启动时自动生成 `admin@fenix.com`
2. 系统首次启动时自动生成 `admin` 组织，并将该用户设为 owner
3. 系统首次启动时在日志和 `RCS_SYSTEM_ADMIN_PASSWORD_FILE` 对应文件中写出账号密码
4. 如果 `admin@fenix.com` 已存在，后续启动完全跳过，不重置密码、不重写文件
5. builtin skill 仅在 `admin` 组织下保留一份物理副本
6. builtin skill 对其他组织可公开读取
