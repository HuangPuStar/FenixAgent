# Skills 配置

> 涉及模块：Skill 配置服务、Skill 内容存储、ExpertConfig、LaunchSpecBuilder
>
> **状态：待重新设计**。Skill 内容将迁移到 S3；对象结构、上传流程、原子性、清理和下发协议由独立设计确定。本文只定义 Skill 的领域边界。

## 概述

Skill 是 Agent 可挂载的技能资源。一个 Skill 由可查询的元数据和可执行的内容组成，内容通常包含 `SKILL.md` 及其附属文件。

## 资源边界

PostgreSQL 管理 Skill 的身份、名称、说明、所有权、可见性和内容定位信息；S3 保存 `SKILL.md` 与附属文件。元数据存在但内容不可读的 Skill 不可用于启动。

Skill 的 S3 设计必须单独解决：

- object key 与内容布局；
- 上传、替换和失败补偿；
- PostgreSQL 元数据与 S3 内容的一致性；
- 未引用对象、历史对象和删除请求的清理；
- 下载授权、完整性校验及 Agent 下发格式。

在该设计完成前，本文件不规定对象复制或生命周期实现。

## Skill 管理

- 创建和导入必须同时建立有效元数据与内容，不能只写数据库；
- `SKILL.md` 必须可解析，并在边界处校验名称、说明和所需结构；
- 附属文件路径必须防止绝对路径、目录穿越和符号链接逃逸；
- 更新、删除和恢复必须由 Skill 服务编排存储操作及补偿；
- 内容大小、文件数量和归档大小需要明确上限；
- Secret 不得写入 Skill 内容、元数据或下载 URL。

Skill 采用通用版本能力，但 PostgreSQL 与 S3 如何共同实现该能力属于后续存储设计，不在这里展开。

## 与 ExpertConfig 的关系

Agent 不直接绑定 Skill。ExpertConfig 维护所需 Skill 的有序集合；保存时校验资源存在性、可见性和重复项。LaunchSpecBuilder 解析该集合，将内容转换为 `SkillConfig[]` 并按运行协议下发。

多个 ExpertConfig 可以共享同一 Skill。ExpertConfig 的变更不得隐式修改 Skill 内容。

## 跨组织共享

Skill 可以公开读取。跨组织使用仍需校验来源组织、元数据权限和内容下载权限；公开内容的签名下载凭据必须短期有效且只允许访问目标对象。
