# apps/web

EE 前端装配入口。`src/shell/enterprise-app-shell.ts` 是 EE 自己的完整最终壳，负责企业首页、SSO 后 Provider、导航与布局；它不继承 CE Shell。assembly 的 `webShell: "enterprise"` 显式选择它。

`web` 区段只从构建期生成的 EE/CE module registry 选择 EE `enterprise-agent-config/web`；后者可组合或替换 CE 的领域页面。资源 contribution 不得决定或覆盖 Shell；配置不能加载任意脚本或远程页面，demo 不引入 React。
