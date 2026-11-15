import { execFileSync } from 'node:child_process';

/** Repair only explicitly configured private reverse links; never remove other mappings. */
export function ensureAndroidUsbLinks({ adb, serial, ports }, run = execFileSync) {
  if (typeof adb !== 'string' || !adb || typeof serial !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(serial)
    || !Array.isArray(ports) || !ports.length || ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535))
    throw Error('invalid_usb_link_configuration');
  const call = args => run(adb, ['-s', serial, ...args], { timeout: 4000, maxBuffer: 65536, windowsHide: true }).toString();
  try { if (call(['get-state']).trim() !== 'device') return { status: 'waiting_phone', repaired: [] }; }
  catch (error) {
    if (/offline|not found|no devices/i.test(String(error.stderr ?? ''))) return { status: 'waiting_phone', repaired: [] };
    throw error;
  }
  const parse = text => text.split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/));
  const wanted = [...new Set(ports)].map(port => `tcp:${port}`);
  const existing = parse(call(['reverse', '--list']));
  // Do not overwrite a forward deliberately aimed at a different local service.
  for (const endpoint of wanted) {
    if (existing.some(row => row[1] === endpoint && row[2] !== endpoint)) throw Error(`usb_link_conflict:${endpoint}`);
  }
  const repaired = [];
  for (const endpoint of wanted) {
    if (!existing.some(row => row[1] === endpoint && row[2] === endpoint)) {
      call(['reverse', endpoint, endpoint]); repaired.push(Number(endpoint.slice(4)));
    }
  }
  const confirmed = parse(call(['reverse', '--list']));
  if (wanted.some(endpoint => !confirmed.some(row => row[1] === endpoint && row[2] === endpoint)))
    throw Error('usb_link_not_confirmed');
  return { status: 'connected', repaired };
}
