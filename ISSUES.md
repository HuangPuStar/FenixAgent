## 支持 自定义 agent 的 skill 权限配置

需要在配置弹窗中显示一个 tab 页面, skill tab 显示所有的 skill, 然后可以选择禁用启用

```json
{
  "agent": {
    "plan": {
      "permission": {
        "skill": {
          "internal-*": "allow"
        }
      }
    }
  }
}
```

## model 的工具配置也改为 permission 参数

## 分析 <https://opencode.ai/config.json> 中的配置;文件很大, 需要筛选

## skills 的存储目录改为 ~/.agents/skills 目录
