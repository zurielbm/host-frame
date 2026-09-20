import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const client=new Client({name:'hostframe-check',version:'1.0.0'}, {versionNegotiation:{mode:{pin:'2026-07-28'}}});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.cjs')],stderr:'pipe'});
try{
  await client.connect(transport);
  assert.equal(client.getProtocolEra(),'modern');
  assert.equal(client.getNegotiatedProtocolVersion(),'2026-07-28');
  const tools=await client.listTools();
  assert(tools.tools.some(t=>t.name==='credentials_put'));
  assert(!tools.tools.some(t=>/credentials_(get|read|export)/.test(t.name)));
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});const code=result.isError&&result.content[0]?.type==='text'?result.content[0].text.match(/^[a-z_]{1,80}:/)?.[0]:undefined;assert(!result.isError,`${name} failed${code?' ('+code.slice(0,-1)+')':''}`);return result;};
  const state=JSON.parse((await call('state_get')).content[0].text);
  assert(state.panes.length>=7);
  const demoEnvironment=state.environments.find(e=>e.demo);
  assert(demoEnvironment,'Check requires the bundled demo; never targets external accounts');
  const pane=state.panes.find(p=>state.accounts.find(a=>a.id===p.accountId)?.environmentId===demoEnvironment.id);
  await call('auth_login',{paneId:pane.id});
  const snapshot=JSON.parse((await call('page_snapshot',{paneId:pane.id})).content[0].text);
  assert(snapshot.text.includes('DISPATCH'));
  const capture=await call('capture',{paneId:pane.id});
  assert(capture.content[0].type==='image');assert(capture.content[0].mimeType==='image/png');
  const status=JSON.parse((await call('credentials_status',{accountId:pane.accountId})).content[0].text);
  assert(!('email' in status));assert(!('password' in status));
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/agent-check.json',JSON.stringify({passed:true,protocolVersion:client.getNegotiatedProtocolVersion(),toolCount:tools.tools.length,checks:['MCP modern stdio discovery','metadata-only credential status','demo login','DOM snapshot','PNG image content']},null,2));
  console.log('MCP check passed: '+tools.tools.length+' tools; login, snapshot, PNG image and metadata-only credentials.');
}catch(error){
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/agent-check.json',JSON.stringify({passed:false,protocolVersion:client.getNegotiatedProtocolVersion(),error:error instanceof assert.AssertionError?error.message:'agent_check_failed'},null,2));
  throw error;
}finally{await client.close();}
