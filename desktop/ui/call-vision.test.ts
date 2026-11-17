import { afterEach, expect, it, vi } from 'vitest';
import { callVisionFeed, type CallFrame, type CallFramesMessage } from './call-vision.js';

afterEach(() => { vi.useRealTimers(); });
const frame = (id: number): CallFrame => ({id, at: 1_700_000_000_000 + id, author: 'NLR', target: 'Chrome', grid_text: 'row ' + id});
const panel = () => ({hidden: false, children: [] as unknown[], replaceChildren() { this.children = []; }});
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

it('forwards each new batch to the call iframe in ascending order, objects untouched, panel kept hidden', async () => {
  vi.useFakeTimers();
  const sent: CallFramesMessage[] = [], calls: number[] = [];
  const batches = [[frame(2), frame(1)], [frame(2), frame(3)], []];
  const feed = panel();
  const show = callVisionFeed(feed as unknown as HTMLElement, async (_call, after) => { calls.push(after); return batches.shift() ?? []; }, m => sent.push(m));
  expect(feed.hidden).toBe(true);
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  show(id); await flush();
  expect(sent).toEqual([{type: 'mind.call.frames', id, frames: [frame(1), frame(2)]}]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toEqual([0, 2]);
  expect(sent[1]).toEqual({type: 'mind.call.frames', id, frames: [frame(3)]});
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent).toHaveLength(2); // empty batch: nothing posted
  expect(feed.hidden).toBe(true); expect(feed.children).toEqual([]);
});

it('a new call restarts the cursor; frames of the previous call are dropped', async () => {
  vi.useFakeTimers();
  const sent: CallFramesMessage[] = [];
  let resolveOld!: (f: CallFrame[]) => void;
  const show = callVisionFeed(panel() as unknown as HTMLElement, (call, after) => call === 'a'.repeat(36)
    ? new Promise(r => { resolveOld = r; })
    : Promise.resolve(after === 0 ? [frame(1)] : []), m => sent.push(m));
  show('a'.repeat(36)); show('b'.repeat(36)); await flush();
  resolveOld([frame(9)]); await flush();
  expect(sent).toEqual([{type: 'mind.call.frames', id: 'b'.repeat(36), frames: [frame(1)]}]);
  show(''); await vi.advanceTimersByTimeAsync(5000);
  expect(sent).toHaveLength(1);
});
