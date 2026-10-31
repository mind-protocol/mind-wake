// Synthetic test guard, also inherited by child Node processes through NODE_OPTIONS.
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const deny = () => {
  throw new Error("network_forbidden_by_test_mandate");
};
net.Server.prototype.listen = deny;
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
