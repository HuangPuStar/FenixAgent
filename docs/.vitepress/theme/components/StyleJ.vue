<script setup>
import { onMounted, onUnmounted, ref } from "vue";

// THREE loaded from unpkg CDN at mount time — no npm dependency
let THREE = null;

const features = [
  {
    num: "01",
    title: "ACP 协议",
    desc: "WebSocket 双向通信，远端控制 Agent 生命周期，事件流实时转发与多实例隔离管理",
    tags: ["实时", "双向", "多实例"],
  },
  {
    num: "02",
    title: "配置管理",
    desc: "Providers / Models / Agents / Skills / MCP 动态配置，修改实时生效，零重启热更新",
    tags: ["热更新", "零重启"],
  },
  {
    num: "03",
    title: "会话监控",
    desc: "SSE 实时推送，消息流 / 工具调用 / 权限请求完整可视化追踪",
    tags: ["SSE", "可视化"],
  },
  {
    num: "04",
    title: "认证授权",
    desc: "better-auth 多租户体系 + per-user API Key，双重安全控制层",
    tags: ["多租户", "API Key"],
  },
  { num: "05", title: "定时任务", desc: "cron 调度 HTTP 请求，执行历史 / 失败重试 / 状态追踪", tags: ["cron", "重试"] },
  {
    num: "06",
    title: "文件系统",
    desc: "会话级文件读写上传，iframe 预览，Agent 工作区完整文件能力",
    tags: ["文件", "预览"],
  },
];

const stats = [
  { value: "6+", label: "核心模块" },
  { value: "ACP", label: "通信协议" },
  { value: "WS", label: "传输层" },
  { value: "24/7", label: "持续运行" },
];

const stack = ["HONO", "BUN", "REACT 19", "POSTGRESQL", "WEBSOCKET", "SSE"];

// ── Three.js White Hole ──────────────────────────────────
const canvasContainer = ref(null);
let animationId = null;

// ── Control panel reactive params ─────────────────────────
const activeTheme = ref(0); // 0=supernova, 1=aurora, 2=geometric
const ctrlShowPanel = ref(true);

function createGlowTexture(innerColor, outerColor) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, innerColor);
  gradient.addColorStop(0.05, innerColor);
  gradient.addColorStop(0.15, innerColor.replace("1)", "0.85)"));
  gradient.addColorStop(0.35, outerColor.replace("1)", "0.45)"));
  gradient.addColorStop(0.6, outerColor.replace("1)", "0.08)"));
  gradient.addColorStop(0.85, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createParticleTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(180,225,255,1)");
  gradient.addColorStop(0.03, "rgba(160,215,255,0.95)");
  gradient.addColorStop(0.08, "rgba(100,180,255,0.7)");
  gradient.addColorStop(0.18, "rgba(22,119,255,0.18)");
  gradient.addColorStop(0.35, "rgba(22,119,255,0.02)");
  gradient.addColorStop(0.55, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

onMounted(async () => {
  if (!canvasContainer.value) return;

  // Load Three.js from unpkg CDN (no npm dependency)
  if (!window.THREE) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/three@0.157.0/build/three.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Failed to load Three.js from unpkg"));
      document.head.appendChild(script);
    });
  }
  THREE = window.THREE;

  const container = canvasContainer.value;
  const width = window.innerWidth;
  const height = window.innerHeight;

  // Scene
  const scene = new THREE.Scene();

  // Camera
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 200);
  camera.position.set(0, 0, 32);
  camera.lookAt(0, 0, 0);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.position = "fixed";
  renderer.domElement.style.top = "0";
  renderer.domElement.style.left = "0";
  renderer.domElement.style.zIndex = "0";
  renderer.domElement.style.pointerEvents = "none";

  // Root group - slowly rotates
  const rootGroup = new THREE.Group();
  scene.add(rootGroup);

  // ── Core glow sprites ──
  const glowTexWhite = createGlowTexture("rgba(180,225,255,1)", "rgba(100,180,255,1)");
  const glowTexBlue = createGlowTexture("rgba(160,215,255,1)", "rgba(22,119,255,1)");
  const coreSprites = [];

  // Large outer glow
  const outerGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexBlue,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      opacity: 0.35,
      transparent: true,
    }),
  );
  outerGlow.scale.set(20, 20, 1);
  rootGroup.add(outerGlow);
  coreSprites.push(outerGlow);

  // Mid glow
  const midGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexWhite,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      opacity: 0.55,
      transparent: true,
    }),
  );
  midGlow.scale.set(11, 11, 1);
  rootGroup.add(midGlow);
  coreSprites.push(midGlow);

  // Inner bright core
  const innerGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexWhite,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      opacity: 0.9,
      transparent: true,
    }),
  );
  innerGlow.scale.set(4.5, 4.5, 1);
  rootGroup.add(innerGlow);
  coreSprites.push(innerGlow);

  // ==== THEME 0: VORTEX STORM ====
  const t0Group = new THREE.Group();
  rootGroup.add(t0Group);

  const particleTex = createParticleTexture();

  // Background dust
  const dustCount = 400;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(dustCount * 3);
  const dustCol = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 50;
    dustPos[i * 3 + 1] = (Math.random() - 0.5) * 50;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 10 - 2;
    const c = new THREE.Color();
    c.setHSL(0.57 + (Math.random() - 0.5) * 0.06, 0.3, 0.35 + Math.random() * 0.25);
    dustCol[i * 3] = c.r;
    dustCol[i * 3 + 1] = c.g;
    dustCol[i * 3 + 2] = c.b;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute("color", new THREE.BufferAttribute(dustCol, 3));
  const dustMat = new THREE.PointsMaterial({
    size: 0.14,
    map: particleTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.3,
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  scene.add(dustPoints);

  // Vortex particles
  const vxCount = 2500;
  const vxGeo = new THREE.BufferGeometry();
  const vxPos = new Float32Array(vxCount * 3);
  const vxCol = new Float32Array(vxCount * 3);
  const vxPhase = new Float32Array(vxCount);
  const vxBaseR = new Float32Array(vxCount);
  const vxSpeed = new Float32Array(vxCount);

  for (let i = 0; i < vxCount; i++) {
    const idx = i * 3;
    const h = Math.random() * 25 - 10; // height -10 to 15
    const r = (1 - h / 20) * 10 + 1; // wider at bottom
    const a = Math.random() * Math.PI * 2;
    vxPos[idx] = Math.cos(a) * r + (Math.random() - 0.5) * 1.2;
    vxPos[idx + 1] = h;
    vxPos[idx + 2] = Math.sin(a) * r + (Math.random() - 0.5) * 1.2;
    vxPhase[i] = Math.random() * Math.PI * 2;
    vxBaseR[i] = r;
    vxSpeed[i] = 0.4 + Math.random() * 1.2;
    const color = new THREE.Color();
    color.setHSL(0.58 + Math.random() * 0.04, 0.6 + Math.random() * 0.25, 0.4 + Math.random() * 0.35);
    vxCol[idx] = color.r;
    vxCol[idx + 1] = color.g;
    vxCol[idx + 2] = color.b;
  }
  vxGeo.setAttribute("position", new THREE.BufferAttribute(vxPos, 3));
  vxGeo.setAttribute("color", new THREE.BufferAttribute(vxCol, 3));
  const vxMat = new THREE.PointsMaterial({
    size: 0.38,
    map: particleTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
  });
  const vxPoints = new THREE.Points(vxGeo, vxMat);
  t0Group.add(vxPoints);

  // ==== THEME 1: WARP SPEED ====
  const t1Group = new THREE.Group();
  t1Group.visible = false;
  rootGroup.add(t1Group);

  const wsCount = 2000;
  const wsGeo = new THREE.BufferGeometry();
  const wsPos = new Float32Array(wsCount * 3);
  const wsCol = new Float32Array(wsCount * 3);
  const wsDir = new Float32Array(wsCount * 3);
  const wsDist = new Float32Array(wsCount);
  const wsSpeed = new Float32Array(wsCount);
  const wsMaxDist = new Float32Array(wsCount);

  for (let i = 0; i < wsCount; i++) {
    const idx = i * 3;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    wsDir[idx] = Math.sin(phi) * Math.cos(theta);
    wsDir[idx + 1] = Math.sin(phi) * Math.sin(theta);
    wsDir[idx + 2] = Math.cos(phi);
    wsDist[i] = Math.random() * 20;
    wsSpeed[i] = 0.3 + Math.random() * 4;
    wsMaxDist[i] = 12 + Math.random() * 30;
    wsPos[idx] = wsDir[idx] * wsDist[i];
    wsPos[idx + 1] = wsDir[idx + 1] * wsDist[i];
    wsPos[idx + 2] = wsDir[idx + 2] * wsDist[i] * 0.4; // flatten Z for screen warp
    const color = new THREE.Color();
    const dNorm = wsDist[i] / wsMaxDist[i];
    color.setHSL(0.58 + dNorm * 0.04, 0.5 + dNorm * 0.3, 0.55 + dNorm * 0.4);
    wsCol[idx] = color.r;
    wsCol[idx + 1] = color.g;
    wsCol[idx + 2] = color.b;
  }
  wsGeo.setAttribute("position", new THREE.BufferAttribute(wsPos, 3));
  wsGeo.setAttribute("color", new THREE.BufferAttribute(wsCol, 3));
  const wsMat = new THREE.PointsMaterial({
    size: 0.45,
    map: particleTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.65,
  });
  const wsPoints = new THREE.Points(wsGeo, wsMat);
  t1Group.add(wsPoints);

  // ==== THEME 2: PULSE RINGS ====
  const t2Group = new THREE.Group();
  t2Group.visible = false;
  rootGroup.add(t2Group);

  const prRings = 8;
  const prPerRing = 300;
  const prTotal = prRings * prPerRing;
  const prGeo = new THREE.BufferGeometry();
  const prPos = new Float32Array(prTotal * 3);
  const prCol = new Float32Array(prTotal * 3);
  const prRadius = new Float32Array(prRings);
  const prPhase = new Float32Array(prRings);
  const prIdxOff = new Float32Array(prRings);

  for (let r = 0; r < prRings; r++) {
    prRadius[r] = 1 + r * 2.8;
    prPhase[r] = Math.random() * Math.PI * 2;
    prIdxOff[r] = r * prPerRing;
  }

  for (let r = 0; r < prRings; r++) {
    for (let j = 0; j < prPerRing; j++) {
      const i = r * prPerRing + j;
      const idx = i * 3;
      const a = (j / prPerRing) * Math.PI * 2;
      prPos[idx] = Math.cos(a) * prRadius[r] + (Math.random() - 0.5) * 0.6;
      prPos[idx + 1] = (Math.random() - 0.5) * 0.8;
      prPos[idx + 2] = Math.sin(a) * prRadius[r] + (Math.random() - 0.5) * 0.6;
      const color = new THREE.Color();
      color.setHSL(0.57 + r * 0.03, 0.6 + r * 0.04, 0.45 + r * 0.05);
      prCol[idx] = color.r;
      prCol[idx + 1] = color.g;
      prCol[idx + 2] = color.b;
    }
  }
  prGeo.setAttribute("position", new THREE.BufferAttribute(prPos, 3));
  prGeo.setAttribute("color", new THREE.BufferAttribute(prCol, 3));
  const prMat = new THREE.PointsMaterial({
    size: 0.22,
    map: particleTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
  });
  const prPoints = new THREE.Points(prGeo, prMat);
  t2Group.add(prPoints);

  // ── Animation ──
  const clock = new THREE.Clock();

  function animate() {
    animationId = requestAnimationFrame(animate);

    const elapsed = clock.getElapsedTime();
    const t = activeTheme.value;

    t0Group.visible = t === 0;
    t1Group.visible = t === 1;
    t2Group.visible = t === 2;

    const orbitR = 9;
    camera.position.x = Math.sin(elapsed * 0.18) * orbitR;
    camera.position.y = Math.cos(elapsed * 0.13) * 2.5;
    camera.position.z = 32 + Math.cos(elapsed * 0.18) * orbitR * 0.5;
    camera.lookAt(0, 0, 0);

    rootGroup.rotation.z += 0.0006;

    if (t === 0) {
      // ── VORTEX: spiral upward ──
      const posArr = vxGeo.attributes.position.array;
      for (let i = 0; i < vxCount; i++) {
        const idx = i * 3;
        const rawH = vxPhase[i] * 4 + elapsed * vxSpeed[i] * 0.6; // continuously increasing
        const h = (rawH % 25) - 12;
        const a = vxPhase[i] * 1.7 + h * 0.8 + elapsed * 1.2;
        const r = vxBaseR[i] * (1 - (h + 12) / 30);
        vxPos[idx] = Math.cos(a) * Math.max(0.3, r) + Math.sin(elapsed * 2 + vxPhase[i]) * 0.5;
        vxPos[idx + 1] = h;
        vxPos[idx + 2] = Math.sin(a) * Math.max(0.3, r) + Math.cos(elapsed * 2.3 + vxPhase[i]) * 0.5;
      }
      vxGeo.attributes.position.needsUpdate = true;
    } else if (t === 1) {
      // ── WARP SPEED: streak outward ──
      const posArr = wsGeo.attributes.position.array;
      for (let i = 0; i < wsCount; i++) {
        const idx = i * 3;
        wsDist[i] += wsSpeed[i] * 0.15;
        if (wsDist[i] > wsMaxDist[i]) wsDist[i] = 0.2 + Math.random() * 1.5;
        posArr[idx] = wsDir[idx] * wsDist[i];
        posArr[idx + 1] = wsDir[idx + 1] * wsDist[i];
        posArr[idx + 2] = wsDir[idx + 2] * wsDist[i] * 0.35;
      }
      wsGeo.attributes.position.needsUpdate = true;
      t1Group.rotation.z += 0.0003;
    } else {
      // ── PULSE RINGS: expand and fade ──
      const posArr = prGeo.attributes.position.array;
      for (let r = 0; r < prRings; r++) {
        prRadius[r] += 0.06;
        if (prRadius[r] > 22) prRadius[r] = 0.5 + Math.random() * 2;
        const off = prIdxOff[r];
        for (let j = 0; j < prPerRing; j++) {
          const idx = (off + j) * 3;
          const a = (j / prPerRing) * Math.PI * 2;
          posArr[idx] = Math.cos(a) * prRadius[r] + (posArr[idx] - Math.cos(a) * prRadius[r]) * 0.98;
          posArr[idx + 1] *= 0.99;
          posArr[idx + 2] = Math.sin(a) * prRadius[r] + (posArr[idx + 2] - Math.sin(a) * prRadius[r]) * 0.98;
        }
      }
      prGeo.attributes.position.needsUpdate = true;
      t2Group.rotation.x += 0.0004;
      t2Group.rotation.y += 0.0003;
    }

    const pulse = 1 + Math.sin(elapsed * 0.8) * 0.04 + Math.sin(elapsed * 1.7) * 0.02;
    coreSprites.forEach((sprite, i) => {
      const baseScale = [20, 11, 4.5][i];
      sprite.scale.set(baseScale * pulse, baseScale * pulse, 1);
      sprite.material.opacity = [0.35, 0.55, 0.9][i] * (0.95 + Math.sin(elapsed * 0.8 + i) * 0.05);
    });

    dustPoints.rotation.y += 0.0001;
    dustPoints.rotation.z += 0.00008;

    renderer.render(scene, camera);
  }

  animate();

  // ── Resize handler ──
  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  // ── Cleanup ──
  onUnmounted(() => {
    window.removeEventListener("resize", onResize);
    if (animationId) cancelAnimationFrame(animationId);
    renderer.dispose();
    if (container.contains(renderer.domElement)) {
      container.removeChild(renderer.domElement);
    }
    [vxGeo, wsGeo, prGeo, dustGeo].forEach((g) => g.dispose());
    [vxMat, wsMat, prMat, dustMat].forEach((m) => m.dispose());
    glowTexWhite.dispose();
    glowTexBlue.dispose();
    particleTex.dispose();
  });
});
</script>

<template>
  <div class="tec-root">
    <!-- Three.js White Hole canvas -->
    <div ref="canvasContainer" class="tec-canvas-container"></div>

    <!-- HEADER -->
    <nav class="tec-header">
      <div class="tec-header-inner">
        <div class="tec-header-brand">
          <span class="tec-logo-icon">◆</span>
          <span class="tec-logo-text">RCS</span>
          <span class="tec-logo-version">v0.1</span>
        </div>
        <div class="tec-header-nav">
          <a href="/guide/getting-started" class="tec-nav-link">文档</a>
          <a href="#" class="tec-nav-link">API</a>
          <a href="https://github.com/konghayao/remote-control-server" target="_blank" class="tec-nav-link">GitHub</a>
        </div>
        <div class="tec-header-right">
          <span class="tec-status-dot"></span>
          <span class="tec-status-label">RUNNING</span>
          <a href="/guide/getting-started" class="tec-header-cta">Get Started →</a>
        </div>
      </div>
    </nav>

    <!-- HERO -->
    <header class="tec-hero">
      <span class="tec-hero-tag">AGENT CONTROL PANEL</span>
      <div class="tec-hero-body">
        <div class="tec-hero-bracket tec-bracket-tl">
          <span class="tec-bracket-line tec-bl-h"></span>
          <span class="tec-bracket-line tec-bl-v"></span>
        </div>
        <div class="tec-hero-bracket tec-bracket-br">
          <span class="tec-bracket-line tec-bl-h"></span>
          <span class="tec-bracket-line tec-bl-v"></span>
        </div>
        <div class="tec-hero-content">
          <h1 class="tec-title">
            Remote Control<br /><span class="tec-title-accent">Server</span>
          </h1>
          <p class="tec-desc">
            基于 Hono + Bun 构建的高性能 AI Agent 控制面板。
            通过 ACP 协议远程管理 Agent 生命周期、实时监控会话事件、动态配置运行参数。
          </p>
          <div class="tec-hero-actions">
            <a href="/guide/getting-started" class="tec-btn">快速开始</a>
            <a href="https://github.com/konghayao/remote-control-server" target="_blank" class="tec-btn-outline">GitHub</a>
          </div>
        </div>
      </div>
    </header>

    <!-- SECTION BREAK -->
    <div class="tec-break">
      <div class="tec-break-rule"></div>
      <span class="tec-break-mark">◆</span>
      <div class="tec-break-rule"></div>
    </div>

    <!-- FEATURES -->
    <section class="tec-features">
      <div class="tec-features-head">
        <p class="tec-kicker">CORE CAPABILITIES</p>
        <h2 class="tec-sec-title">
          为 AI Agent 提供完整的<br />控制 · 监控 · 配置基础设施
        </h2>
      </div>
      <div class="tec-features-grid">
        <div v-for="(f, i) in features" :key="i" class="tec-card">
          <div class="tec-card-top">
            <span class="tec-card-num">{{ f.num }}</span>
            <h3>{{ f.title }}</h3>
          </div>
          <p>{{ f.desc }}</p>
          <div class="tec-card-tags">
            <span v-for="t in f.tags" :key="t" class="tec-card-tag">{{ t }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- STATS + STACK + TERMINAL (second page) -->
    <section class="tec-showcase">
      <div class="tec-showcase-grid">
        <div class="tec-stats">
          <div v-for="s in stats" :key="s.label" class="tec-stat">
            <span class="tec-stat-value">{{ s.value }}</span>
            <span class="tec-stat-label">{{ s.label }}</span>
          </div>
        </div>
        <div class="tec-stack-panel">
          <div class="tec-stack-head">
            <span class="tec-stack-head-icon">{ }</span>
            <span class="tec-stack-head-text">TECH STACK</span>
          </div>
          <div class="tec-stack-grid">
            <span v-for="s in stack" :key="s" class="tec-stack-chip">{{ s }}</span>
          </div>
        </div>
        <div class="tec-mini-term">
          <div class="tec-term-bar">
            <span class="tec-term-dot tec-td-1"></span>
            <span class="tec-term-dot tec-td-2"></span>
            <span class="tec-term-dot tec-td-3"></span>
            <span class="tec-term-title">acp-link — 127.0.0.1:3000</span>
          </div>
          <div class="tec-term-body">
            <div><span class="tec-t-green">●</span> Server running on :3000</div>
            <div><span class="tec-t-green">●</span> acp-link registered: my-agent</div>
            <div><span class="tec-t-green">●</span> Session created: ses_a3f8c2</div>
            <div class="tec-term-gap"></div>
            <div><span class="tec-t-prompt">&gt;</span> user: "帮我分析这段代码..."</div>
            <div><span class="tec-t-prompt">&lt;</span> assistant "这段代码..."</div>
            <div class="tec-term-cursor">█</div>
          </div>
        </div>
      </div>
    </section>

    <!-- SECTION BREAK -->
    <div class="tec-break">
      <div class="tec-break-rule"></div>
      <span class="tec-break-mark">◆</span>
      <div class="tec-break-rule"></div>
    </div>

    <!-- CTA -->
    <section class="tec-cta">
      <p class="tec-kicker">GET STARTED</p>
      <h2 class="tec-sec-title">几行命令，即刻启动</h2>
      <div class="tec-cta-term">
        <div class="tec-term-bar">
          <span class="tec-term-dot tec-td-1"></span>
          <span class="tec-term-dot tec-td-2"></span>
          <span class="tec-term-dot tec-td-3"></span>
          <span class="tec-term-title">terminal</span>
        </div>
        <div class="tec-cta-term-body">
          <span class="tec-t-prompt">$</span> git clone &lt;repo&gt; && bun install && bun run dev
        </div>
      </div>
      <div class="tec-cta-actions">
        <a href="/guide/getting-started" class="tec-btn">阅读文档</a>
        <a href="https://github.com/konghayao/remote-control-server" target="_blank" class="tec-btn-outline">查看源码</a>
      </div>
    </section>

    <!-- FOOTER -->
    <footer class="tec-footer">
      <div class="tec-footer-grid">
        <div class="tec-footer-col">
          <span class="tec-footer-title">Remote Control Server</span>
          <span class="tec-footer-text">AI Agent 控制面板</span>
        </div>
        <div class="tec-footer-col">
          <span class="tec-footer-title">Tech</span>
          <span class="tec-footer-text">Hono + Bun + React 19</span>
          <span class="tec-footer-text">PostgreSQL + WebSocket</span>
        </div>
        <div class="tec-footer-col">
          <span class="tec-footer-title">License</span>
          <span class="tec-footer-text">© KonghaYao 2024–2026</span>
        </div>
      </div>
    </footer>

    <!-- DEBUG CONTROL PANEL -->
    <div v-if="ctrlShowPanel" class="tec-ctrl-panel">
      <div class="tec-ctrl-head">
        <span class="tec-ctrl-title">{{ activeTheme === 0 ? 'VORTEX' : activeTheme === 1 ? 'WARP' : 'PULSE' }}</span>
        <button class="tec-ctrl-close" @click="ctrlShowPanel = false">×</button>
      </div>
      <div class="tec-ctrl-body">
        <!-- Theme switches -->
        <div class="tec-ctrl-themes">
          <button
            :class="['tec-theme-btn', { active: activeTheme === 0 }]"
            @click="activeTheme = 0"
          >漩涡</button>
          <button
            :class="['tec-theme-btn', { active: activeTheme === 1 }]"
            @click="activeTheme = 1"
          >曲速</button>
          <button
            :class="['tec-theme-btn', { active: activeTheme === 2 }]"
            @click="activeTheme = 2"
          >脉冲</button>
        </div>
      </div>
    </div>
    <button v-if="!ctrlShowPanel" class="tec-ctrl-toggle" @click="ctrlShowPanel = true">⚙</button>
  </div>
</template>

<style scoped>
/* =============================================
   STYLE J — TECH MAXIMALIST (IT Product)
   with Three.js White Hole Background
   ============================================= */

@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Noto+Sans+SC:wght@400;500;600;700;900&family=Fira+Code:wght@400;500;600;700&display=swap');

.tec-root {
  --brand: #1677ff;
  --brand-dim: rgba(22, 119, 255, 0.06);
  --brand-med: rgba(22, 119, 255, 0.12);
  --brand-hover: #1255cc;
  --bg: #fcfcfb;
  --bg-card: #f6f7f9;
  --bg-panel: #f1f2f5;
  --ink: #0f172a;
  --ink-soft: #475569;
  --ink-muted: #94a3b8;
  --rule: #e2e8f0;
  --rule-dark: #cbd5e1;

  background: var(--bg);
  color: var(--ink);
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

/* Three.js canvas container */
.tec-canvas-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}

/* ---- HEADER ---- */
.tec-header {
  position: sticky; top: 0; z-index: 100;
  background: rgba(252, 252, 251, 0.88);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border-bottom: 1px solid var(--rule);
}

.tec-header-inner {
  max-width: 1200px; margin: 0 auto;
  display: flex; align-items: center;
  padding: 0 40px; height: 64px; gap: 36px;
}

.tec-header-brand {
  display: flex; align-items: center; gap: 10px;
}

.tec-logo-icon {
  font-size: 15px; color: var(--brand);
}

.tec-logo-text {
  font-family: 'Inter', sans-serif;
  font-size: 17px; font-weight: 800;
  color: var(--ink);
  letter-spacing: -0.03em;
}

.tec-logo-version {
  font-family: 'Fira Code', monospace;
  font-size: 9px; font-weight: 500;
  color: var(--ink-muted);
  padding: 2px 7px;
  border: 1px solid var(--rule);
}

.tec-header-nav {
  display: flex; align-items: center; gap: 24px;
  flex: 1;
}

.tec-nav-link {
  font-size: 13px; font-weight: 500;
  color: var(--ink-soft);
  text-decoration: none;
  transition: color 0.15s;
}
.tec-nav-link:hover { color: var(--brand); }

.tec-header-right {
  display: flex; align-items: center; gap: 10px;
}

.tec-status-dot {
  width: 7px; height: 7px;
  background: #22c55e;
  border-radius: 50%;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.3);
  animation: tec-pulse 2s ease-in-out infinite;
}

@keyframes tec-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.tec-status-label {
  font-family: 'Fira Code', monospace;
  font-size: 10px; font-weight: 600;
  color: var(--ink-muted);
  letter-spacing: 0.08em;
}

.tec-header-cta {
  font-size: 12px; font-weight: 600;
  color: #fff;
  background: var(--brand);
  padding: 7px 16px;
  border-radius: 6px;
  text-decoration: none;
  transition: background 0.15s;
  white-space: nowrap;
}
.tec-header-cta:hover { background: var(--brand-hover); }

/* ---- HERO ---- */
.tec-hero {
  position: relative; z-index: 1;
  padding: 100px 40px 48px;
  min-height: 85vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.tec-hero-body {
  max-width: 780px; margin: 0 auto;
  position: relative;
  border: 1px solid var(--rule-dark);
  padding: 4px;
}

.tec-hero-bracket {
  position: absolute;
  width: 24px; height: 24px;
  z-index: 2;
}
.tec-bracket-tl { top: -1px; left: -1px; }
.tec-bracket-br { bottom: -1px; right: -1px; }
.tec-bracket-tl .tec-bl-h { top: 0; left: 0; }
.tec-bracket-tl .tec-bl-v { top: 0; left: 0; }
.tec-bracket-br .tec-bl-h { bottom: 0; right: 0; }
.tec-bracket-br .tec-bl-v { bottom: 0; right: 0; }

.tec-bracket-line {
  position: absolute;
  background: var(--brand);
}
.tec-bl-h { width: 24px; height: 2px; }
.tec-bl-v { width: 2px; height: 24px; }

.tec-hero-content {
  border: 1px solid var(--rule);
  padding: 48px 44px;
  text-align: center;
}

.tec-hero-tag {
  display: block;
  width: fit-content;
  margin: 0 auto 18px;
  font-family: 'Fira Code', monospace;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--brand);
  background: var(--brand-dim);
  padding: 4px 12px;
  border: 1px solid var(--brand-med);
}

.tec-title {
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
  font-size: clamp(36px, 4.5vw, 52px);
  font-weight: 900;
  line-height: 1.0;
  letter-spacing: -0.03em;
  margin: 0 0 20px;
}

.tec-title-accent {
  color: var(--brand);
}

.tec-desc {
  font-size: 14px; line-height: 1.8;
  color: var(--ink-soft);
  margin: 0 auto 28px;
  max-width: 520px;
}

.tec-hero-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }

/* Showcase: stats + stack + terminal as a standalone section */
.tec-showcase {
  position: relative; z-index: 1;
  padding: 0 40px 48px;
}

.tec-showcase-grid {
  max-width: 780px; margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
}

.tec-btn {
  font-size: 13px; font-weight: 600;
  color: #fff;
  background: var(--brand);
  padding: 10px 22px;
  border-radius: 6px;
  text-decoration: none;
  transition: background 0.15s;
}
.tec-btn:hover { background: var(--brand-hover); }

.tec-btn-outline {
  font-size: 13px; font-weight: 500;
  color: var(--ink-soft);
  padding: 10px 22px;
  border: 1px solid var(--rule-dark);
  border-radius: 6px;
  text-decoration: none;
  transition: all 0.15s;
}
.tec-btn-outline:hover { border-color: var(--brand); color: var(--brand); }

/* STATS */
.tec-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
}

.tec-stat {
  background: #fff;
  padding: 24px 16px;
  text-align: center;
}

.tec-stat-value {
  display: block;
  font-family: 'Inter', sans-serif;
  font-size: 20px; font-weight: 800;
  color: var(--brand);
  margin-bottom: 2px;
}

.tec-stat-label {
  font-family: 'Fira Code', monospace;
  font-size: 9px; font-weight: 500;
  color: var(--ink-muted);
  letter-spacing: 0.06em;
}

/* STACK PANEL */
.tec-stack-panel {
  border: 1px solid var(--rule);
  background: #fff;
  padding: 16px 20px;
}

.tec-stack-head {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin-bottom: 12px;
}

.tec-stack-head-icon {
  font-family: 'Fira Code', monospace;
  font-size: 12px; font-weight: 600;
  color: var(--brand);
}

.tec-stack-head-text {
  font-family: 'Fira Code', monospace;
  font-size: 9px; font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--ink-muted);
}

.tec-stack-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 5px;
}

.tec-stack-chip {
  font-family: 'Fira Code', monospace;
  font-size: 9px; font-weight: 500;
  color: var(--ink-muted);
  border: 1px solid var(--rule);
  padding: 5px 6px;
  text-align: center;
  letter-spacing: 0.03em;
}

/* MINI TERM */
.tec-mini-term {
  border: 1px solid var(--rule-dark);
  background: var(--bg-card);
  overflow: hidden;
}

.tec-term-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--rule);
  background: var(--bg-panel);
}
.tec-term-dot { width: 8px; height: 8px; border-radius: 50%; }
.tec-td-1 { background: #e06060; }
.tec-td-2 { background: #e0c060; }
.tec-td-3 { background: #60a060; }

.tec-term-title {
  flex: 1; text-align: center;
  font-family: 'Inter', sans-serif;
  font-size: 10px; font-weight: 500;
  color: var(--ink-muted);
}

.tec-term-body {
  padding: 16px 20px;
  font-family: 'Fira Code', monospace;
  font-size: 11px; line-height: 1.75;
  color: var(--ink-soft);
}
.tec-term-gap { height: 8px; }
.tec-t-green { color: #16a34a; font-weight: 600; }
.tec-t-prompt { color: var(--brand); font-weight: 600; }

.tec-term-cursor {
  display: inline-block;
  color: var(--brand);
  animation: tec-blink 1s steps(2) infinite;
  vertical-align: text-bottom;
  margin-top: 4px;
}

@keyframes tec-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ---- SECTION BREAK ---- */
.tec-break {
  display: flex; align-items: center; gap: 14px;
  padding: 24px 40px;
  position: relative; z-index: 1;
  justify-content: center;
}

.tec-break-rule {
  width: 100px; height: 1px;
  background: linear-gradient(90deg, transparent, var(--rule-dark), transparent);
}

.tec-break-mark {
  font-size: 8px; color: var(--rule-dark);
  flex-shrink: 0;
}

/* ---- FEATURES ---- */
.tec-features {
  position: relative; z-index: 1;
  padding: 64px 40px 80px;
}

.tec-features::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background:
    radial-gradient(circle at 15% 40%, var(--brand-dim) 0%, transparent 50%),
    radial-gradient(circle at 85% 30%, var(--brand-dim) 0%, transparent 40%);
  pointer-events: none; z-index: 0;
}

.tec-features-head {
  position: relative; z-index: 1;
  text-align: center;
  max-width: 560px;
  margin: 0 auto 56px;
}

.tec-kicker {
  font-family: 'Fira Code', monospace;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.14em;
  color: var(--ink-muted);
  margin: 0 0 12px;
}

.tec-sec-title {
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
  font-size: 22px; font-weight: 700;
  line-height: 1.5;
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0;
}

.tec-features-grid {
  position: relative; z-index: 1;
  max-width: 1160px; margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
}

.tec-card {
  background: #fff;
  padding: 32px 28px;
  transition: background 0.15s;
}
.tec-card:hover { background: #fafbfd; }

.tec-card-top {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 8px;
}

.tec-card-num {
  font-family: 'Fira Code', monospace;
  font-size: 12px; font-weight: 600;
  color: var(--brand);
  opacity: 0.5;
}

.tec-card h3 {
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
  font-size: 14px; font-weight: 600;
  margin: 0;
}

.tec-card p {
  font-size: 12px; line-height: 1.65;
  color: var(--ink-muted);
  margin: 0 0 12px;
}

.tec-card-tags {
  display: flex; gap: 4px; flex-wrap: wrap;
}

.tec-card-tag {
  font-family: 'Fira Code', monospace;
  font-size: 9px; font-weight: 500;
  color: var(--brand);
  background: var(--brand-dim);
  padding: 2px 8px;
  letter-spacing: 0.03em;
}

/* ---- CTA ---- */
.tec-cta {
  position: relative; z-index: 1;
  padding: 64px 40px 80px;
  text-align: center;
}

.tec-cta-term {
  max-width: 500px; margin: 24px auto 28px;
  border: 1px solid var(--rule-dark);
  overflow: hidden;
  background: var(--bg-card);
}

.tec-cta-term-body {
  padding: 16px 20px;
  font-family: 'Fira Code', monospace;
  font-size: 13px;
  color: var(--ink-soft);
}

.tec-cta-actions {
  display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;
}

/* ---- FOOTER ---- */
.tec-footer {
  position: relative; z-index: 1;
  border-top: 1px solid var(--rule-dark);
  background: var(--bg-panel);
}

.tec-footer-grid {
  max-width: 900px; margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 32px;
  padding: 44px 40px 56px;
}

.tec-footer-col {
  display: flex; flex-direction: column; gap: 6px;
}

.tec-footer-title {
  font-family: 'Inter', sans-serif;
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--ink);
  margin-bottom: 4px;
}

.tec-footer-text {
  font-family: 'Fira Code', monospace;
  font-size: 10px; font-weight: 400;
  color: var(--ink-muted);
}

@media (max-width: 900px) {
  .tec-hero { padding: 40px 20px 32px; }
  .tec-hero-content { padding: 28px 20px; }
  .tec-showcase-grid { grid-template-columns: 1fr; }
  .tec-features-grid { grid-template-columns: 1fr 1fr; }
  .tec-header-inner { padding: 0 20px; }
}

@media (max-width: 600px) {
  .tec-features-grid { grid-template-columns: 1fr; }
  .tec-footer-grid { grid-template-columns: 1fr; gap: 20px; }
  .tec-header-nav { display: none; }
  .tec-header-right { margin-left: auto; }
}

/* ---- CONTROL PANEL (DEBUG) ---- */
.tec-ctrl-panel {
  position: fixed;
  bottom: 20px; right: 20px;
  z-index: 9999;
  width: 260px;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 8px;
  font-family: 'Fira Code', monospace;
  font-size: 11px;
  color: #cbd5e1;
  user-select: none;
}

.tec-ctrl-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.15);
}

.tec-ctrl-title {
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.08em;
  color: #94a3b8;
}

.tec-ctrl-close {
  background: none; border: none;
  color: #94a3b8; font-size: 16px;
  cursor: pointer; padding: 0 4px; line-height: 1;
}
.tec-ctrl-close:hover { color: #fff; }

.tec-ctrl-body {
  padding: 10px 14px 14px;
  display: flex; flex-direction: column; gap: 8px;
}

.tec-ctrl-row {
  display: flex; flex-direction: column; gap: 3px;
}

.tec-ctrl-row span {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; color: #94a3b8;
}

.tec-ctrl-row code {
  color: #38bdf8;
  font-size: 10px;
}

.tec-ctrl-row input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%; height: 4px;
  background: rgba(148, 163, 184, 0.2);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.tec-ctrl-row input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px; height: 14px;
  border-radius: 50%;
  background: #38bdf8;
  border: 2px solid rgba(15, 23, 42, 0.9);
  cursor: pointer;
}

.tec-ctrl-toggle {
  position: fixed;
  bottom: 20px; right: 20px;
  z-index: 9999;
  width: 36px; height: 36px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(12px);
  color: #94a3b8;
  font-size: 16px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.15s;
}
.tec-ctrl-toggle:hover { color: #fff; }

.tec-ctrl-themes {
  display: flex; gap: 6px;
  margin-bottom: 6px;
}

.tec-theme-btn {
  flex: 1;
  background: rgba(148, 163, 184, 0.1);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 5px;
  color: #64748b;
  font-family: 'Fira Code', monospace;
  font-size: 10px;
  padding: 5px 0;
  cursor: pointer;
  transition: all 0.15s;
}

.tec-theme-btn:hover {
  background: rgba(148, 163, 184, 0.2);
  color: #94a3b8;
}

.tec-theme-btn.active {
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
}
</style>
