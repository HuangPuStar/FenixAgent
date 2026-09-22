/**
 * 记忆详情的类型标题 —— 详情弹窗（`MemoryDetailModal`）与图谱节点详情面板（`MemoryDetailPanel`）
 * 此前各写一份逐字相同的分支，且**面板读的是弹窗的字典键**（`memoryDetailModal.typeObservation` 一族）。
 *
 * 那种借用在 i18n 层是不可见的隐式依赖：弹窗改一次措辞、面板跟着变，而面板的字典里查不到这些键，
 * 排查时只能靠全文搜索。共用键因而落到共同前缀 `memoryDetail.*` 下——两侧都读它，谁也不欠谁；
 * 四个词条的中英文措辞与迁移前逐字相同（面板本来就显示弹窗的那份价值观）。
 *
 * 未收录的类型回落到 `memoryDetail.defaultTitle`（"记忆详情"），与两个外壳迁移前的兜底文案一致：
 * 新类型上线时先显示通用标题，而不是把后端的英文枚举值上屏。
 *
 * `t` 按需注入（不 import i18n）：本模块是纯逻辑，能在没有 i18next 单例的用例里直接断言。
 */
export function memoryTypeTitle(t: (key: string) => string, type: string | null | undefined): string {
  if (type === "observation") return t("memoryDetail.typeObservation");
  if (type === "world") return t("memoryDetail.typeWorldFact");
  if (type === "experience") return t("memoryDetail.typeExperience");
  return t("memoryDetail.defaultTitle");
}
