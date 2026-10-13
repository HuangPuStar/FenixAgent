// web/i18n/namespace.ts
// 本包的 i18n 命名空间标识。
//
// 与 `./index` 分开声明：包内组件只需要命名空间常量，不该因为 `useTranslation(UI_COMPONENTS_NS)`
// 就把两份字典（各 352 键）拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
// 与 `@fenix/resource-observer/web/i18n/namespace` 等 14 个包同形。
//
// 本常量原先声明在 `web/lib/i18n.ts`（`lib/` 下只此一处 i18n 内容），与字典分处两个目录、且名字
// 与 exports 键 `./lib/i18n` 一起把「常量在 lib、字典在 i18n」当成了先例——14 个下游包的
// `web/i18n/namespace.ts` 注释都曾引用该形态。CE 阶段 2 §1.6 将其归位到 `web/i18n/`，避免后续
// 包继续照抄错位布局。旧深链 `@fenix/ui-components/lib/i18n` 已删除（包外无消费者，删除优于兼容）。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner），因此常量也由本包声明。
 *
 * 字面量与字典文件名 `web/i18n/locales/{en,zh}/uiComponents.json`、以及宿主 i18n 中心表
 * `@fenix/web-runtime/i18n/namespace` 的 `UI_COMPONENTS` 三处必须一致：宿主切换为经包入口注册后，
 * 这三处是同一个命名空间的三个视图（一致性由 `web/__tests__/i18n-barrel.test.ts` 断言）。
 */
export const UI_COMPONENTS_NS = "uiComponents";
