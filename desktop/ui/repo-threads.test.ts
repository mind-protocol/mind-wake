import {expect,it} from 'vitest';
import {repoThreads} from './repo-threads.js';
it('keeps participants and full message text, handles absent or malformed optional data',()=>{
  expect(repoThreads(null)).toEqual([]);
  expect(repoThreads({schema:'mind-wake.cli',data:{}})).toEqual([]);
  const text='<script>not HTML</script>\n'+ 'long message '.repeat(100);
  const rows=repoThreads({schema:'mind-wake.cli',data:{repoThreads:[null,{id:'t',repo:'C:\\Users\\reyno\\le-conseil2',messages:[{}, {id:'m',at:'2026-10-29T10:00:00Z',from:'repo',text}]}]}});
  expect(rows[0]!.project).toBe('le-conseil2');
  expect(rows[0]!.messages[0]!.text).toBe(text);
  expect(rows[0]!.messages[0]!.from).toBe('repo');
});
