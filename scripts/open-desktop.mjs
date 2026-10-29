/** Reopen the installed panel with its local profile and credentials. */
import path from 'node:path';
import {parseArgs} from 'node:util';
import {startLocal} from './start-local.mjs';
const {values}=parseArgs({options:{'data-dir':{type:'string'}}});
const dataDir=path.resolve(values['data-dir'] || process.env.MIND_WAKE_DATA_DIR || path.join(process.env.LOCALAPPDATA || '', 'mind-wake'));
await startLocal(path.join(dataDir,'installation/manifest.json'),'desktop');
