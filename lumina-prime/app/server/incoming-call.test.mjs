import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { openPhoneBook } from '../../../services/mcp/phone-book.mjs';
import { createChatServer } from './chat-server.mjs';

test('signed MCP call reaches only the addressed phones and one accepted call returns the caller', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wake-incoming-'));
  const phones = openPhoneBook(dir);
  const client = new Client({name:'phone-test',version:'1'});
  const transport = new StdioClientTransport({command:process.execPath,
    args:['--experimental-transform-types','--import',new URL('../../../test/fixtures/store-ledger/ts-hooks.ts',import.meta.url).href,
      fileURLToPath(new URL('../../../services/mcp/fork-owner-main.ts',import.meta.url))],
    env:{...process.env,MIND_WAKE_OWNER_SIGNATURE:'VOX (Room 7)',MIND_WAKE_DATA_DIR:dir}});
  let owner = 'nlr';
  const gateway = createChatServer({phones, phoneOwner:()=>owner, bridge:{snapshot:()=>[],send(){}},
    privateNetworkConnect:true, call:{resolve: caller=>assert.equal(caller,'vox')}});
  try {
    await client.connect(transport);
    await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
    const base = 'http://127.0.0.1:'+gateway.server.address().port+'/chat/';
    const post = (route,body,token) => fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',
      ...(token ? {Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    const session = async () => (await (await post('connect-local',{})).json()).token;
    const pending = async token => (await (await fetch(base+'phone/pending',{headers:{Authorization:'Bearer '+token}})).json()).invite;
    const nlr = await session();
    owner = 'aurore';
    const other = await session();
    const desktop = await session();
    await post('phone/register',{token:null},desktop);
    await post('phone/register',{token:'ExpoPushToken[abc]'},other);
    const invoke = args => client.callTool({name:'call_human',arguments:args});
    assert.equal((await invoke({handle:'@unknown'})).isError,true);
    await invoke({handle:'@Aurore'});
    assert.equal(await pending(nlr),null);
    const invite = await pending(other);
    assert.equal(invite.caller,'vox');
    let deliveries = 0;
    const push = messages => { deliveries++; assert.equal(messages[0].data.callId,invite.id);return [{status:'ok'}]; };
    await phones.push(push); await phones.push(push); assert.equal(deliveries,1);
    assert.equal((await post('phone/answer',{id:invite.id,decision:'accept'},nlr)).status,409);
    assert.equal((await pending(desktop)).id,invite.id);
    const answer = token => post('phone/answer',{id:invite.id,decision:'accept'},token);
    assert.deepEqual((await Promise.all([answer(other),answer(desktop)])).map(r=>r.status).sort(),[200,409]);
    assert.equal(await pending(other),null);
    assert.equal(await pending(desktop),null);
    for (const args of [{},{handle:'@NLR-AI'}]) {
      await invoke(args);
      const next = await pending(nlr);
      assert.equal(next.caller,'vox');
      assert.equal((await post('phone/answer',{id:next.id,decision:'decline'},nlr)).status,200);
    }
  } finally { await client.close(); await gateway.close(); phones.close(); rmSync(dir,{recursive:true,force:true}); }
});
