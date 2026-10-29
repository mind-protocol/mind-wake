import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeRunArgs, claudeUsageArgs } from './claude/command.js';
import { buildAppServerCommand } from './codex/command.js';
import { validateDraft } from '../policy/validate.js';
import { classifyChange } from '../policy/change.js';
import { PROFILE, validDraft, withFields } from '../../test/support/policy-fixtures.js';

const base = {model:'opus',systemPromptFile:'prompt.md',tools:['Bash','Read'],permission:'skip_permissions_unsandboxed',session:{mode:'new',id:'native-test'}} as const;
describe('native CLI capabilities', () => {
  it('loads all Claude native tools and merges normal settings and MCP servers', () => {
    const args=claudeRunArgs({...base,nativeCapabilities:true,mcpConfigFile:'mind.json'});
    expect(args[args.indexOf('--tools')+1]).toBe('default');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--settings');
    expect(args).toContain('mind.json');
  });
  it('keeps an explicitly restricted runtime and quota probes separate', () => {
    const args=claudeRunArgs(base);
    expect(args[args.indexOf('--tools')+1]).toBe('Bash,Read');
    expect(args).toContain('--strict-mcp-config');
    const quota=claudeUsageArgs();
    expect(quota[quota.indexOf('--tools')+1]).toBe('');
    expect(quota).toContain('--strict-mcp-config');
  });
  it('lets native Codex retain its user configuration without Wake forcing shell inheritance off', () => {
    const command=buildAppServerCommand({executable:{path:process.execPath},codexHome:path.join(os.homedir(),'.codex'),workspaceDir:path.resolve('.'),channel:null,nativeCapabilities:true,allowUserCodexHome:true});
    expect(command.args).not.toContain('shell_environment_policy.inherit="none"');
    expect(command.args).not.toContain('request_max_retries=1');
    expect(command.env["CODEX_HOME"]).toBe(path.join(os.homedir(),'.codex'));
  });
  it('requires explicit host authorization and classifies native capabilities as expanded access', () => {
    expect(validateDraft(withFields(validDraft(),{'runtime.nativeCapabilities':true}),PROFILE).ok).toBe(false);
    const before=validateDraft(withFields(validDraft(),{'runtime.hostUnsandboxedAcknowledged':true}),PROFILE);
    const after=validateDraft(withFields(validDraft(),{'runtime.hostUnsandboxedAcknowledged':true,'runtime.nativeCapabilities':true}),PROFILE);
    expect(after.ok).toBe(true);
    if(before.ok && after.ok)expect(classifyChange(before.groups,after.groups).widened).toContain('runtime.nativeCapabilities');
  });
});
