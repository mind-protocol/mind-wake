import { openCallRequests } from "../../../services/mcp/call-requests.mjs";

// Only this owner-side service creates sessions. MCP queues contain no owner token.
export function createAgentCalls({
  dataDir,
  call,
  controls,
  peers,
  phones,
  canCall = () => false,
  now = Date.now,
}) {
  const requests = openCallRequests(dataDir, { now });
  const managed = new Map();
  const end = (c) => {
    if (call.agentSessionOwned(c.id) || !call.active().some((a) => a.id === c.id)) {
      call.endSession(c.owner, c.id, 1);
      controls.markEnded({ id: c.id, epoch: 1 });
    }
    managed.delete(c.id);
  };
  function localTarget(address) {
    if (address === "principal") return call.resolve("mind");
    try {
      return call.resolve(address);
    } catch (error) {
      const target = call
        .targets()
        .find((t) => t.kind !== "remote" && call.identityKeys([t.handle]).includes(address));
      if (!target) throw error;
      return call.resolve(target.handle);
    }
  }
  async function targetOf(address) {
    if (address.startsWith("⬡")) return peers.resolveAddress(address);
    return localTarget(address);
  }
  function participants(target) {
    const all = call.targets();
    const listed = all.find((t) => t.handle === target.handle) ?? target;
    if (listed.kind === "remote" && listed.remoteKind === "room")
      return all.filter(
        (t) => t.kind === "remote" && t.peerId === listed.peerId && t.channel === listed.channel,
      );
    if (listed.kind === "room")
      return all.filter((t) => t.kind !== "remote" && t.room === listed.room);
    return [target];
  }
  let running = null;
  async function process() {
    for (const c of [...managed.values()]) {
      try {
        if (!call.agentSessionOwned(c.id)) {
          managed.delete(c.id);
          continue;
        }
        if (
          !canCall() ||
          now() >= c.until ||
          controls.control({ id: c.id, epoch: 1 })?.status !== "active"
        ) {
          end(c);
          continue;
        }
        call.stateSession(c.owner, c.id, 1);
        await call.syncRemote(c);
      } catch {
        end(c);
      }
    }
    for (let count = 0; count < 20; count++) {
      const r = requests.claim();
      if (!r) break;
      let result;
      try {
        if (!canCall()) throw Error("calls_unavailable");
        const caller = localTarget(r.caller);
        const addresses = [...new Set(Array.isArray(r.target) ? r.target : [r.target])];
        if (addresses.length === 1 && addresses[0].startsWith("@")) {
          if (r.call_id) throw Error("human_invite_requires_new_call");
          result = { ...phones.invite(addresses[0], caller.handle, r.label), status: "ringing" };
        } else {
          const resolved = await Promise.all(addresses.map(targetOf));
          const targets = [
            ...new Map(resolved.flatMap(participants).map((t) => [t.handle, t])).values(),
          ];
          const targetKey = targets
            .map((t) => t.handle)
            .sort()
            .join(",");
          if (r.call_id) {
            if (r.human !== false) throw Error("human_invite_requires_new_call");
            if (controls.control({ id: r.call_id, epoch: 1 })?.status !== "active")
              throw Error("call_ended");
            let state;
            for (const participant of targets)
              state = call.inviteSession(r.call_id, 1, participant.handle, {
                by: r.label,
                reason: r.reason,
              });
            controls.addParticipants({
              id: r.call_id,
              epoch: 1,
              participants: call.identityKeys(state.handles),
            });
            await call.syncInvited(r.call_id);
            result = { status: state.status, call_id: r.call_id, target: r.target };
          } else {
            const handles = [...new Set([caller.handle, ...targets.map((t) => t.handle)])];
            if (handles.length < 2 && r.human === false) throw Error("call_self");
            const existing = [...managed.values()].find(
              (c) => c.caller === caller.handle && c.target === targetKey,
            );
            if (existing) {
              result = { status: "active", call_id: existing.id, epoch: 1, target: r.target };
            } else {
              const scope = {
                id: r.request,
                epoch: 1,
                owner: `agent-call:${r.request}`,
                caller: caller.handle,
                target: targetKey,
                until: now() + 5 * 60_000,
              };
              controls.registerCall({
                id: scope.id,
                epoch: 1,
                participants: call.identityKeys(handles),
              });
              try {
                call.openSession(scope.owner, scope.id, 1, handles, {
                  caller: r.label,
                  skipRing: [caller.handle],
                });
                await call.syncRemote(scope);
                managed.set(scope.id, scope);
                const humans = [];
                if (r.human !== false) {
                  try {
                    humans.push({
                      colony: "local",
                      ...phones.invite(undefined, handles.join(","), r.label, {
                        inviteHumans: true,
                        callId: scope.id,
                      }),
                    });
                  } catch (error) {
                    humans.push({ colony: "local", status: "failed", error: error.message });
                  }
                  try {
                    humans.push(...(await peers.humanRequest(scope, { action: "invite" })).humans);
                  } catch (error) {
                    humans.push({ colony: "remote", status: "failed", error: error.message });
                  }
                }
                result = {
                  status: "active",
                  humans,
                  call_id: scope.id,
                  epoch: 1,
                  target: r.target,
                  expiresAt: new Date(scope.until).toISOString(),
                };
              } catch (error) {
                end(scope);
                throw error;
              }
            }
          }
        }
      } catch (error) {
        result = { status: "failed", error: String(error.code ?? error.message ?? error) };
      }
      requests.settle(r.request, result);
    }
  }
  const tick = () =>
    running ??
    (running = process().finally(() => {
      running = null;
    }));
  return {
    tick,
    async close() {
      if (running) await running;
      for (const c of [...managed.values()]) if (call.agentSessionOwned(c.id)) end(c);
      requests.close();
    },
  };
}

export function startAgentCalls(options) {
  const service = createAgentCalls(options);
  const timer = setInterval(() => {
    service.tick().catch((error) => console.error("Agent calls:", error.message));
  }, 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await service.close();
  };
}
