/** Bind an existing shared AGENT credential to one existing, authorised local profile. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { validateStateDir, validateEndpoint } from './setup-shared-messages.mjs';
import { openStoreReadOnly } from '../dist/store/index.js';
import { resolvePolicy } from '../dist/policy/index.js';
import { SharedInboxHttps } from '../dist/communication/shared-inbox-https.js';

function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768) throw Error('Invalid existing file');
  return fs.readFileSync(file, 'utf8');
}
function outsideGit(dir) {
  for (let p = dir;; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, '.git'))) throw Error('Private state must remain outside Git');
    if (path.dirname(p) === p) break;
  }
}
export async function configure({dataDir, stateDir, profileId, agentRef, mode}) {
  if (!['check', 'dry-run', 'enable'].includes(mode) || !profileId || !/^agent-[a-z2-9]{10}$/.test(agentRef)) throw Error('Explicit agent/profile/mode required');
  if (!path.isAbsolute(dataDir) || !path.isAbsolute(stateDir)) throw Error('Absolute paths required');
  dataDir = fs.realpathSync(dataDir);
  stateDir = validateStateDir(fs.realpathSync(stateDir));
  outsideGit(dataDir); outsideGit(stateDir);
  if (fs.existsSync(path.join(dataDir, 'AGENTS.md')) || fs.existsSync(path.join(dataDir, 'artifacts'))) throw Error('Use profile data directory, not workspace');
  if (read(path.join(stateDir, '.mind-shared-messages')) !== 'mind.shared/local-state.v1\n') throw Error('Existing setup marker required');
  const endpoint = validateEndpoint(JSON.parse(read(path.join(stateDir, 'endpoint.json'))).endpoint);
  const keyFile = path.join(stateDir, 'agent.key');
  const key = read(keyFile);
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw Error('Existing agent key required');
  // No creation or migration of the actual control database; never change Pause or consent.
  const dbFile = path.join(dataDir, 'control.sqlite');
  const dbStat = fs.lstatSync(dbFile);
  if (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.nlink !== 1) throw Error('Existing control database required');
  function eligible() {
    const store = openStoreReadOnly(dbFile);
    try {
      const profile = store.uow.profiles.get(profileId);
      const policy = resolvePolicy(store.uow.policies, profileId);
      if (!profile || profile.emergencyStopLocked || fs.existsSync(path.join(dataDir,'emergency-stop.flag')) || ['disabled','stopped'].includes(profile.state) ||
          policy.status !== 'active' || policy.revision.groups.runtime.hostUnsandboxedAcknowledged !== true ||
          !['claude','codex'].includes(policy.revision.groups.runtime.adapterId))
        throw Error('Existing host profile/consent required');
      return profile.state;
    } finally { store.close(); }
  }
  eligible();
  const identity = await new SharedInboxHttps(endpoint, key).call({op:'whoami'});
  if (identity?.kind !== 'agent' || identity.ref !== agentRef) throw Error('Exact shared agent identity required');
  const profileState = eligible(); // re-read control after network; never enable a force-off profile
  const binding = {enabled:true, profileId, endpoint, agentRef, keyFile};
  const target = path.join(dataDir, 'shared-inbox.json');
  if (fs.existsSync(target)) {
    const existing = JSON.parse(read(target));
    for (const key of ['profileId','endpoint','agentRef','keyFile'])
      if (existing[key] !== binding[key]) throw Error('Existing binding differs; review it explicitly first');
  }
  if (mode === 'check') {
    if (!fs.existsSync(target) || JSON.parse(read(target)).enabled !== true) throw Error('Binding not enabled');
  } else if (mode === 'enable') {
    const temporary = path.join(dataDir, `.shared-inbox-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(binding,null,2)+'\n', {flag:'wx',mode:0o600});
      fs.renameSync(temporary,target);
    } finally { if(fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return {mode, profileId, agentRef, endpoint, profileState, enabled: mode === 'enable' || mode === 'check',
    note:'No wake, restart, key creation or remote configuration. Pause remains effective; receiver starts only inside an authorised native session.'};
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const {values:v} = parseArgs({options:{'data-dir':{type:'string'},'state-dir':{type:'string'},profile:{type:'string'},'agent-ref':{type:'string'},check:{type:'boolean'},'dry-run':{type:'boolean'},enable:{type:'boolean'}}});
    const modes = ['check','dry-run','enable'].filter(k=>v[k]);
    if(modes.length !== 1) throw Error('One mode required');
    console.log(JSON.stringify(await configure({dataDir:v['data-dir'],stateDir:v['state-dir'],profileId:v.profile,agentRef:v['agent-ref'],mode:modes[0]}),null,2));
  } catch {
    console.error('Shared inbox configuration refused. Verify existing private setup files, exact agent identity, local data/profile and active host consent. Build this clone first. No secret displayed.');
    process.exitCode=1;
  }
}
