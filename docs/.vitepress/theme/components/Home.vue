<script setup>
const _features = [
  {
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
    title: "ACP 协议",
    desc: "WebSocket 双向通信，远程控制 AI Agent，事件流实时转发与多实例隔离管理",
    span: "col",
  },
  {
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
    title: "配置管理",
    desc: "Providers / Models / Agents / Skills / MCP 动态配置，修改实时生效",
    span: "row",
  },
  {
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    title: "会话监控",
    desc: "SSE 实时推送，消息流 / 工具调用 / 权限请求完整可视化",
    span: "row",
  },
  {
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    title: "认证授权",
    desc: "better-auth 用户体系 + per-user API Key，双认证层安全控制",
    span: "col",
  },
  {
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    title: "定时任务",
    desc: "cron 调度 HTTP 请求，执行历史 / 失败重试 / 状态追踪",
    span: "row",
  },
  {
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3-3 3 3"/></svg>`,
    title: "文件系统",
    desc: "会话级文件读写上传，iframe 预览，Agent 工作区文件能力",
    span: "row",
  },
];

const _stack = [
  { name: "Elysia", color: "#a855f7" },
  { name: "Bun", color: "#fbf0df" },
  { name: "React", color: "#61dafb" },
  { name: "PostgreSQL", color: "#4169e1" },
  { name: "WebSocket", color: "#a855f7" },
  { name: "SSE", color: "#22c55e" },
];
</script>

<template>
  <div class="home">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-inner">
        <div class="hero-content">
          <div class="hero-badge">ACP Agent Platform</div>
          <h1 class="hero-title">
            Fenix<span class="hero-title-accent">Agent</span>
          </h1>
          <p class="hero-desc">
            基于 Elysia + Bun 的 AI Agent 智能控制平台。通过 ACP 协议远程管理 Agent 生命周期、实时监控会话事件、动态配置运行参数。
          </p>
          <div class="hero-actions">
            <a href="/FenixAgent/user/" class="btn-primary">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              快速开始
            </a>
            <a href="https://github.com/konghayao/remote-control-server" target="_blank" class="btn-ghost">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
              GitHub
            </a>
          </div>
        </div>
        <div class="hero-visual">
          <div class="terminal">
            <div class="terminal-header">
              <span class="terminal-dot red"></span>
              <span class="terminal-dot yellow"></span>
              <span class="terminal-dot green"></span>
              <span class="terminal-title">fenix-agent — acp-link</span>
            </div>
            <div class="terminal-body">
              <div class="term-line"><span class="term-prompt">$</span> bun run dev</div>
              <div class="term-line term-dim">✓ Server running on :3000</div>
              <div class="term-line term-dim">✓ acp-link registered: my-agent</div>
              <div class="term-line term-dim">✓ Session created: ses_a3f8c2</div>
              <div class="term-spacer"></div>
              <div class="term-line"><span class="term-event">→</span> <span class="term-label">session</span> <span class="term-dim">user: "帮我分析这段代码"</span></div>
              <div class="term-line"><span class="term-event">→</span> <span class="term-label">tool_use</span> <span class="term-dim">read(src/index.ts)</span></div>
              <div class="term-line"><span class="term-event">←</span> <span class="term-label">tool_result</span> <span class="term-dim">200 OK · 1.2s</span></div>
              <div class="term-line"><span class="term-event">←</span> <span class="term-label">assistant</span> <span class="term-dim">"这段代码..."</span></div>
              <div class="term-cursor"></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Tech Stack -->
    <section class="stack-bar">
      <div class="stack-inner">
        <span class="stack-label">Tech Stack</span>
        <div class="stack-items">
          <span
            v-for="item in stack"
            :key="item.name"
            class="stack-chip"
          >
            <span class="stack-dot" :style="{ background: item.color }"></span>
            {{ item.name }}
          </span>
        </div>
      </div>
    </section>

    <!-- Features Bento Grid -->
    <section class="features">
      <div class="features-inner">
        <div class="features-header">
          <h2 class="features-title">核心能力</h2>
          <p class="features-desc">为 AI Agent 提供完整的控制、监控与配置基础设施</p>
        </div>
        <div class="bento">
          <div
            v-for="(f, i) in features"
            :key="i"
            :class="['bento-card', f.span]"
          >
            <div class="bento-icon" v-html="f.icon"></div>
            <div class="bento-body">
              <h3>{{ f.title }}</h3>
              <p>{{ f.desc }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="cta">
      <div class="cta-inner">
        <h2>开始使用</h2>
        <p>几行命令即可启动你的 Agent 控制面板</p>
        <div class="cta-code">
          <code>git clone https://github.com/konghayao/remote-control-server && bun install && bun run dev</code>
        </div>
        <a href="/FenixAgent/user/" class="btn-primary">阅读文档</a>
      </div>
    </section>
  </div>
</template>
