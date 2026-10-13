/**
 * 「创建智能体」首页（`AgentHomePage`）的内联样式表：原先就地写在页面的 `<style>{` 里，约全页一半行数。
 *
 * 从页面里分出来的理由（§4.7）：这是一份**纯描述数据**——选择器、色值、媒体查询断点，无状态、无 DOM、
 * 无事件；而页面文件要留给「阶段状态 + 三个请求的接线 + 渲染」。两者混在一起时，改一个圆角要翻过整页 JSX。
 *
 * 页面仍以 `<style>{AGENT_HOME_STYLES}</style>` **就地渲染**而不是改成 `.css` 导入：类名（`.agent-home-*` /
 * `.pill-*`）只为这一屏存在，没有第二个消费者，落成全局样式表反而会把它变成人人可用的全局面（§4.1、§10）。
 * 迁移是逐字搬运：选择器、层叠顺序、媒体查询断点与迁移前完全一致。
 */
export const AGENT_HOME_STYLES = `
        .agent-home-page {
          background: #f5f7fb;
          color: #0c1a3a;
        }
        .agent-home-bg {
          position: fixed;
          inset: 0;
          pointer-events: none;
          background:
            radial-gradient(500px circle at 25% 20%, rgba(15,107,255,0.06), transparent 60%),
            radial-gradient(400px circle at 75% 80%, rgba(107,230,255,0.05), transparent 60%);
        }
        .agent-home-container {
          position: relative;
          z-index: 1;
          display: flex;
          min-height: calc(100vh - 56px);
          width: min(100%, 1080px);
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 24px;
          /* 高度取内容的自然高度，**不允许被父级列 flex 压缩**：压缩后容器高被钉在视口高，
             而本容器的 justify-content 是 center——超出部分会对称地溢出容器上下两侧，滚动容器
             （.agent-home-page 的 overflow: auto）的可滚动区却只向右下延伸，于是溢出到容器上方的
             那一半（顶部品牌区 + 表单的「返回」按钮）既滚不到、也点不到。
             实测（headless Chromium 1440×900，复刻本页 DOM + 构建产物 CSS）：90 段提示词下压缩时
             容器高 900px、返回按钮落在 scrollTop=0 之上的 -6291px 处（elementFromPoint 命中 null），
             滚到底部也只把它推到 -12714px；同一根因下，模板卡片多到 30 张时品牌区被顶到 -123px。
             去掉压缩后：scrollTop=0 时返回按钮 top=178 且命中自身，滚到底部吸顶在 top=12。 */
          flex-shrink: 0;
        }
        .agent-home-header {
          margin-bottom: 38px;
          text-align: center;
        }
        .agent-home-brand-icon {
          display: flex;
          width: 56px;
          height: 56px;
          margin: 0 auto 16px;
          align-items: center;
          justify-content: center;
          border-radius: 16px;
          background: linear-gradient(135deg, #0f6bff, #6be6ff);
          box-shadow: 0 4px 20px rgba(15,107,255,0.25);
        }
        .agent-home-brand-icon img {
          width: 30px;
          height: 30px;
          object-fit: contain;
        }
        .agent-home-header h1 {
          margin: 0 0 8px;
          font-size: 28px;
          font-weight: 800;
          letter-spacing: 0.02em;
          line-height: 1.25;
          color: #0c1a3a;
        }
        .agent-home-header h1 em {
          font-style: normal;
          background: linear-gradient(135deg, #0f6bff, #32b1ff, #6be6ff);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .agent-home-header p {
          max-width: 480px;
          margin: 0 auto;
          color: #5a6785;
          font-size: 15px;
        }
        .agent-home-dialog,
        .agent-home-loading,
        .agent-home-form {
          width: 100%;
          border: 1px solid rgba(12,26,58,0.1);
          border-radius: 16px;
          background: #fff;
          box-shadow: 0 4px 16px rgba(12,26,58,0.08);
        }
        .agent-home-dialog {
          max-width: 760px;
          margin-bottom: 24px;
          overflow: hidden;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .agent-home-dialog:focus-within {
          border-color: #0f6bff;
          box-shadow: 0 4px 24px rgba(15,107,255,0.12), 0 4px 16px rgba(12,26,58,0.08);
        }
        .agent-home-greeting {
          padding: 24px 28px 0;
          color: #5a6785;
          font-size: 14px;
          line-height: 1.7;
        }
        .agent-home-greeting strong {
          color: #0c1a3a;
          font-weight: 700;
        }
        .agent-home-input-wrap {
          display: flex;
          align-items: flex-end;
          gap: 12px;
          padding: 16px 20px 20px;
        }
        .agent-home-input-wrap textarea {
          min-height: 48px;
          max-height: 160px;
          flex: 1;
          resize: none;
          border: 0;
          outline: 0;
          background: transparent;
          color: #0c1a3a;
          font: inherit;
          font-size: 15px;
          line-height: 1.6;
        }
        .agent-home-input-wrap textarea::placeholder {
          color: #8a96b0;
        }
        .agent-home-polish-btn {
          display: inline-flex;
          flex-shrink: 0;
          align-items: center;
          gap: 6px;
          border: 0;
          border-radius: 10px;
          background: linear-gradient(135deg, #0f6bff, #32b1ff);
          color: #fff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          padding: 10px 18px;
          transition: transform 0.2s, box-shadow 0.2s;
          white-space: nowrap;
        }
        .agent-home-polish-btn:hover:not(:disabled) {
          box-shadow: 0 4px 14px rgba(15,107,255,0.3);
          transform: translateY(-1px);
        }
        .agent-home-polish-btn:disabled {
          background: #c8d0df;
          box-shadow: none;
          color: #fff;
          cursor: not-allowed;
          transform: none;
        }
        .agent-home-submitted {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 18px 22px;
        }
        .agent-home-submitted span {
          flex: 1;
          color: #0c1a3a;
          font-size: 14px;
          line-height: 1.6;
        }
        .agent-home-submitted button {
          border: 0;
          background: transparent;
          color: #0f6bff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
        }
        .agent-home-loading {
          display: flex;
          max-width: 600px;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          margin-bottom: 24px;
          padding: 24px;
        }
        .agent-home-spinner,
        .pill-spinner {
          border-radius: 999px;
          border: 3px solid rgba(15,107,255,0.14);
          border-top-color: #0f6bff;
          animation: agent-spin 0.8s linear infinite;
        }
        .agent-home-spinner {
          width: 32px;
          height: 32px;
        }
        .pill-spinner {
          width: 16px;
          height: 16px;
        }
        .agent-home-form {
          max-width: 760px;
          padding: 28px;
        }
        .agent-home-form-header {
          display: flex;
          align-items: center;
          /* 「返回」是长模板提示词下唯一能退出表单的入口，必须**始终留在视口里**：吸顶跟随
             .agent-home-page 这个滚动容器，提示词再长也不会把它顶出去。
             内边距与负上边距相抵（12 - 12 = 0），静止时按钮位置与改动前逐字一致；
             滚动时卡片上内边距已移出视口，这 12px 白底正好补在按钮上方，内容从白带下穿过。 */
          position: sticky;
          top: 0;
          z-index: 2;
          margin: -12px 0 18px;
          padding: 12px 0;
          background: #fff;
        }
        .agent-home-back-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: 0;
          border-radius: 9px;
          background: rgba(15,107,255,0.08);
          color: #0f6bff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          padding: 8px 12px;
          transition: background 0.2s, transform 0.2s;
        }
        .agent-home-back-btn:hover {
          background: rgba(15,107,255,0.12);
          transform: translateY(-1px);
        }
        .agent-home-template-label {
          margin-bottom: 16px;
          color: #8a96b0;
          font-size: 12px;
          letter-spacing: 0.04em;
          text-align: center;
        }
        .agent-home-template-pills {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          width: min(100%, 900px);
        }
        .agent-home-template-pill {
          position: relative;
          display: flex;
          width: 100%;
          align-items: center;
          gap: 10px;
          overflow: hidden;
          border: 1px solid rgba(12,26,58,0.1);
          border-radius: 14px;
          background: #fff;
          box-shadow: 0 1px 3px rgba(12,26,58,0.04);
          color: #5a6785;
          cursor: pointer;
          padding: 12px 16px;
          text-align: left;
          transition: border-color 0.25s, box-shadow 0.25s, transform 0.25s;
        }
        .agent-home-template-pill::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 2px;
          background: linear-gradient(90deg, var(--pill-accent), var(--pill-accent-end));
          opacity: 0;
          transition: opacity 0.25s;
        }
        .agent-home-template-pill:hover {
          border-color: var(--pill-accent);
          box-shadow: 0 4px 16px rgba(15,107,255,0.12), 0 1px 3px rgba(12,26,58,0.06);
          color: #0c1a3a;
          transform: translateY(-2px);
        }
        .agent-home-template-pill:hover::before {
          opacity: 1;
        }
        .agent-home-template-pill:disabled {
          cursor: not-allowed;
          opacity: 0.64;
          transform: none;
        }
        .pill-icon {
          position: relative;
          z-index: 1;
          display: flex;
          width: 32px;
          height: 32px;
          flex-shrink: 0;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          background: color-mix(in srgb, var(--pill-accent) 10%, white);
          color: var(--pill-accent);
          transition: background 0.25s, color 0.25s, box-shadow 0.25s;
        }
        .agent-home-template-pill:hover .pill-icon {
          background: linear-gradient(135deg, var(--pill-accent), var(--pill-accent-end));
          box-shadow: 0 2px 8px var(--pill-glow);
          color: #fff;
        }
        .pill-copy {
          position: relative;
          z-index: 1;
          display: flex;
          min-width: 0;
          flex-direction: column;
        }
        .pill-title {
          color: #0c1a3a;
          font-size: 13px;
          font-weight: 700;
        }
        .pill-desc {
          overflow: hidden;
          color: #8a96b0;
          font-size: 11px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        @keyframes agent-spin {
          to { transform: rotate(360deg); }
        }
        @media (max-width: 760px) {
          .agent-home-container {
            justify-content: flex-start;
            padding: 32px 16px;
          }
          .agent-home-header h1 {
            font-size: 25px;
          }
          .agent-home-input-wrap,
          .agent-home-submitted {
            flex-direction: column;
            align-items: stretch;
          }
          .agent-home-polish-btn {
            justify-content: center;
          }
          .agent-home-template-pill {
            grid-column: auto;
          }
          .agent-home-template-pills {
            grid-template-columns: 1fr;
          }
        }
`;
