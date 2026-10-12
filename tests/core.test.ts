import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/store';
import { GENERATED_ID, allowedUrl, clampDelay, isLoginUrl, localizePath, localizeSelector, normalizeOrigins, recordingSchema, scaledDelay, sessionKey, specs } from '../src/contracts';
import { explain, stepText } from '../src/replay';
import { balancedLayout, removePane, splitPane } from '../src/layout';

test('URL resolution rejects cross-origin, file and credential-bearing navigation',()=>{
  assert.equal(allowedUrl('/jobs','https://qa.example.test'),'https://qa.example.test/jobs');
  for(const url of ['https://evil.test','//evil.test','file:///C:/secret','javascript:alert(1)','https://name:secret@qa.example.test'])assert.throws(()=>allowedUrl(url,'https://qa.example.test'));
  // Explicitly allowed extra origins (hosted auth handshakes) pass; anything else still fails.
  assert.equal(allowedUrl('https://app.clerk.accounts.dev/v1/client/handshake?x=1','http://localhost:3001',['https://app.clerk.accounts.dev']),'https://app.clerk.accounts.dev/v1/client/handshake?x=1');
  assert.throws(()=>allowedUrl('https://evil.test/','http://localhost:3001',['https://app.clerk.accounts.dev']));
  assert.deepEqual(normalizeOrigins([' app.clerk.accounts.dev/path ','https://app.clerk.accounts.dev','']),['https://app.clerk.accounts.dev']);
  assert.throws(()=>normalizeOrigins(['file:///C:/']));
});
test('persistent and disposable session identities do not collide',()=>{
  assert.equal(sessionKey('alex'),'persist:account-alex');assert.notEqual(sessionKey('alex'),sessionKey('taylor'));assert.ok(!sessionKey('alex','copy-1').startsWith('persist:'));assert.notEqual(sessionKey('alex','copy-1'),sessionKey('alex','copy-2'));
});
test('login protection includes nested password and verification steps without blocking the app',()=>{
  const base='http://localhost:3001';
  for(const path of ['/sign-in','/sign-in/','/sign-in/factor-one','/sign-in/client-trust?redirect_url=/dashboard'])assert.equal(isLoginUrl(base+path,base,'/sign-in/'),true);
  for(const path of ['/dashboard','/sign-in-help'])assert.equal(isLoginUrl(base+path,base,'/sign-in'),false);
  assert.equal(isLoginUrl(base+'/dashboard',base,'/'),false);
});
test('write-only receipt, stale write rejection, persisted encryption and copy-on-write lifetime',()=>{
  const dir=mkdtempSync(join(tmpdir(),'hostframe-test-'));
  // Deterministic opaque codec for domain tests; Electron smoke exercises actual Windows safeStorage.
  const encode=(s:string)=>Buffer.from(s.split('').reverse().join(''));
  const decode=(b:Buffer)=>b.toString().split('').reverse().join('');
  try{
    const vault=new Vault(dir,encode,decode);
    const pair={email:'private@example.test',password:'never-echo-this'};
    const receipt=vault.put('account',pair,0);assert.equal(receipt.revision,1);
    assert.ok(!JSON.stringify(receipt).includes(pair.email));assert.ok(!JSON.stringify(receipt).includes(pair.password));
    assert.ok(!readFileSync(join(dir,'vault.json'),'utf8').includes(pair.password));
    assert.throws(()=>vault.put('account',{email:'other',password:'other'},0),/revision_conflict/);
    assert.deepEqual(vault.use('account'),pair);
    vault.put('account',{email:'copy',password:'temporary'},1,'copy-1');
    assert.equal(vault.use('account','copy-1').password,'temporary');assert.equal(vault.use('account').password,pair.password);
    vault.removeTemporary('copy-1');assert.equal(vault.status('account','copy-1').inherited,true);
    assert.deepEqual(new Vault(dir,encode,decode).use('account'),pair);
    assert.ok(!('credentials_get' in specs));assert.ok(!('page_evaluate' in specs));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('seven panes can split, resize structurally and collapse without orphaning siblings',()=>{
  let tree=balancedLayout(['a','b','c','d','e','f','g'])!;
  tree=splitPane(tree,'a','h','column');tree=removePane(tree,'a')!;
  const collect=(t:any):string[]=>t.type==='leaf'?[t.paneId]:[...collect(t.first),...collect(t.second)];
  assert.deepEqual(collect(tree).sort(),['b','c','d','e','f','g','h']);
  for(const id of collect(tree))tree=removePane(tree,id)!;
  assert.equal(tree,null);
});
test('recorded timing, replay speed and language-path rewriting',()=>{
  assert.equal(clampDelay(40),300);assert.equal(clampDelay(1200),1200);assert.equal(clampDelay(45000),3000);
  assert.equal(scaledDelay(1000,2),500);assert.equal(scaledDelay(1000,0.5),2000);assert.equal(scaledDelay(1000,0),1000);
  assert.equal(localizePath('/en/jobs?x=1','en','es'),'/es/jobs?x=1');
  assert.equal(localizePath('/en-US/jobs','en','es'),'/es/jobs');
  assert.equal(localizePath('/entries/1','en','es'),'/entries/1');
  assert.equal(localizePath('/jobs','en','es'),'/jobs');
  assert.equal(localizeSelector('a[href="\\/en\\/jobs"]','en','es'),'a[href="/es/jobs"]');
  assert.equal(localizeSelector('#menu','en','es'),'#menu');
});
test('selectors skip framework-generated ids and recordings validate',()=>{
  for(const id of [':r1:','radix-:R1:','headlessui-menu-3','mui-12','react-select-2-input','1abc','card-8f3a9c2e1b','row-20240101','«r3»-form-item','_r_5_-form-item',':r2:-form-item-description'])assert.ok(GENERATED_ID.test(id),id);
  for(const id of ['job-title','menu','assign-job','note'])assert.ok(!GENERATED_ID.test(id),id);
  const rec=recordingSchema.parse({id:'r1',name:'Assign',environmentId:'local',accountId:'a1',createdAt:new Date().toISOString(),steps:[{id:'s1',kind:'type',delayMs:400,selectors:['#note'],text:'Fix sink',texts:{es:'Arreglar fregadero'}}]});
  assert.equal(rec.replayLang,'es');assert.equal(rec.speed,1);assert.deepEqual(rec.steps[0].mobilePre,[]);
  assert.equal(stepText(rec.steps[0],'es'),'Arreglar fregadero');assert.equal(stepText(rec.steps[0],'es-MX'),'Arreglar fregadero');assert.equal(stepText(rec.steps[0],'fr'),'Fix sink');
  assert.throws(()=>recordingSchema.parse({...rec,id:'../escape'}));
  assert.throws(()=>recordingSchema.parse({...rec,replayLang:'spanish!'}));
  for(const c of ['recording_start','recording_stop','replay_start','replay_control'])assert.ok(c in specs);
});

test('failed steps are explained in plain language', () => {
  const step = (over: object) => recordingSchema.shape.steps.element.parse({ id: 's1', kind: 'click', delayMs: 0, label: 'Save settings', selectors: ['[role="dialog"] > footer:nth-of-type(1) > button:nth-of-type(2)'], ...over });
  const diag = (problem: string, matches = 0, visible = 0, dialog = '') => ({ url: '/settings', title: '', dialog, focus: '', selectors: [{ selector: '#x', matches, visible, problem, coveredBy: problem === 'covered' ? 'div.overlay' : '' }] });
  const missing = explain(step({}), { code: 'element_not_found', target: 'web', diagnosis: diag('no match') });
  assert.equal(missing.message, 'Couldn’t find “Save settings”'); assert.match(missing.hint, /recorded inside a dialog/);
  assert.match(explain(step({}), { code: 'element_covered', target: 'web', diagnosis: diag('covered', 1, 1, 'Trips') }).hint, /div\.overlay.*“Trips”/);
  assert.match(explain(step({}), { code: 'element_hidden', target: 'mobile', diagnosis: diag('display:none', 1, 0) }).hint, /menu button/);
  const choice = step({ kind: 'check', label: 'With warehouse stops', checked: true });
  assert.match(explain(step({ selectors: ['#save'] }), { code: 'element_not_found', target: 'web', diagnosis: diag('no match') }, choice).hint, /“With warehouse stops”.*already had that value/);
  assert.match(explain(step({ selectors: ['main > div:nth-of-type(3)'], fragile: true }), { code: 'element_not_found', target: 'web', diagnosis: diag('no match') }).hint, /data-testid/);
  assert.ok(recordingSchema.shape.steps.element.safeParse({ id: 's2', kind: 'dismiss', delayMs: 300, label: 'Close Trips' }).success);
});
