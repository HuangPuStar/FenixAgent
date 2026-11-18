import type { FixtureExpectedMessage } from "./fixtures";

/** 注入后的观测使用 rAF 时钟，不把 CLI 轮询或网络握手当作内容可交互时间。 */
export function createPageObserver(expectedTail: readonly FixtureExpectedMessage[], baseline = false): string {
  // 固定基线的双时间线合并会丢部分时间戳；候选必须验证完整预期。
  const expected = baseline
    ? expectedTail.map(({ ...message }) => {
        if ("ts" in message) delete (message as Partial<{ ts: number }>).ts;
        return message;
      })
    : expectedTail;
  return `(() => {
    if (window.__chatHistoryBench?.stop) window.__chatHistoryBench.stop();
    const expected = ${JSON.stringify(expected)};
    const state = { firstVisibleMs:null, interactiveMs:null, earlierMs:null, contentVerified:false, visibleCount:0, projectedCount:0, browserErrors:0, start:0, earlierStart:null, beforeEarlier:0, stopped:false, targetSession:null };
    const normalize = (message) => Object.fromEntries(['id','type','content','chunks','title','status','rawInput','rawOutput','error','publicError','entries','turnId',${baseline ? "" : "'ts',"}'permissionRequest','subMessages'].filter(key=>message[key]!==undefined).map(key=>[key,message[key]]));
    const canonical = value => value && typeof value==='object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
    const same = (a,b) => JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
    const read = () => {
      const el=document.querySelector('[data-slot="chat-conversation-content"]');
      let fiber=el?.[Object.keys(el).find(key=>key.startsWith('__reactFiber'))];
      let props=null;
      for (let node=fiber;node;node=node.return) if(node.memoizedProps?.sessionState?.structuredMessages) {props=node.memoizedProps;break;}
      return {props,messages:props?.sessionState?.structuredMessages??[],visible:document.querySelectorAll('[id^="chat-entry-"]')};
    };
    const errors=()=>state.browserErrors++;
    window.addEventListener('error',errors);
    window.addEventListener('unhandledrejection',errors);
    const tick=()=>{
      if(state.stopped)return;
      const current=read();
      const elapsed=performance.now()-state.start;
      state.visibleCount=current.visible.length;
      state.projectedCount=current.messages.length;
      const active=!state.targetSession || current.props?.sessionState?.acpSessionId===state.targetSession;
      if(active && current.visible.length && state.firstVisibleMs===null)state.firstVisibleMs=elapsed;
      const verified=current.messages.length>=expected.length && same(current.messages.slice(-expected.length).map(normalize),expected);
      const input=document.querySelector('textarea:not([disabled]),[contenteditable="true"]');
      const lastRendered=current.visible.length && current.visible[current.visible.length-1].textContent.includes('天气文件已生成');
      if(active && verified && input && lastRendered && state.interactiveMs===null){state.interactiveMs=elapsed;state.contentVerified=true;}
      if(state.earlierStart!==null && state.earlierMs===null && current.visible.length>state.beforeEarlier)state.earlierMs=performance.now()-state.earlierStart;
      requestAnimationFrame(tick);
    };
    const start=(targetSession=null)=>{state.start=performance.now();state.firstVisibleMs=null;state.interactiveMs=null;state.earlierMs=null;state.contentVerified=false;state.earlierStart=null;state.browserErrors=0;state.targetSession=targetSession;};
    window.__chatHistoryBench={
      snapshot:()=>({...state,stopped:undefined,start:undefined}),
      start,
      switchSession:()=>{
        const current=read().props?.sessionState?.acpSessionId;
        const target=current==='ses_benchmark_a'?'ses_benchmark_b':'ses_benchmark_a';
        const name=target==='ses_benchmark_a'?'天气会话 A':'天气会话 B';
        const button=[...document.querySelectorAll('nav[aria-label="历史会话"] button')].find(button=>button.textContent.trim()===name);
        if(!button || button.disabled)return false;
        start(target);button.click();return target;
      },
      earlier:()=>new Promise(resolve=>requestAnimationFrame(()=>{
        const button=document.querySelector('[data-slot="chat-load-earlier"] button');
        if(!button || button.disabled){resolve(false);return;}
        state.beforeEarlier=read().visible.length;state.earlierStart=performance.now();button.click();resolve(true);
      })),
      stop:()=>{state.stopped=true;window.removeEventListener('error',errors);window.removeEventListener('unhandledrejection',errors);},
    };
    requestAnimationFrame(tick);
  })();`;
}
