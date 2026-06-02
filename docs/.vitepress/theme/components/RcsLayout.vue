<script setup>
import { useData } from "vitepress";
// biome-ignore lint/correctness/noUnusedImports: used in template as <DefaultTheme.Layout>
import DefaultTheme from "vitepress/theme";

// biome-ignore lint/correctness/useHookAtTopLevel: VitePress useData, not React
const { frontmatter } = useData();
const _isHome = frontmatter.value.layout === "page" && frontmatter.value.home !== false;
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-content-after>
      <div class="nav-version">
        <span class="version-tag">v0.1</span>
      </div>
    </template>

    <template #sidebar-nav-before>
      <div class="sidebar-section-label">Navigation</div>
    </template>

    <template #sidebar-nav-after>
      <div class="sidebar-footer">
        <a
          class="sidebar-footer-link"
          href="https://github.com/konghayao/remote-control-server"
          target="_blank"
          rel="noopener"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
          GitHub
        </a>
      </div>
    </template>

    <template #doc-after>
      <div class="doc-bottom-nav" v-if="!isHome">
        <a href="/" class="back-to-home">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          Back to Home
        </a>
      </div>
    </template>

    <template #footer>
      <div class="rcs-footer">
        <div class="footer-inner">
          <div class="footer-top">
            <div class="footer-brand">
              <img src="/logo.svg" alt="RCS" class="footer-logo" width="28" height="28" />
              <span class="footer-name">Remote Control Server</span>
            </div>
            <div class="footer-links">
              <div class="footer-col">
                <h4>Resources</h4>
                <a href="/guide/getting-started">Getting Started</a>
                <a href="/architecture/overview">Architecture</a>
                <a href="/api/config">API Reference</a>
              </div>
              <div class="footer-col">
                <h4>Community</h4>
                <a href="https://github.com/konghayao/remote-control-server" target="_blank">GitHub</a>
              </div>
            </div>
          </div>
          <div class="footer-bottom">
            <span>Built with Hono + Bun + VitePress</span>
            <span class="footer-copy">&copy; 2024-present KonghaYao</span>
          </div>
        </div>
      </div>
    </template>
  </DefaultTheme.Layout>
</template>

<style scoped>
.nav-version {
  display: flex;
  align-items: center;
  margin-left: 8px;
}

.version-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 2px 10px;
  border-radius: 100px;
}

.sidebar-section-label {
  padding: 12px 16px 8px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--vp-c-text-3);
}

.sidebar-footer {
  padding: 16px;
  margin-top: 12px;
  border-top: 1px solid var(--vp-c-divider);
}

.sidebar-footer-link {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: color 0.2s;
}
.sidebar-footer-link:hover {
  color: var(--vp-c-brand-1);
}

.doc-bottom-nav {
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid var(--vp-c-divider);
}

.back-to-home {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--vp-c-text-3);
  text-decoration: none;
  transition: color 0.2s;
}
.back-to-home:hover {
  color: var(--vp-c-brand-1);
}

.rcs-footer {
  background: var(--vp-c-bg-soft);
  border-top: 1px solid var(--vp-c-divider);
  padding: 48px 24px 32px;
}

.footer-inner {
  max-width: 1200px;
  margin: 0 auto;
}

.footer-top {
  display: flex;
  justify-content: space-between;
  gap: 48px;
  margin-bottom: 40px;
}

.footer-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.footer-logo {
  border-radius: 6px;
}

.footer-name {
  font-weight: 700;
  font-size: 15px;
  color: var(--vp-c-text-1);
}

.footer-links {
  display: flex;
  gap: 64px;
}

.footer-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.footer-col h4 {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--vp-c-text-3);
  margin: 0 0 4px;
}

.footer-col a {
  font-size: 14px;
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: color 0.2s;
}
.footer-col a:hover {
  color: var(--vp-c-brand-1);
}

.footer-bottom {
  display: flex;
  justify-content: space-between;
  padding-top: 24px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 13px;
  color: var(--vp-c-text-3);
}

@media (max-width: 768px) {
  .footer-top {
    flex-direction: column;
    gap: 32px;
  }
  .footer-links {
    gap: 32px;
  }
  .footer-bottom {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
