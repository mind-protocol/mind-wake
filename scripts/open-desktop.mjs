/** Reopen the installed panel with its local profile and credentials. */
import path from 'node:path';
import {parseArgs} from 'node:util';
import {startSupervised} from './desktop-supervisor.mjs';
const {values}=parseArgs({options:{'data-dir':{type:'string'}}});
const dataDir=path.resolve(values['data-dir'] || process.env.MIND_WAKE_DATA_DIR || path.join(process.env.LOCALAPPDATA || '', 'mind-wake'));
await startSupervised(path.join(dataDir,'installation/manifest.json'));
