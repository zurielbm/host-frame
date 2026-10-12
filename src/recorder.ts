import { GENERATED_ID } from './contracts';

/** Isolated world shared by the recorder and replay scripts: same DOM as the page, separate JavaScript globals. */
export const WORLD = 1207;

/**
 * Page-side recorder. Reports steps as console messages prefixed with a per-session token.
 * Selectors avoid visible text so a flow recorded in English still resolves in Spanish.
 * mode 'record' captures a flow; 'pick' reports the next tap once (mobile-only pre-steps); 'off' stops.
 */
export function recorderScript(prefix: string, mode: 'record' | 'pick' | 'off') {
  return `(()=>{
  if(window.__hfRec){Object.assign(window.__hfRec,{mode:${JSON.stringify(mode)},prefix:${JSON.stringify(prefix)}});return 'updated';}
  if(${JSON.stringify(mode)}==='off')return 'off';
  const rec=window.__hfRec={mode:${JSON.stringify(mode)},prefix:${JSON.stringify(prefix)}};
  const GEN=${GENERATED_ID};
  const TEST=['data-testid','data-test-id','data-test','data-cy','data-qa'];
  const ACTIVE='a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=radio],[onclick],[tabindex]';
  const TEXT_TYPES=['text','search','email','url','tel','number','date','datetime-local','month','week','time',''];
  const esc=v=>CSS.escape(v);
  const send=step=>console.debug(rec.prefix+JSON.stringify(step));
  const unique=s=>{try{return document.querySelectorAll(s).length===1}catch{return false}};
  const secret=e=>e instanceof HTMLInputElement&&e.type==='password'||!!e.closest?.('form')?.querySelector('input[type=password]');
  const isText=e=>e instanceof HTMLTextAreaElement||e instanceof HTMLInputElement&&TEXT_TYPES.includes(e.type)||!!e.isContentEditable;
  const anchor=n=>{for(const a of TEST){const v=n.getAttribute&&n.getAttribute(a);if(v)return '['+a+'="'+esc(v)+'"]';}return n.id&&!GEN.test(n.id)?'#'+esc(n.id):'';};
  // Dialogs, menus and popovers are portaled to the end of <body>, where sibling order changes between sessions. Paths start at them instead.
  const ROOTS='dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true],[role=menu],[role=listbox],[popover]';
  const rootSel=n=>n.matches('dialog')?'dialog[open]':n.getAttribute('role')?'[role="'+esc(n.getAttribute('role'))+'"]':n.getAttribute('aria-modal')==='true'?'[aria-modal="true"]':'[popover]';
  const path=el=>{const parts=[];let n=el;let anchored=false;
    while(n&&n.nodeType===1&&n!==document.documentElement){const a=n!==el&&(anchor(n)||(n.matches(ROOTS)?rootSel(n):''));if(a){parts.unshift(a);anchored=true;break;}
      let i=1,s=n;while((s=s.previousElementSibling))if(s.tagName===n.tagName)i++;parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+i+')');n=n.parentElement;}
    return {sel:parts.join(' > '),anchored};};
  const candidates=el=>{const out=[];const tag=el.tagName.toLowerCase();const add=s=>{if(out.length<3&&!out.includes(s)&&unique(s))out.push(s);};
    for(const a of TEST){const v=el.getAttribute(a);if(v)add('['+a+'="'+esc(v)+'"]');}
    if(el.id&&!GEN.test(el.id))add('#'+esc(el.id));
    const name=el.getAttribute('name');if(name)add(tag+'[name="'+esc(name)+'"]');
    const href=el.getAttribute('href');if(tag==='a'&&href&&!/^javascript:/i.test(href))add('a[href="'+esc(href)+'"]');
    const controls=el.getAttribute('aria-controls');if(controls&&!GEN.test(controls))add(tag+'[aria-controls="'+esc(controls)+'"]');
    if(el.matches(ROOTS))add(rootSel(el));
    const root=el.parentElement&&el.parentElement.closest(ROOTS);if(root&&tag==='button'&&el.type==='submit')add(rootSel(root)+' button[type="submit"]');
    const stable=out.length>0;const p=path(el);if(out.length<2||!stable)out.push(p.sel);
    return {selectors:out.slice(0,4),fragile:!stable&&!p.anchored};};
  // Display only (the step editor); never used to find the element again.
  const label=el=>{const field=isText(el)||el instanceof HTMLSelectElement||el instanceof HTMLInputElement;
    const t=el.getAttribute('aria-label')||(field?(el.labels&&el.labels[0]&&el.labels[0].innerText)||el.placeholder||el.getAttribute('name')||el.id:el.innerText||el.value)||el.tagName.toLowerCase();
    return String(t).replace(/\\s+/g,' ').trim().slice(0,60);};
  let host;const flash=el=>{try{if(!host){host=document.createElement('hf-record-flash');const root=host.attachShadow({mode:'closed'});root.innerHTML='<div style="position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #d64545;border-radius:6px;box-shadow:0 0 0 4px rgba(214,69,69,.18);transition:opacity .35s;opacity:0"></div>';host._box=root.firstChild;}
    if(!host.isConnected)document.documentElement.appendChild(host);const r=el.getBoundingClientRect(),b=host._box;Object.assign(b.style,{left:r.left-3+'px',top:r.top-3+'px',width:r.width+6+'px',height:r.height+6+'px',opacity:'1'});clearTimeout(host._t);host._t=setTimeout(()=>b.style.opacity='0',450);}catch{}};
  // What was clicked, kept with the step so a failed replay can show what it was looking for. Never includes field values.
  const snapshot=el=>{const tag=el.tagName.toLowerCase(),attrs=[...el.attributes].filter(a=>!/^(value|style|on|d$|points$)/i.test(a.name)).slice(0,8).map(a=>a.name+'="'+String(a.value).slice(0,60)+'"').join(' ');
    const d=el.parentElement&&el.parentElement.closest(ROOTS),r=el.getBoundingClientRect(),t=s=>String(s||'').replace(/\s+/g,' ').trim();
    return {tag,html:('<'+tag+(attrs?' '+attrs:'')+'>').slice(0,300),text:isText(el)?'':t(el.innerText).slice(0,120),dialog:d?t(d.getAttribute('aria-label')||d.querySelector('h1,h2,h3')?.innerText||rootSel(d)).slice(0,80):'',pos:Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.width)+'×'+Math.round(r.height)+' in '+innerWidth+'×'+innerHeight};};
  const emit=(kind,el,extra)=>{flash(el);send({kind,label:label(el),...candidates(el),target:snapshot(el),...extra});};
  const typed=new WeakMap();
  const commitText=el=>{const value=el.isContentEditable?el.innerText:el.value;if(typed.get(el)===value)return;typed.set(el,value);emit('type',el,{text:value});};
  // A press outside an open dialog closes it. Replay closes it with Escape (then a tap outside), wherever the backdrop is on that screen.
  const DIALOGS='dialog:modal,[aria-modal="true"],[role=dialog],[role=alertdialog]';
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const fullscreen=e=>{const r=e.getBoundingClientRect();return r.width>=innerWidth*.9&&r.height>=innerHeight*.9;};
  document.addEventListener('pointerdown',e=>{const t=e.target;if(!e.isTrusted||rec.mode!=='record'||!(t instanceof Element))return;
    const open=[...document.querySelectorAll(DIALOGS)].filter(visible);if(!open.length)return;
    const top=open[open.length-1];let outside;
    if(t instanceof HTMLDialogElement&&t.matches(':modal')){const r=t.getBoundingClientRect();outside=e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;}
    // Outside every dialog, or on a full-screen backdrop/wrapper inside one (Headless UI) away from all of its children.
    else{const inBox=c=>{const r=c.getBoundingClientRect();return e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom;};
      outside=!t.closest(ACTIVE)&&(!open.some(d=>d.contains(t))||fullscreen(t)&&![...t.children].some(inBox));}
    if(!outside)return;
    rec.ignoreClickUntil=Date.now()+800;
    const name=(top.getAttribute('aria-label')||top.querySelector('h1,h2,h3')?.innerText||'dialog').replace(/\s+/g,' ').trim().slice(0,50);
    send({kind:'dismiss',label:'Close '+name});},true);
  document.addEventListener('click',e=>{if(!e.isTrusted||rec.mode==='off'||!(e.target instanceof Element))return;
    if(rec.mode==='record'&&Date.now()<(rec.ignoreClickUntil||0))return;
    const el=e.target.closest(ACTIVE)||e.target;if(secret(el))return;
    if(rec.mode==='pick'){rec.mode='off';emit('pick',el,{});return;}
    if(isText(el)||el instanceof HTMLSelectElement)return;
    if(el instanceof HTMLInputElement&&['checkbox','radio'].includes(el.type))return;
    if(el instanceof HTMLLabelElement&&el.control&&(isText(el.control)||['checkbox','radio'].includes(el.control.type)))return;
    // Clicks on things that don't look clickable are usually clicks to dismiss focus; replay skips them if they can't be found.
    const optional=!e.target.closest(ACTIVE)&&getComputedStyle(el).cursor!=='pointer';
    const r=el.getBoundingClientRect(),at=optional&&r.width&&r.height?[Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))]:undefined;
    emit('click',el,optional?{optional,at}:{});},true);
  document.addEventListener('change',e=>{const el=e.target;if(!e.isTrusted||rec.mode!=='record'||!(el instanceof Element)||secret(el))return;
    if(el instanceof HTMLInputElement&&['checkbox','radio'].includes(el.type))return emit('check',el,{checked:el.checked});
    if(el instanceof HTMLSelectElement)return emit('select',el,{value:el.value});
    if(isText(el))commitText(el);},true);
  document.addEventListener('focusout',e=>{const el=e.target;if(rec.mode==='record'&&el instanceof HTMLElement&&el.isContentEditable&&!secret(el))commitText(el);},true);
  document.addEventListener('keydown',e=>{const el=e.target;if(!e.isTrusted||rec.mode!=='record'||!(el instanceof Element)||secret(el))return;
    if(e.key==='Enter'&&isText(el)&&!(el instanceof HTMLTextAreaElement)&&!el.isContentEditable){commitText(el);send({kind:'key',key:'Enter',label:'Enter'});}
    else if(e.key==='Escape')send({kind:'key',key:'Escape',label:'Escape'});},true);
  let scrollTimer;window.addEventListener('scroll',()=>{if(rec.mode!=='record')return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{const max=document.documentElement.scrollHeight-innerHeight;if(max>0)send({kind:'scroll',scroll:Math.round(Math.min(1,scrollY/max)*1000)/1000,label:Math.round(scrollY/max*100)+'%'});},450);},{passive:true});
  return 'started';
})()`;
}
