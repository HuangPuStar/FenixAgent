---
name: zentao-manager
description: 通过 zentao 命令行工具查询和操作禅道（ZenTao）数据，覆盖项目集、产品、项目、执行、需求、Bug、任务、测试用例、测试单、产品计划、版本、发布、反馈、工单、应用、用户、附件等模块的增删改查及状态流转。当用户提到禅道、zentao、查询项目进展、获取 Bug 列表、创建任务、更新需求状态等项目管理操作时使用本技能。
license: MIT
metadata:
    author: Sun Hao <sunhao@chandao.com>
    repository: https://github.com/easysoft/zentao-cli.git
    keywords: [zentao, 禅道, cli, project-management]
    version: 0.1.7
---

# 禅道 Manager

通过 `zentao` 命令行工具查询和操作禅道数据。CLI 自动处理认证、分页，支持工作区上下文和数据过滤/排序。

## 前置准备

### 安装

```bash
npm install -g zentao-cli
# 或 bun install -g zentao-cli
# 或 pnpm install -g zentao-cli
# 或免安装运行：npx zentao-cli
```

如果用户没有安装，引导用户进行全局安装使用，如果系统存在 bun 或 pnpm 则优先使用 bun 或 pnpm 进行全局安装。

### 认证

首次执行任意 `zentao` 命令会自动提示登录。也可显式登录：

```bash
zentao login -s https://zentao.example.com -u admin -p 123456
```

环境变量（优先级低于命令行参数）：

| 变量              | 说明                                 |
| ----------------- | ------------------------------------ |
| `ZENTAO_URL`      | 禅道服务地址                         |
| `ZENTAO_ACCOUNT`  | 用户账号                             |
| `ZENTAO_PASSWORD` | 密码                                 |
| `ZENTAO_TOKEN`    | 直接指定 Token（有此变量可省略密码） |

登录成功后凭证缓存在 `~/.config/zentao/zentao.json`，后续无需重复登录。

### 凭证安全

- 用户尚未登录时，不要在对话里收集账号密码。让用户直接在终端执行 `zentao login`，或执行任意 `zentao` 命令触发首次自动登录提示，由用户自行输入凭证。
- 严禁读取本地凭证：`ZENTAO_PASSWORD` / `ZENTAO_TOKEN` 环境变量、`~/.config/zentao/zentao.json` 配置文件。所有禅道数据均通过 `zentao` 命令获取，凭证由 CLI 内部处理。

## 命令格式

使用简写方式（推荐）：

| 操作 | 命令                                        |
| ---- | ------------------------------------------- |
| 列表 | `zentao <module>`                           |
| 详情 | `zentao <module> <id>`                      |
| 创建 | `zentao <module> create --field=value`      |
| 更新 | `zentao <module> update <id> --field=value` |
| 删除 | `zentao <module> delete <id>`               |
| 动作 | `zentao <module> <action> <id>`             |
| 帮助 | `zentao <module> help`                      |

也支持 `--data='JSON'` 传入 JSON 数据。

## 模块与操作速查

| 模块名      | 中文      | 支持的操作                               |
| ----------- | --------- | ---------------------------------------- |
| program     | 项目集    | CRUD                                     |
| product     | 产品      | CRUD                                     |
| project     | 项目      | CRUD                                     |
| execution   | 执行/迭代 | CRUD                                     |
| story       | 需求      | CRUD + activate / change / close         |
| epic        | 业务需求  | CRUD + activate / change / close         |
| requirement | 用户需求  | CRUD + activate / change / close         |
| bug         | Bug       | CRUD + activate / close / resolve        |
| task        | 任务      | CRUD + activate / close / finish / start |
| testcase    | 测试用例  | CRUD                                     |
| testtask    | 测试单    | CUD（按产品/项目/执行查列表）            |
| productplan | 产品计划  | CUD（按产品查列表）                      |
| build       | 版本      | CUD（按项目/执行查列表）                 |
| release     | 发布      | CUD（按产品查列表）                      |
| feedback    | 反馈      | CRUD + activate / close                  |
| ticket      | 工单      | CRUD + activate / close                  |
| system      | 应用      | CU（按产品查列表）                       |
| user        | 用户      | CRUD                                     |
| file        | 附件      | 编辑名称 + 删除（⚠️ 不支持上传）          |

> CRUD = 列表 + 详情 + 创建 + 更新 + 删除；CUD = 无独立列表接口，需指定所属范围

### 列表范围参数

部分模块的列表需要指定所属范围：

```bash
zentao story --product=1                # 产品 #1 的需求
zentao bug --product=1                  # 产品 #1 的 Bug
zentao task --execution=1               # 执行 #1 的任务
zentao execution --project=5            # 项目 #5 的执行
zentao build --project=5                # 项目 #5 的版本
zentao testtask --product=1             # 产品 #1 的测试单
zentao release --product=1              # 产品 #1 的发布
zentao productplan --product=1          # 产品 #1 的计划
zentao feedback --product=1             # 产品 #1 的反馈
zentao ticket --product=1               # 产品 #1 的工单
```

设置工作区后可省略这些参数（见下方工作区章节）。

## AI 使用策略

### 输出格式

- 展示给用户：不加 `--format` 参数，默认输出 Markdown 表格（列表）或列表（单个对象）
- 需要程序化处理：加 `--format=json`，返回结构化 JSON

### 交互确认

AI 场景下执行删除操作时加 `--yes` 跳过确认提示：

```bash
zentao bug delete 1 --yes
```

### 不知道 ID 时

先查列表获取 ID，再操作具体对象：

```bash
zentao product --pick=id,name           # 查看产品列表
zentao bug --product=1 --pick=id,title  # 查看 Bug 列表
zentao bug 42                           # 查看具体 Bug
```

### 写操作前确认

执行创建、更新、删除等写操作前，先向用户确认操作内容。用户明确要求不确认时可跳过。

### 更新操作自动补全

执行 `update` 时，CLI 会先 GET 当前对象，把用户未显式传入的字段用现值填充后再 PUT，避免禅道 PUT 覆盖未提交字段导致清空。因此只需传想改的字段即可，无需手动先查再传完整参数。

## 数据处理

### 摘取字段

```bash
zentao product --pick=id,name,status
```

### 过滤

```bash
zentao bug --product=1 --filter='status:active'
zentao bug --product=1 --filter='severity<=2,pri<=2'    # AND
zentao bug --product=1 --filter='status:active' --filter='status:resolved'  # OR
```

支持的运算符：`:` 等于、`!=` 不等于、`>` `<` `>=` `<=`、`~` 包含、`!~` 不包含。

### 模糊搜索

```bash
zentao bug --product=1 --search=登录 --search-fields=title,steps
```

### 排序

```bash
zentao bug --product=1 --sort=pri_asc,severity_asc
```

### 分页

```bash
zentao bug --product=1 --page=1 --recPerPage=50
zentao bug --product=1 --all            # 获取全部
zentao bug --product=1 --limit=10       # 只取前 10 条
```

## 常用操作示例

### 查看进行中的项目和执行

```bash
zentao project --filter='status:doing' --pick=id,name,status
zentao execution --project=5 --pick=id,name,status
```

### 创建需求并关联计划

```bash
zentao story create --product=1 --title="需求标题" --assignedTo=admin --pri=3
zentao story update 11 --title="需求标题" --plan=1
```

### 创建并解决 Bug

```bash
zentao bug create --product=1 --title="Bug标题" --severity=2 --pri=2 --type=codeerror --openedBuild=trunk
zentao bug resolve 42
```

### 创建、启动并完成任务

```bash
zentao task create --execution=1 --name="任务名" --type=devel --assignedTo=admin --estimate=4
zentao task start 100
# 注意：必填 --currentConsumed（本次消耗）、--realStarted、--finishedDate，日期必须带时间
zentao task finish 100 --currentConsumed=4 --realStarted="2026-07-15 09:00:00" --finishedDate="2026-07-15 18:00:00"
```

### 查看帮助

```bash
zentao bug help          # 查看 Bug 模块的参数和操作
zentao story update help # 查看需求更新操作的参数和操作
zentao help              # 查看所有命令
```

## 意图识别

| 用户意图                | CLI 命令                                               |
| ----------------------- | ------------------------------------------------------ |
| 所有产品/项目/项目集    | `zentao product` / `zentao project` / `zentao program` |
| 进行中的项目            | `zentao project --filter='status:doing'`               |
| 某产品的 Bug            | `zentao bug --product=<id>`                            |
| 某执行的任务            | `zentao task --execution=<id>`                         |
| 创建/新增 Bug           | `zentao bug create ...`                                |
| 解决 Bug                | `zentao bug resolve <id>`                              |
| 关闭 Bug                | `zentao bug close <id>`                                |
| 激活 Bug                | `zentao bug activate <id>`                             |
| 创建需求                | `zentao story create ...`                              |
| 变更/关闭/激活需求      | `zentao story change/close/activate <id>`              |
| 业务需求                | `zentao epic ...`（同 story）                          |
| 用户需求                | `zentao requirement ...`（同 story）                   |
| 创建/启动/完成/关闭任务 | `zentao task create/start/finish/close ...`            |
| 测试用例                | `zentao testcase ...`                                  |
| 测试单                  | `zentao testtask ...`                                  |
| 产品计划                | `zentao productplan ...`                               |
| 版本/Build              | `zentao build ...`                                     |
| 发布                    | `zentao release ...`                                   |
| 反馈                    | `zentao feedback ...`                                  |
| 工单                    | `zentao ticket ...`                                    |
| 用户列表                | `zentao user`                                          |
| 当前用户信息            | `zentao profile`                                       |

## 错误处理

| 错误码 | 含义            | 处理方式                                                                    |
| ------ | --------------- | --------------------------------------------------------------------------- |
| E1001  | 未登录/凭证缺失 | 执行 `zentao login`                                                         |
| E1004  | Token 失效      | 执行 `zentao login` 重新登录                                                |
| E2001  | 模块不存在      | 执行 `zentao help` 查看可用模块                                             |
| E2002  | 对象不存在      | 检查 ID 是否正确                                                            |
| E2003  | 缺少必要参数    | 执行 `zentao <module> help` 或 `zentao <module> <action> help` 查看操作参数 |
| E2006  | 无权限          | 提示用户检查权限                                                            |
| E2008  | 服务端业务校验失败 | 查看返回 JSON 里的 `message` 字段定位具体原因（如日期/必填字段校验）            |
| E2009  | 参数值无效      | 必填参数未提供，执行 `zentao <module> <action> help` 查看必填项               |
| E5001  | 请求超时        | 检查网络或禅道服务状态                                                      |

## 踩坑记录

- **file 模块不支持上传附件**：只支持编辑名称 + 删除，上传附件需到禅道 Web 端手动操作
- **task finish 必填参数**：官方示例 `--consumed=4` 有误——必填的是 `--currentConsumed`、`--realStarted`、`--finishedDate`，日期必须带时间（`YYYY-MM-DD HH:mm:ss`），纯日期会报"实际完成不能小于实际开始"
- **任务无原生评审状态**：需要评审时只能通过 `--assignedTo` 重新指派，不能走状态流转
- **CLI 参数名不一致**：task 用 `--name`，bug 用 `--title`；task finish 用 `--currentConsumed`（非 `--consumed`）
- **搜索必须配合 `--search-fields`**：`--search=关键词` 单独使用可能无效
- **模糊搜索可能匹配不全**：搜不到时尝试缩短关键词，或直接列表 + `--pick` 人工筛选

## 注意事项

- 不确定模块参数时，先执行 `zentao <module> help` 查看帮助，不确定操作参数时，先执行 `zentao <module> <action> help` 查看帮助
- `browseType` 常用值：`all`（全部）、`doing`（进行中）、`closed`（已关闭）
- 多账号切换：`zentao profile` 查看和切换账号
