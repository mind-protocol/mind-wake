import { readWakeHistory, readWakeLocations } from '../../communication/wake-history.js';
import type { DataDir } from '../paths.js';
import { EXIT_OK } from '../output.js';
export function wakeHistory(dataDir: DataDir) {
  const data={...readWakeHistory(dataDir.path),locations:readWakeLocations(dataDir.path)};
  return {exitCode:EXIT_OK,data,human:()=>JSON.stringify(data,null,2)};
}
