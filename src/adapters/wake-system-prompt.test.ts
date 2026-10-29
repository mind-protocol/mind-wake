import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERSONALITY_FILE, withWakePersonality } from './wake-system-prompt.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-wake-personality-')); });
afterEach(() => {
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'mind-wake-personality-'))) throw new Error('Unexpected temporary path');
  fs.rmSync(root, { recursive: true, force: true });
});
function writePersonality(text: string): void {
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, PERSONALITY_FILE), text);
}

describe('personal system prompt', () => {
  it('starts with the shared voice when there is no personal file', () => {
    expect(withWakePersonality(root, 'shared direction')).toBe('shared direction');
  });
  it('reloads edits at the next wake while preserving the base', () => {
    writePersonality('A warm, playful voice; concise and candid.');
    const first = withWakePersonality(root, 'shared direction');
    expect(first).toContain('shared direction');
    expect(first).toContain('A warm, playful voice');
    writePersonality('A quieter voice, with room for questions and disagreement.');
    const next = withWakePersonality(root, 'shared direction');
    expect(next).toContain('A quieter voice');
    expect(next).not.toContain('A warm, playful voice');
  });
  it('lets the human clear the personal voice', () => {
    writePersonality('  \n');
    expect(withWakePersonality(root, 'shared direction')).toBe('shared direction');
  });
  it('does not load a personal prompt redirected outside the workspace', () => {
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'PERSONALITY.md'), 'outside content');
    fs.symlinkSync(outside, path.join(workspace, 'artifacts'), 'junction');
    expect(() => withWakePersonality(workspace, 'shared direction')).toThrow('inside the Wake workspace');
  });
});
