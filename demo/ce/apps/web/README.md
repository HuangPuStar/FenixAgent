# apps/web

CE 前端装配入口。`src/shell/community-app-shell.ts` 是 CE 自己的最终应用壳，负责首页、布局、导航与全局 Provider（demo 用对象代替 React）。assembly 的 `webShell: "community"` 显式选择它。

`web` 区段只从构建期生成的 module registry 选择已编译的资源模块 `./web` contribution；页面、API client 和 i18n 归资源模块自身。资源 contribution 不得决定或覆盖 Shell，配置也不会导入 server、任意文件或远程脚本。
