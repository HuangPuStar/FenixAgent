const TRANSLATIONS: Record<string, string> = {
  empty: "暂无 MCP 插件",
  emptyHint: "点击「新建服务器」创建第一个 MCP 插件",
  emptySearch: "没有匹配的 MCP 插件",
  emptySearchHint: "换个关键词或切换筛选范围",
  "formDialog.save": "保存",
  "formDialog.cancel": "取消",
  "loadState.retry": "重试",
  "loadState.title": "无法加载插件目录",
  "loadState.unauthorizedTitle": "无权查看插件目录",
  "loadState.unauthorizedHint": "当前账号或所属组织已无权访问 MCP 插件，重试不会改变结果。",
  "dialog.editTitle": "编辑 MCP 服务器",
  "dialog.loadDetailFailed": "无法读取该服务器的配置",
  "dialog.loadDetailFailedHint": "现在保存只会再报一次校验错误，请重试或关闭后重新打开。",
  "validation.nameRequired": "名称不能为空",
  "validation.urlRequired": "URL 不能为空",
};

/** 稳定的翻译替身，避免加载 effect 因 t 引用变化而反复请求；插值沿用 {{var}} 语义。 */
export function translate(key: string, opts?: Record<string, unknown>): string {
  let result = TRANSLATIONS[key] ?? key;
  for (const [name, value] of Object.entries(opts ?? {})) {
    result = result.replace(`{{${name}}}`, String(value));
  }
  return result;
}
