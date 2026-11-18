import {describe,it,expect} from 'vitest';
import {roleMcpServers} from './codex-role-turn.js';
describe('role MCP catalog readiness',()=>{
  it('requires the existing owner MCP without changing its env or tool filters',()=>{
    const env={MIND_WAKE_OWNER_MESSAGES:'1',MIND_WAKE_OWNER_SIGNATURE:'VOX (Room 7)'};
    const mind={command:'node',args:['C:/repo/services/mcp/fork-owner-main.ts'],env,enabled_tools:['list_active_calls','call_human']};
    const result=roleMcpServers({mind,other:{command:'other'}}) as {mind:typeof mind & {required:boolean;startup_timeout_sec:number}};
    expect(result.mind.required).toBe(true);expect(result.mind.startup_timeout_sec).toBe(30);expect(result.mind.env).toBe(env);expect(result.mind.enabled_tools).toBe(mind.enabled_tools);expect(mind).not.toHaveProperty('required');
  });
  it('preserves configured timeouts and leaves unrelated servers unchanged',()=>{
    const mind={args:['C:\\repo\\services\\mcp\\fork-owner-main.ts'],startup_timeout_sec:60};
    expect((roleMcpServers({mind})["mind"] as Record<string,unknown>)["startup_timeout_sec"]).toBe(60);
    const unrelated={mind:{args:['unrelated.ts']},other:{required:false}};expect(roleMcpServers(unrelated)).toBe(unrelated);expect(roleMcpServers({})).toEqual({});
  });
});
