import { AppError, Recording, Step, scaledDelay } from './contracts';

export type Target = {
  kind: 'web' | 'mobile';
  /** Runs in the isolated world. */
  run: (code: string) => Promise<any>;
  cdp: (method: string, params?: object) => Promise<any>;
  navigate: (path: string) => Promise<void>;
  login: () => Promise<void>;
  isLoginPage: () => boolean;
  loading: () => boolean;
  alive: () => boolean;
  /** View pixels per CSS pixel (the phone view is scaled to fit its column). */
  scale: () => number;
};
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number; radius: number };
export type Hit = Point & { rect?: Rect; selector?: string };
export type ReplayStatus = 'playing' | 'paused' | 'done' | 'stopped';
export type SelectorReport = { selector: string; matches: number; visible: number; problem: string; coveredBy: string };
export type Diagnosis = { url: string; title: string; dialog: string; focus: string; selectors: SelectorReport[] };
/** One change in what the engine saw while waiting for a target, e.g. "covered by div.overlay" at 0.4 s. */
export type TracePoint = { ms: number; state: string; selector?: string; coveredBy?: string };
export type Failure = { target: 'web' | 'mobile'; code: string; message: string; hint: string; detail?: string; diagnosis?: Diagnosis; menuTried?: boolean; waitedMs?: number; trace?: TracePoint[]; recorded?: Step['target'] };
/** Shown live while a view has been looking for its target for a while. */
export type Waiting = { target: 'web' | 'mobile'; state: string; selector?: string; coveredBy?: string; since: number };
export type ReplayError = { index: number; target: 'web' | 'mobile'; code: string; step: { kind: Step['kind']; label: string }; failures: Failure[]; at: string; report?: string };
export type LogEntry = { index: number; target: 'web' | 'mobile'; kind: Step['kind']; label: string; ms: number; outcome: 'ok' | 'noop' | 'skipped' | 'failed'; code?: string; selector?: string; note?: string };
type StepContext = { selector?: string; note?: string };

/** A step failure with what the engine saw while waiting. */
class StepFailure extends AppError { constructor(code: string, public extra: { menuTried?: boolean; waitedMs?: number; trace?: TracePoint[] } = {}) { super(code); } }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const POINTER = new Set<Step['kind']>(['click', 'type', 'select', 'check', 'dismiss']);
const DIALOG_ROOT = /^(dialog\[open\]|\[role="(dialog|alertdialog)"\]|\[aria-modal="true"\])/;

const PAGE = `const vis=e=>{if(!e||!e.getBoundingClientRect)return false;const r=e.getBoundingClientRect(),cs=getComputedStyle(e);return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&+cs.opacity!==0;};
  const opacity=e=>{let o=1;for(let n=e;n&&n.nodeType===1;n=n.parentElement){o*=+getComputedStyle(n).opacity;if(o<.05)break;}return o;};
  const desc=e=>{if(!e||!e.tagName)return '';let s=e.tagName.toLowerCase();if(e.id)s+='#'+e.id;const c=typeof e.className==='string'?e.className.trim().split(/\\s+/).filter(Boolean).slice(0,2).join('.'):'';if(c)s+='.'+c;const r=e.getAttribute('role');if(r)s+='[role='+r+']';return s.slice(0,90);};
  const DIALOGS='dialog:modal,[aria-modal="true"],[role=dialog],[role=alertdialog]';
  const dialogs=()=>[...document.querySelectorAll(DIALOGS)].filter(vis);
  const dname=d=>d?(d.getAttribute('aria-label')||d.querySelector('h1,h2,h3')?.innerText||desc(d)).replace(/\\s+/g,' ').trim().slice(0,60):'';
  const hitAt=e=>{const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(x<0||y<0||x>innerWidth||y>innerHeight)return {ok:false,off:true};const h=document.elementFromPoint(x,y);return {ok:!!h&&(e===h||e.contains(h)||h.contains(e)),hit:h};};`;

/**
 * One look for the target. 'ready' means visible, on top, in view and unchanged since the previous look
 * (so dialog zoom/fade animations and smooth scrolls have finished). 'moving' means wait a frame or two.
 */
export function probeScript(selectors: string[]) {
  return `(()=>{${PAGE}const st=window.__hfProbe||(window.__hfProbe={});let hidden='',covered='';
  for(const s of ${JSON.stringify(selectors)}){let list;try{list=[...document.querySelectorAll(s)];}catch{continue;}
    for(let e of list){if(!vis(e)&&e instanceof HTMLInputElement&&e.labels&&e.labels[0]&&vis(e.labels[0]))e=e.labels[0];
      if(!vis(e))continue;
      const r=e.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
      const inView=(r.height<=innerHeight-8?r.top>=4&&r.bottom<=innerHeight-4:cy>0&&cy<innerHeight)&&cx>0&&cx<innerWidth;
      const scroll=()=>{if(st.scrolled===e&&Date.now()-st.at<1500)return false;st.scrolled=e;st.at=Date.now();st.key='';e.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'});return true;};
      if(!inView&&scroll())return {state:'moving',selector:s};
      const h=hitAt(e);
      if(!h.ok){const pos=h.hit&&getComputedStyle(h.hit).position;
        // A sticky header over the target: bring it to the middle once. Anything else (a dialog, a closing overlay) may still go away.
        if(!h.off&&(pos==='sticky'||pos==='fixed')&&!dialogs().length&&scroll())return {state:'moving',selector:s};
        if(!covered)covered={s,by:desc(h.hit)};continue;}
      const key=[r.left,r.top,r.width,r.height].map(Math.round).join(),stable=st.el===e&&st.key===key&&opacity(e)>.95;st.el=e;st.key=key;
      const rect={x:r.left,y:r.top,w:r.width,h:r.height,radius:parseFloat(getComputedStyle(e).borderTopLeftRadius)||0};
      return {state:stable?'ready':'moving',selector:s,x:Math.round(cx),y:Math.round(cy),rect};}
    if(list.length&&!hidden)hidden=s;}
  return covered?{state:'covered',selector:covered.s,coveredBy:covered.by}:hidden?{state:'hidden',selector:hidden}:{state:'missing'};})()`;
}

/** What the page looked like for each selector when a step gave up. */
export function diagnoseScript(selectors: string[]) {
  return `(()=>{${PAGE}const out=[];
  for(const s of ${JSON.stringify(selectors)}){let list=[];try{list=[...document.querySelectorAll(s)];}catch{out.push({selector:s,matches:0,visible:0,problem:'invalid selector',coveredBy:''});continue;}
    const v=list.filter(vis);let problem='',coveredBy='';
    if(!list.length)problem='no match';
    else if(!v.length){const e=list[0],cs=getComputedStyle(e);let p=e.parentElement;while(p&&getComputedStyle(p).display!=='none')p=p.parentElement;
      problem=cs.display==='none'?'display:none':cs.visibility==='hidden'?'visibility:hidden':+cs.opacity===0?'opacity:0':p?'inside hidden '+desc(p):'zero size';}
    else{const h=hitAt(v[0]);if(h.off)problem='off-screen';else if(!h.ok){problem='covered';coveredBy=desc(h.hit);}}
    out.push({selector:s,matches:list.length,visible:v.length,problem,coveredBy});}
  const d=dialogs().pop();
  return {url:location.pathname+location.search,title:document.title.slice(0,80),dialog:dname(d),focus:desc(document.activeElement),selectors:out};})()`;
}

/** Outlines everything each selector matches (numbered by selector) so a failure can be checked by eye. */
export function highlightScript(selectors: string[]) {
  return `(()=>{${PAGE}const sels=${JSON.stringify(selectors)};const lists=sels.map(s=>{try{return [...document.querySelectorAll(s)].filter(vis).slice(0,20);}catch{return [];}});
  const first=lists.flat()[0];if(first){const r=first.getBoundingClientRect();if(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)first.scrollIntoView({block:'center',behavior:'instant'});}
  const marks=[];lists.forEach((l,i)=>l.forEach(e=>{const r=e.getBoundingClientRect();marks.push({x:r.left,y:r.top,w:r.width,h:r.height,n:i+1,ok:hitAt(e).ok});}));
  return marks;})()`;
}

/** Looks for the control that reveals a hidden element: aria-controls first, then common hamburger patterns. */
export function menuToggleScript(hiddenSelector: string) {
  return `(()=>{${PAGE}let target;try{target=document.querySelector(${JSON.stringify(hiddenSelector)});}catch{}
  const usable=e=>vis(e)&&hitAt(e).ok;
  const all=s=>[...document.querySelectorAll(s)].filter(usable);
  let t=all('[aria-controls]').find(b=>{const c=document.getElementById(b.getAttribute('aria-controls'));return !!c&&!!target&&c.contains(target);});
  if(!t)t=all('[aria-expanded="false"]').find(b=>{const n=b.closest('header,nav,[role=banner],[role=navigation]');return !!n&&!!target&&n.contains(target);});
  const q='[class*=hamburger i],[class*=burger i],[class*=menu-toggle i],[class*=nav-toggle i],[class*=navbar-toggler i],[data-testid*=menu i],[data-testid*=burger i],[aria-label*=menu i],[aria-label*="menú" i],[aria-label*=navigation i],[aria-label*="navegación" i]';
  if(!t){const found=all(q);t=found.find(e=>e.closest('header,nav,[role=banner],[role=navigation]'))||found[0];}
  if(!t)return null;t=t.closest('button,a,[role=button]')||t;const r=t.getBoundingClientRect();
  return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),rect:{x:r.left,y:r.top,w:r.width,h:r.height,radius:parseFloat(getComputedStyle(t).borderTopLeftRadius)||0}};})()`;
}

const dialogCountScript = `(()=>{${PAGE}return dialogs().length;})()`;
/** A point on the backdrop of the topmost dialog, away from anything clickable. */
const outsideScript = `(()=>{${PAGE}const d=dialogs().pop();if(!d)return null;const r=d.getBoundingClientRect();
  for(const [x,y] of [[12,12],[innerWidth-12,12],[12,innerHeight/2],[innerWidth-12,innerHeight-12],[innerWidth/2,12]]){const h=document.elementFromPoint(x,y);if(!h)continue;
    const out=x<r.left||x>r.right||y<r.top||y>r.bottom;if((out||h===d)&&!h.closest('a,button,input,select,textarea,[role=button]'))return {x:Math.round(x),y:Math.round(y)};}return null;})()`;
const focusedScript = `(()=>{const a=document.activeElement;if(!a||a===document.body)return 'none';if(a instanceof HTMLInputElement&&a.type==='password'||a.closest('form')?.querySelector('input[type=password]'))return 'secret';
  try{if(typeof a.select==='function'){a.select();return 'selected';}}catch{}
  if(a.isContentEditable){const r=document.createRange();r.selectNodeContents(a);const s=getSelection();s.removeAllRanges();s.addRange(r);return 'selected';}return 'focused';})()`;
const selectScript = (selectors: string[], value: string) => `(()=>{for(const s of ${JSON.stringify(selectors)}){let e;try{e=document.querySelector(s);}catch{continue;}
  if(e instanceof HTMLSelectElement){if(![...e.options].some(o=>o.value===${JSON.stringify(value)}))return 'missing';if(e.value===${JSON.stringify(value)})return 'same';e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'set';}}return 'missing';})()`;
const checkedScript = (selectors: string[]) => `(()=>{for(const s of ${JSON.stringify(selectors)}){let e;try{e=document.querySelector(s);}catch{continue;}if(e instanceof HTMLInputElement)return e.checked;}return null;})()`;
const scrollScript = (fraction: number) => `(()=>{const max=document.documentElement.scrollHeight-innerHeight;window.scrollTo({top:Math.max(0,max)*${fraction},behavior:'smooth'});return true;})()`;

export type OverlayCommand =
  | { op: 'init'; from?: Point }
  | { op: 'approach'; from?: Point; to: Point; rect?: Rect; ms: number }
  | { op: 'press'; at: Point }
  | { op: 'release' }
  | { op: 'key'; label: string }
  | { op: 'marks'; marks: { x: number; y: number; w: number; h: number; n: number; ok: boolean }[] };

/**
 * Presentation layer drawn over the page, never hit-tested: a pointer that glides to each target on the web,
 * a fingertip that lands on it on the phone, a ring around the element about to be used, a ripple on press,
 * and a key badge for Enter/Escape. It lives in the top layer so it also shows above modal dialogs.
 */
export function overlayScript(kind: 'web' | 'mobile', cmd: OverlayCommand) {
  return `(()=>{const cmd=${JSON.stringify(cmd)},mobile=${kind === 'mobile'};let o=window.__hfOverlay;const fresh=!o||!o.host.isConnected;
  if(fresh){const host=document.createElement('hf-replay-overlay');host.setAttribute('popover','manual');
    host.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;display:block;color-scheme:normal';
    const root=host.attachShadow({mode:'closed'});
    root.innerHTML='<style>'+
      '.c,.f,.r,.s,.k{position:fixed;left:0;top:0;pointer-events:none;box-sizing:border-box}'+
      '.c{width:26px;height:26px;opacity:0;transition:transform var(--t,.4s) cubic-bezier(.3,.75,.25,1),opacity .3s;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}'+
      '.c i{display:block;transform-origin:4px 3px;transition:transform .12s ease-out}.c.down i{transform:scale(.8)}'+
      '.s{opacity:0;border-radius:var(--rad,8px);border:2px solid rgba(108,118,255,.95);box-shadow:0 0 0 4px rgba(108,118,255,.22),0 0 22px rgba(108,118,255,.35);transition:opacity .25s ease-out,transform var(--t,.4s) cubic-bezier(.3,.75,.25,1),width var(--t,.4s),height var(--t,.4s)}'+
      '.r{width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;border:2.5px solid #fff;background:rgba(108,118,255,.32);box-shadow:0 0 0 2px rgba(108,118,255,.85);opacity:0}'+
      '.r.go{animation:r .55s cubic-bezier(.2,.7,.3,1)}@keyframes r{0%{opacity:1;transform:var(--p) scale(.3)}100%{opacity:0;transform:var(--p) scale(1.3)}}'+
      '.f{width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(255,255,255,.3);border:2.5px solid rgba(255,255,255,.97);box-shadow:0 0 0 1.5px rgba(20,20,40,.5),0 6px 18px rgba(0,0,0,.35);opacity:0;transform:var(--p) scale(1.7);transition:opacity .3s ease-out,transform .3s cubic-bezier(.2,.8,.2,1)}'+
      '.f.on{opacity:1;transform:var(--p) scale(1);transition-delay:var(--d,0ms)}.f.down{transform:var(--p) scale(.78);background:rgba(108,118,255,.5);transition:transform .09s,background .09s}'+
      '.k{top:auto;left:50%;bottom:18px;transform:translate(-50%,8px);opacity:0;padding:6px 12px;border-radius:9px;background:rgba(24,24,28,.88);color:#fff;font:600 13px/1.2 system-ui,sans-serif;letter-spacing:.02em;box-shadow:0 6px 18px rgba(0,0,0,.3);transition:opacity .2s,transform .2s}.k.on{opacity:1;transform:translate(-50%,0)}'+
      '.mk div{position:fixed;border:2px dashed #ff4d4f;background:rgba(255,77,79,.08);border-radius:4px}.mk div.no{border-color:#f5a623;background:rgba(245,166,35,.1)}.mk b{position:absolute;left:-2px;top:-18px;background:#ff4d4f;color:#fff;font:700 11px/16px system-ui,sans-serif;padding:0 5px;border-radius:4px 4px 4px 0}.mk div.no b{background:#f5a623}'+
      '</style><div class="mk"></div><div class="s"></div><div class="r"></div><div class="f"></div><div class="k"></div>'+
      '<div class="c"><i><svg viewBox="0 0 24 24" width="26" height="26"><path d="M4.5 2.5l14 11.2-6.3.8 3.6 7-3 1.4-3.5-7.2-4.8 4.4z" fill="#141416" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg></i></div>';
    document.documentElement.appendChild(host);
    o=window.__hfOverlay={host,mk:root.querySelector('.mk'),c:root.querySelector('.c'),s:root.querySelector('.s'),r:root.querySelector('.r'),f:root.querySelector('.f'),k:root.querySelector('.k')};
    try{host.showPopover();}catch{}}
  // Dialogs and popovers opened after the overlay sit above it in the top layer; re-enter it on top.
  if([...document.querySelectorAll('dialog:modal,[popover]:popover-open')].some(e=>e!==o.host)){try{o.host.hidePopover();o.host.showPopover();}catch{}}
  const T=(el,ms)=>el.style.setProperty('--t',Math.max(0,ms)+'ms');
  const jump=(el,fn)=>{const t=el.style.transition;el.style.transition='none';fn();void el.offsetWidth;el.style.transition=t;};
  const at=p=>'translate('+p.x+'px,'+p.y+'px)';
  if(cmd.op==='marks'){o.mk.innerHTML=cmd.marks.map(m=>'<div class="'+(m.ok?'':'no')+'" style="left:'+(m.x-2)+'px;top:'+(m.y-2)+'px;width:'+(m.w+4)+'px;height:'+(m.h+4)+'px"><b>'+m.n+(m.ok?'':' covered')+'</b></div>').join('');}
  if(cmd.op==='approach')o.mk.innerHTML='';
  if(cmd.op==='init'||cmd.op==='approach'){
    if(!mobile){const from=cmd.from||{x:innerWidth*.5,y:innerHeight*.72};
      if(fresh||o.c.style.opacity!=='1')jump(o.c,()=>{o.c.style.transform=at(from);});o.c.style.opacity='1';
      if(cmd.to){T(o.c,cmd.ms);o.c.style.transform=at(cmd.to);}}
    if(cmd.rect){const R=cmd.rect,pad=4,place=()=>{o.s.style.transform=at({x:R.x-pad,y:R.y-pad});o.s.style.width=R.w+pad*2+'px';o.s.style.height=R.h+pad*2+'px';o.s.style.setProperty('--rad',Math.min(R.radius+pad,(R.h+pad*2)/2)+'px');};
      clearTimeout(o.st);T(o.s,cmd.ms);if(o.s.style.opacity!=='1')jump(o.s,place);else place();o.s.style.opacity='1';}
    if(mobile&&cmd.to){clearTimeout(o.ft);o.f.style.setProperty('--d',Math.max(0,cmd.ms-300)+'ms');jump(o.f,()=>{o.f.classList.remove('on','down');o.f.style.setProperty('--p',at(cmd.to));});o.f.classList.add('on');}}
  if(cmd.op==='press'){o.r.style.setProperty('--p',at(cmd.at));o.r.classList.remove('go');void o.r.offsetWidth;o.r.classList.add('go');(mobile?o.f:o.c).classList.add('down');}
  if(cmd.op==='release'){o.c.classList.remove('down');o.f.classList.remove('down');o.f.style.setProperty('--d','0ms');clearTimeout(o.ft);o.ft=setTimeout(()=>o.f.classList.remove('on'),220);
    clearTimeout(o.st);o.st=setTimeout(()=>{o.s.style.opacity='0';},450);}
  if(cmd.op==='key'){o.k.textContent=cmd.label;o.k.classList.add('on');clearTimeout(o.kt);o.kt=setTimeout(()=>o.k.classList.remove('on'),850);}
  return true;})()`;
}

const KEYS = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }, Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 } } as const;
const KEY_BADGE: Record<keyof typeof KEYS, string> = { Enter: 'Enter ↵', Escape: 'Esc', Backspace: '⌫' };

/** Text for a type step in the replay language, falling back to what was typed while recording. */
export const stepText = (step: Step, lang: string) => step.texts[lang] ?? step.texts[lang.split('-')[0]] ?? step.text ?? '';

/** Plain-language account of a failed step: what went wrong and what to try. */
export function explain(step: Step, f: { code: string; target: 'web' | 'mobile'; diagnosis?: Diagnosis; menuTried?: boolean }, prevNoop?: Step): { message: string; hint: string } {
  const what = step.label ? `“${step.label}”` : 'the element';
  const d = f.diagnosis, sel = d?.selectors ?? [];
  const covered = sel.find(s => s.problem === 'covered'), hidden = sel.some(s => s.matches > 0 && s.visible === 0);
  const inDialog = !!step.selectors?.some(s => DIALOG_ROOT.test(s));
  switch (f.code) {
    case 'element_not_found': case 'element_hidden': case 'element_covered': {
      if (covered) return { message: `${what} is covered`, hint: `${covered.coveredBy || 'Something'} is on top of it${d?.dialog ? `, and the dialog “${d.dialog}” is still open` : ''}. Close it in an earlier step, or press Retry once it is gone.` };
      if (hidden) return { message: `${what} is on the page but hidden`, hint: f.target === 'mobile' ? (f.menuTried ? 'Opening the menu didn’t reveal it. Tap whatever shows it in the phone view and replay will remember it.' : 'On phones it is probably behind a menu button. Tap that button in the phone view and replay will remember it.') : 'It may only appear on hover, after another action, or at a different window size.' };
      if (prevNoop) return { message: `Couldn’t find ${what}`, hint: `The previous step (${prevNoop.label ? `“${prevNoop.label}”` : prevNoop.kind}) changed nothing because this account already had that value, so anything that only appears after a change, like a Save button, never showed up. Change it back in the account, or skip this step.` };
      if (inDialog && !d?.dialog) return { message: `Couldn’t find ${what}`, hint: 'It was recorded inside a dialog, but no dialog is open now. The step that opens it may have failed, been skipped, or opened something else.' };
      if (d?.dialog) return { message: `Couldn’t find ${what}`, hint: `The dialog “${d.dialog}” is open and doesn’t contain it. A step that should have closed it may have been missed.` };
      if (step.fragile) return { message: `Couldn’t find ${what}`, hint: 'This step was matched by its position on the page, which breaks when the layout changes. Give the element a data-testid in your app and record again.' };
      return { message: `Couldn’t find ${what}`, hint: 'Nothing on the page matches. The page may differ from when you recorded it: other data, permissions or route.' };
    }
    case 'protected_login_page': return { message: 'Landed on the sign-in page', hint: 'The copied session may have expired. Sign in again in the account’s pane, or check its saved credentials.' };
    case 'protected_field': return { message: 'Refused to type into a password form', hint: 'Passwords are never typed by replay. Use a Sign in step instead.' };
    case 'field_not_focusable': return { message: `Couldn’t focus ${what}`, hint: 'The tap landed, but no field took focus. Something may have covered it, or it is read-only.' };
    case 'option_not_found': return { message: `Option “${step.value ?? ''}” isn’t in the list`, hint: 'Options can differ by language or by account data.' };
    case 'dialog_did_not_close': return { message: 'The dialog stayed open', hint: 'Neither Escape nor tapping outside closed it. Record a click on its close button instead.' };
    case 'step_without_selector': return { message: 'This step has nothing to click', hint: 'Delete it in the step editor and record that part again.' };
    case 'target_closed': return { message: 'The view was closed', hint: 'Exit the replay and start it again.' };
    default: return { message: f.code.replaceAll('_', ' '), hint: '' };
  }
}


export class Replay {
  index = 0;
  status: ReplayStatus = 'playing';
  error?: ReplayError;
  /** Recent step timings and outcomes, for the log panel and failure reports. */
  log: LogEntry[] = [];
  /** Views that have been looking for their target for a while, and what they see. */
  waiting = new Map<'web' | 'mobile', Waiting>();
  private single = false;
  private skipPreOnce = false;
  private wake?: () => void;
  /** Targets that already finished the current step; Retry runs only the others, so a toggle is never pressed twice. */
  private done = new Set<'web' | 'mobile'>();
  private noopAt = new Map<'web' | 'mobile', number>();
  private pointer = new Map<'web' | 'mobile', Point>();

  constructor(public rec: Recording, private targets: Target[], public lang: string, public speed: number, private changed: () => void, private failed?: (error: ReplayError) => void) {}

  get current(): Step | undefined { return this.rec.steps[this.index]; }

  async run() {
    for (const t of this.targets) await this.show(t, { op: 'init' });
    while (this.status !== 'stopped') {
      if (this.status !== 'playing') { await new Promise<void>(resolve => { this.wake = resolve; }); continue; }
      const step = this.current;
      if (!step) { this.status = 'done'; this.changed(); continue; }
      // Pointer steps spend the end of the recorded pause gliding to the target, so motion fills the wait.
      const wait = this.index === 0 || this.done.size ? 0 : scaledDelay(step.delayMs, this.speed);
      await sleep(Math.max(0, wait - (POINTER.has(step.kind) && this.rec.cursor ? Math.round(420 / this.speed) : 0)));
      if (this.status !== 'playing') continue;
      const skipPre = this.skipPreOnce; this.skipPreOnce = false;
      const pending = this.targets.filter(t => !this.done.has(t.kind)), index = this.index;
      const results = await Promise.allSettled(pending.map(t => this.timed(t, step, skipPre)));
      if ((this.status as ReplayStatus) === 'stopped') break;
      if (this.index !== index) continue;
      const failures: Failure[] = [];
      for (const [i, r] of results.entries()) {
        const t = pending[i];
        if (r.status === 'fulfilled') { this.done.add(t.kind); if (r.value === 'noop') this.noopAt.set(t.kind, index); else this.noopAt.delete(t.kind); }
        else failures.push(await this.failure(t, step, r.reason));
      }
      if (failures.length) {
        this.error = { index, target: failures[0].target, code: failures[0].code, step: { kind: step.kind, label: step.label || step.path || '' }, failures, at: new Date().toISOString() };
        this.status = 'paused';
        this.failed?.(this.error);
      } else {
        this.moveTo(index + 1);
        if (this.single) { this.single = false; this.status = 'paused'; }
      }
      this.changed();
    }
  }
  private moveTo(index: number) { this.index = index; this.done.clear(); }
  private resume() { this.status = 'playing'; this.error = undefined; const w = this.wake; this.wake = undefined; w?.(); this.changed(); }
  play() { if (this.status === 'done') this.moveTo(0); this.single = false; this.resume(); }
  pause() { if (this.status === 'playing') { this.status = 'paused'; this.changed(); } }
  next() { if (this.index >= this.rec.steps.length) return; this.single = true; this.resume(); }
  previous() { this.moveTo(Math.max(0, this.index - 1)); this.single = true; this.resume(); }
  retry(skipPre = false) { this.skipPreOnce = skipPre; this.resume(); }
  skip() { this.moveTo(Math.min(this.rec.steps.length, this.index + 1)); this.resume(); }
  /** The user performed the failed step in this view by hand; carry on with the others. */
  handled(kind: 'web' | 'mobile') {
    const step = this.current; if (!step) return;
    this.done.add(kind); this.noopAt.delete(kind);
    this.record({ index: this.index, target: kind, kind: step.kind, label: step.label, ms: 0, outcome: 'ok', note: 'done by hand' });
    this.resume();
  }
  stop() { this.status = 'stopped'; const w = this.wake; this.wake = undefined; w?.(); }

  private async timed(t: Target, step: Step, skipPre: boolean) {
    const start = Date.now(), ctx: StepContext = {}, base = { index: this.index, target: t.kind, kind: step.kind, label: step.label || step.path || '' };
    try {
      const outcome = await this.perform(t, step, skipPre, ctx) ?? 'ok';
      this.record({ ...base, ms: Date.now() - start, outcome, selector: ctx.selector, note: ctx.note });
      return outcome;
    } catch (e) {
      this.record({ ...base, ms: Date.now() - start, outcome: 'failed', code: e instanceof AppError ? e.code : 'step_failed', selector: ctx.selector, note: ctx.note });
      throw e;
    } finally { this.setWaiting(t.kind); }
  }
  private record(entry: LogEntry) { this.log.push(entry); if (this.log.length > 300) this.log.splice(0, this.log.length - 300); }
  private setWaiting(kind: 'web' | 'mobile', w?: Waiting) {
    const had = this.waiting.has(kind);
    if (w) this.waiting.set(kind, w); else this.waiting.delete(kind);
    if (w || had) this.changed();
  }
  private async failure(t: Target, step: Step, reason: unknown): Promise<Failure> {
    const code = reason instanceof AppError ? reason.code : 'step_failed';
    const extra = reason instanceof StepFailure ? reason.extra : {};
    const diagnosis: Diagnosis | undefined = step.selectors?.length && t.alive() ? await t.run(diagnoseScript(step.selectors)).catch(() => undefined) : undefined;
    const prev = this.noopAt.get(t.kind) === this.index - 1 ? this.rec.steps[this.index - 1] : undefined;
    const detail = reason instanceof AppError ? undefined : String((reason as Error)?.message || reason).slice(0, 500);
    return { target: t.kind, code, ...explain(step, { code, target: t.kind, diagnosis, menuTried: extra.menuTried }, prev), detail, diagnosis, recorded: step.target, ...extra };
  }
  /** Outlines what the current step's selectors match in one view. Returns how many matched. */
  async highlight(kind: 'web' | 'mobile') {
    const t = this.targets.find(x => x.kind === kind), step = this.current;
    if (!t || !step?.selectors?.length) return 0;
    const marks = await t.run(highlightScript(step.selectors));
    await t.run(overlayScript(t.kind, { op: 'marks', marks })).catch(() => {});
    return marks.length as number;
  }

  private async settle(t: Target) {
    await sleep(140);
    const until = Date.now() + 10000;
    while (t.alive() && t.loading() && Date.now() < until) await sleep(100);
  }
  private async until(check: () => Promise<boolean>, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await check().catch(() => false)) return true; await sleep(80); }
    return false;
  }
  /**
   * Waits for a visible, uncovered, settled match: dialogs finish animating in, smooth scrolls finish, menus open.
   * Every change in what it sees is traced; after a short while the current state is shown live in the replay bar.
   */
  private async locate(t: Target, selectors: string[], timeout = 10000): Promise<Hit> {
    const start = Date.now(), trace: TracePoint[] = [];
    let menuTried = false, movingSince = 0, last: { state: string; selector?: string; coveredBy?: string; x?: number; y?: number; rect?: Rect } | undefined;
    const note = (state: string, selector?: string, coveredBy?: string) => {
      const prev = trace[trace.length - 1];
      if (!prev || prev.state !== state || prev.selector !== selector || prev.coveredBy !== coveredBy) { if (trace.length < 60) trace.push({ ms: Date.now() - start, state, selector, coveredBy }); }
      if (Date.now() - start > 700) { const w = this.waiting.get(t.kind); if (!w || w.state !== state || w.selector !== selector || w.coveredBy !== coveredBy) this.setWaiting(t.kind, { target: t.kind, state, selector, coveredBy, since: start }); }
    };
    while (Date.now() - start < timeout && this.status !== 'stopped') {
      if (!t.alive()) throw new StepFailure('target_closed', { trace });
      try { last = await t.run(probeScript(selectors)); } catch { last = { state: 'page loading' }; /* Navigation replaces the document. */ }
      note(last?.state ?? 'no answer', last?.selector, last?.coveredBy);
      if (last?.state === 'ready') return { x: last.x!, y: last.y!, rect: last.rect, selector: last.selector };
      if (last?.state === 'moving') {
        // Something that never stops moving (a looping animation) is still usable after a moment.
        if (!movingSince) movingSince = Date.now(); else if (Date.now() - movingSince > 1500 && last.x != null) return { x: last.x, y: last.y!, rect: last.rect, selector: last.selector };
        await sleep(70); continue;
      }
      movingSince = 0;
      // Desktop navigation usually collapses into a menu button on phones: open it once, then look again.
      if (last?.state === 'hidden' && t.kind === 'mobile' && !menuTried) {
        menuTried = true;
        const toggle: Hit | null = await t.run(menuToggleScript(last.selector!)).catch(() => null);
        note(toggle ? 'opening menu' : 'no menu button found');
        if (toggle) { await this.tap(t, toggle); await sleep(Math.round(380 / this.speed) + 120); continue; }
      }
      await sleep(120);
    }
    const code = last?.state === 'hidden' ? 'element_hidden' : last?.state === 'covered' ? 'element_covered' : 'element_not_found';
    throw new StepFailure(code, { menuTried, waitedMs: Date.now() - start, trace });
  }

  private async show(t: Target, cmd: OverlayCommand) { if (this.rec.cursor) await t.run(overlayScript(t.kind, cmd)).catch(() => {}); }
  /** Moves the pointer (web) or lands the fingertip (phone) on the target, with a ring around the element. */
  private async approach(t: Target, hit: Hit) {
    if (!this.rec.cursor) return;
    const from = this.pointer.get(t.kind), distance = from ? Math.hypot(hit.x - from.x, hit.y - from.y) : 320;
    const ms = Math.round(Math.min(760, Math.max(260, 200 + distance * 0.5)) / this.speed);
    this.pointer.set(t.kind, { x: hit.x, y: hit.y });
    await this.show(t, { op: 'approach', from, to: { x: hit.x, y: hit.y }, rect: hit.rect, ms });
    await sleep(ms);
  }
  private async tap(t: Target, hit: Hit) {
    await this.approach(t, hit);
    const p = { x: hit.x, y: hit.y };
    if (t.kind === 'mobile') {
      // A real touch sequence; the page's gesture detection turns it into a tap and click.
      // Input coordinates are in view pixels, so map CSS pixels through the phone's fit-to-column scale.
      const s = t.scale();
      await this.show(t, { op: 'press', at: p });
      await t.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x * s, y: p.y * s, radiusX: 6, radiusY: 6, force: 1 }] });
      await sleep(70);
      await t.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await this.show(t, { op: 'release' });
      return;
    }
    // Hover first so the page shows its hover state, as it would under a real hand.
    await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await sleep(Math.round(90 / this.speed));
    await this.show(t, { op: 'press', at: p });
    await t.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await t.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
    await this.show(t, { op: 'release' });
  }
  private async key(t: Target, name: keyof typeof KEYS) {
    const k = KEYS[name];
    if (name !== 'Backspace') await this.show(t, { op: 'key', label: KEY_BADGE[name] });
    await t.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await t.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined });
  }
  private async perform(t: Target, step: Step, skipPre: boolean, ctx: StepContext): Promise<'ok' | 'noop' | 'skipped'> {
    if (t.kind === 'mobile' && step.mobileSkip) { ctx.note = 'skip on phone'; return 'noop'; }
    if (step.kind === 'navigate') { await t.navigate(step.path || '/'); await this.settle(t); await this.show(t, { op: 'init', from: this.pointer.get(t.kind) }); return 'ok'; }
    if (step.kind === 'login') { if (t.isLoginPage()) await t.login(); else ctx.note = 'already signed in'; await this.settle(t); return 'ok'; }
    if (step.kind === 'scroll') {
      await t.run(scrollScript(step.scroll ?? 0));
      // Wait for the smooth scroll to come to rest rather than a fixed time.
      let last = -1; await this.until(async () => { const y = await t.run('scrollY'); const still = y === last; last = y; return still; }, 1600);
      return 'ok';
    }
    if (t.isLoginPage()) throw new AppError('protected_login_page');
    if (step.kind === 'key') { await this.key(t, step.key || 'Enter'); await this.settle(t); return 'ok'; }
    if (step.kind === 'dismiss') {
      const count = (): Promise<number> => t.run(dialogCountScript).catch(() => 0);
      const before = await count(); if (!before) { ctx.note = 'no dialog open'; return 'noop'; }
      await this.key(t, 'Escape');
      if (await this.until(async () => (await count()) < before, 900)) { ctx.note = 'closed with Escape'; return 'ok'; }
      const outside: Point | null = await t.run(outsideScript).catch(() => null);
      if (outside) { await this.tap(t, outside); if (await this.until(async () => (await count()) < before, 1200)) { ctx.note = 'closed by tapping outside'; return 'ok'; } }
      throw new AppError('dialog_did_not_close');
    }
    const selectors = step.selectors; if (!selectors?.length) throw new AppError('step_without_selector');
    if (t.kind === 'mobile' && !skipPre) for (const pre of step.mobilePre) {
      const p = await this.locate(t, pre, 4000).catch(() => null);
      if (p) { await this.tap(t, p); await sleep(Math.round(380 / this.speed) + 60); } else ctx.note = 'phone pre-step not found';
    }
    if (step.kind === 'click' && step.optional) {
      // A click on a non-clickable spot (usually to dismiss focus): replay it where it landed, or move on.
      const hit = await this.locate(t, selectors, 2500).catch(() => null);
      if (!hit) { ctx.note = 'optional click: not found, skipped'; return 'skipped'; }
      ctx.selector = hit.selector;
      const at = step.at && hit.rect ? { x: Math.round(hit.rect.x + hit.rect.w * step.at[0]), y: Math.round(hit.rect.y + hit.rect.h * step.at[1]) } : hit;
      await this.tap(t, { ...at, rect: hit.rect }); await this.settle(t); return 'ok';
    }
    const hit = await this.locate(t, selectors); ctx.selector = hit.selector;
    if (step.kind === 'click') { await this.tap(t, hit); await this.settle(t); return 'ok'; }
    if (step.kind === 'check') {
      const now = await t.run(checkedScript(selectors));
      if (now === step.checked) { ctx.note = `already ${now ? 'on' : 'off'}`; await this.approach(t, hit); await this.show(t, { op: 'release' }); return 'noop'; }
      await this.tap(t, hit); return 'ok';
    }
    if (step.kind === 'select') {
      await this.approach(t, hit); await this.show(t, { op: 'press', at: hit }); await this.show(t, { op: 'release' });
      const result = await t.run(selectScript(selectors, step.value ?? ''));
      if (result === 'missing') throw new AppError('option_not_found');
      if (result === 'same') ctx.note = 'already selected';
      await this.settle(t); return result === 'same' ? 'noop' : 'ok';
    }
    // type
    await this.tap(t, hit);
    const focus = await t.run(focusedScript);
    if (focus === 'secret') throw new AppError('protected_field');
    if (focus === 'none') throw new AppError('field_not_focusable');
    if (focus !== 'selected') await t.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] });
    const text = stepText(step, this.lang);
    if (!text) { await this.key(t, 'Backspace'); return 'ok'; }
    if (this.rec.typing === 'instant' || text.length > 160) { await t.cdp('Input.insertText', { text }); return 'ok'; }
    for (const ch of text) { await t.cdp('Input.insertText', { text: ch }); await sleep(Math.round(38 / this.speed)); }
    return 'ok';
  }
}
