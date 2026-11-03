import fs from 'node:fs';
import {openStore} from '../../dist/store/index.js';
import {controlDbPath} from '../../dist/daemon/paths.js';
import {transitionProfile} from '../../dist/scheduler/lifecycle.js';
import {resolvePolicy} from '../../dist/policy/index.js';
import {StopFlag} from '../../dist/runner/controls.js';
const dir=process.argv[2];
const store=openStore(controlDbPath(dir));
try {
 store.uow.transaction(tx=>{
  const p=tx.profiles.get('default');
  if(p?.state!=='blocked'||p.emergencyStopLocked||new StopFlag(dir).exists()||fs.existsSync(dir+'/emergency-stop.flag'))throw Error('Human controls prohibit recovery');
  if(tx.sessions.listOpen('default').length)throw Error('An active session remains');
  if(resolvePolicy(tx.policies,'default').status!=='active')throw Error('Policy inactive');
  const events=tx.journal.list('default');
  const orphan=events.find(e=>e.type==='orphan_reconciled'&&e.sessionId==='cf7df04c-8ed3-4eaa-9526-3438c24c9418');
  if(!orphan)throw Error('Expected reload interruption absent');
  const states=events.filter(e=>e.type==='profile_state_changed');
  if(states.at(-1)?.sessionId!=='cf7df04c-8ed3-4eaa-9526-3438c24c9418')throw Error('Profile changed since reload');
  transitionProfile(tx,{profileId:'default',from:'blocked',to:'ready',at:new Date().toISOString(),reason:'Reprise après interruption technique du rechargement des forks ; réservation incertaine conservée, contrôles et policy inchangés.'});
 });
 console.log('Recovered reload interruption; retained uncertain usage reservation.');
}finally{store.close();}
