<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const elapsed = ref(0);
let timer: ReturnType<typeof setInterval>;

onMounted(() => {
  timer = setInterval(() => {
    elapsed.value += 1;
  }, 1000);
});

onUnmounted(() => {
  clearInterval(timer);
});

function _formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}
</script>

<template>
  <div class="not-found">
    <div class="nf-inner">
      <div class="nf-terminal">
        <div class="nf-term-header">
          <span class="nf-dot" style="background:#ef4444"></span>
          <span class="nf-dot" style="background:#f59e0b"></span>
          <span class="nf-dot" style="background:#22c55e"></span>
          <span class="nf-term-title">rcs — session lost</span>
        </div>
        <div class="nf-term-body">
          <div class="nf-line">
            <span class="nf-prompt">$</span> rcs resolve --path "{{ $route.path }}"
          </div>
          <div class="nf-line nf-error">
            Error: Resource not found (404)
          </div>
          <div class="nf-line nf-dim">
            The requested page does not exist or has been moved.
          </div>
          <div class="nf-spacer"></div>
          <div class="nf-line nf-dim">
            Session uptime: {{ formatTime(elapsed) }}
          </div>
          <div class="nf-cursor"></div>
        </div>
      </div>

      <div class="nf-actions">
        <a href="/" class="nf-btn-primary">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          Home
        </a>
        <a href="/guide/getting-started" class="nf-btn-ghost">Documentation</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
}

.nf-inner {
  width: 100%;
  max-width: 560px;
  text-align: center;
}

.nf-terminal {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  overflow: hidden;
  text-align: left;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
}

.nf-term-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-mute);
}

.nf-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.nf-term-title {
  flex: 1;
  text-align: center;
  font-size: 12px;
  color: var(--vp-c-text-3);
  font-family: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
}

.nf-term-body {
  padding: 24px;
  font-family: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
}

.nf-line {
  white-space: pre-wrap;
  word-break: break-all;
}

.nf-prompt {
  color: var(--vp-c-brand-1);
  font-weight: 700;
  margin-right: 8px;
}

.nf-error { color: #ef4444; font-weight: 600; }
.nf-dim { color: var(--vp-c-text-3); }
.nf-spacer { height: 16px; }

.nf-cursor {
  display: inline-block;
  width: 8px;
  height: 16px;
  background: var(--vp-c-brand-1);
  margin-top: 4px;
  animation: nf-blink 1s steps(2) infinite;
  vertical-align: text-bottom;
}

@keyframes nf-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.nf-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 32px;
}

.nf-btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 22px;
  background: linear-gradient(135deg, #e8853b, #d97b32);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  border-radius: 10px;
  text-decoration: none;
  transition: all 0.3s ease;
  box-shadow: 0 2px 8px rgba(232, 133, 59, 0.25);
}
.nf-btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(232, 133, 59, 0.35);
  color: #fff;
}

.nf-btn-ghost {
  display: inline-flex;
  align-items: center;
  padding: 10px 22px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  font-weight: 500;
  font-size: 14px;
  border-radius: 10px;
  text-decoration: none;
  transition: all 0.25s ease;
  background: var(--vp-c-bg);
}
.nf-btn-ghost:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
</style>
