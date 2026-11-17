import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HUMAN_CALL_PROMPT, withHumanCallPrompt } from './human-call-prompt.js';
import { withWakePersonality } from '../adapters/wake-system-prompt.js';
import { assignedForkPrompt, validateAssignment } from '../daemon/fork-assignment.js';
import { roomAgentPrompt } from '../daemon/room-agents.js';
import { coachSystemPrompt } from '../daemon/coach.js';
import { fastReplySystemPrompt } from './fast-reply.js';
import { patternHolderSystemPrompt } from './pattern-holders.js';
let root: string;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'human-call-guidance-'));});
afterEach(()=>{if(!root.startsWith(path.join(os.tmpdir(),'human-call-guidance-')))throw Error('Unexpected temporary path');fs.rmSync(root,{recursive:true,force:true});});
function once(prompt:string){expect(prompt.split(HUMAN_CALL_PROMPT)).toHaveLength(2);}
it('covers useful questions and blockers, without retries or invented delivery',()=>{
 expect(HUMAN_CALL_PROMPT).toContain('useful question');
 expect(HUMAN_CALL_PROMPT).toContain('initiate brief calls regularly');
 expect(HUMAN_CALL_PROMPT).toContain('do not wait only for a blockage');
 expect(HUMAN_CALL_PROMPT).toContain('skip empty or repetitive updates');
 expect(HUMAN_CALL_PROMPT).toContain('even without a blockage');
 expect(HUMAN_CALL_PROMPT).toContain('an authorized call is already active');
 expect(HUMAN_CALL_PROMPT).toContain('at most one call');
 expect(HUMAN_CALL_PROMPT).toContain('Queued is not answered');
 expect(HUMAN_CALL_PROMPT).toContain('Force-off');
 expect(withHumanCallPrompt(withHumanCallPrompt('role'))).toBe(withHumanCallPrompt('role'));
});
it('covers principal and fast reply, with role overrides and no personal file',()=>{
 once(withWakePersonality(root,'custom Codex or Claude role'));
 once(fastReplySystemPrompt(root));
 const roles=path.join(root,'artifacts/prompts/system');fs.mkdirSync(roles,{recursive:true});
 fs.writeFileSync(path.join(roles,'coach.md'),'Custom coach, preserve this role.');
 const coach=coachSystemPrompt(root);once(coach);expect(coach).toContain('Custom coach');
});
it('covers assigned room, room holder/coach and their own instructions',()=>{
 const instructions=path.join(root,'ROOM.md');fs.writeFileSync(instructions,'Room identity');
 const own=path.join(root,'agent.md');fs.writeFileSync(own,'Holder identity');
 const a=validateAssignment({workspace:root,instructions,engine:'claude',agents:[{id:'coach-colony',name:'Coach Colony',instructions:own,writable:[],tools:'none',owner:{colony:null,profile:'publish'},private:false}]});
 const assigned=assignedForkPrompt(7,a);once(assigned);expect(assigned).toContain('Room identity');
 const agent=a.agents?.[0];if(!agent)throw Error('Missing fixture agent');
 const room=roomAgentPrompt(2,a,agent,null);once(room);expect(room).toContain('Holder identity');
});
it('also tells historical tool-less holders to report unavailable calls honestly',()=>{
 const holder=patternHolderSystemPrompt({file:path.join(root,'holder.md'),slug:'holder',name:'Holder',emoji:'H',quietMs:0,seed:'Seed as data'});
 once(holder);expect(holder).toContain('If call_human is unavailable');expect(holder).toContain('Seed as data');
});
