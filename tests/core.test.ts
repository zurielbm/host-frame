import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/store';
import { allowedUrl, normalizeOrigins, sessionKey, specs } from '../src/contracts';
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
