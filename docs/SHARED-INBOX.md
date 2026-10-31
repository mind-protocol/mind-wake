# Shared inbox inside a Wake session (opt-in)

The shared MCP tools are explicit calls. Reading a single thread does not read the
other correspondents' messages. This receiver imports the bound agent's complete
inbox, across all threads, into Wake's existing durable delivery queue.

The UI sender to the hub already works. This adds local automatic reception into
the active session's hook/steering channel; it does not change the sending route.

Nothing is enabled by installation. After local review, place `shared-inbox.json`
in the chosen profile's **data directory**, alongside its control database, outside
the agent workspace:

```json
{
  "enabled": true,
  "profileId": "EXACT_LOCAL_PROFILE_ID",
  "endpoint": "https://EXISTING_HUB_HOST/v1/messages",
  "agentRef": "agent-EXISTINGREF",
  "keyFile": "C:/absolute/path/to/existing-agent-key"
}
```

Replace the placeholders with the existing binding. The key file contains only the
existing agent key; it is not a human's recipient-route key. No new key, permission,
policy or remote installation is created. The receiver checks `whoami` for both the
exact reference and `kind=agent` before reading or importing messages. It only runs
for the matching, host-native profile, inside an already authorised Wake session.
Invalid bindings fail closed for reception; the ordinary Wake continues.

On session launch it reads one page, then at most one page per five seconds while
the session is alive. No thread filter is sent. There is no idle listener, background
job or wake request. Messages sent while Wake is idle wait for the next normally
authorised session. Changing this behaviour would require a separate decision.

Pause, Force-off, StopFlag, inactive policy and session end stop collection; in-flight
requests are cancelled. The guard is checked before network access and before local
writes. Late results after a stop are discarded and fetched again next time.

`shared-inbox.sqlite` stores a global-inbox cursor per endpoint and agent reference. Thread-specific tool
cursors are never read or adopted. Key rotation
for the same identity does not reset that cursor. Each message is queued with a
stable ID before the cursor advances. Replaying after a crash is idempotent; delivery
claims and receipts remain managed by the existing Codex steering / Claude hooks.
Imports cannot request a new wake even if delivery is deferred past session end.

Incoming content always carries `origin.kind=peer_message`, its authenticated sender
reference, recipient and thread/message IDs. It never acquires authority as a local
human instruction. Self messages and messages to another identity are skipped.
Import, transport acceptance and a model's explicit confirmation remain distinct.

To disable at the next launch set `enabled` to `false`, or remove the binding file.
Use Pause / Force-off to stop the current session immediately. This feature does not
modify the MCP native configuration or automate replies.

## Operator setup from existing shared-message state

Build this clone first (`node node_modules/typescript/bin/tsc -p tsconfig.build.json`).
Use the **existing** dedicated directory created by `setup-shared-messages.mjs`,
containing its marker, `endpoint.json` and `agent.key`. Do not supply a key in the
command line. The helper reads those files, opens the real control database read
only, checks host consent and the selected Claude/Codex profile, then verifies the
exact shared agent with a TLS-verified `whoami`. It never creates credentials.

```powershell
node scripts/setup-shared-inbox.mjs --data-dir "ABSOLUTE_EXISTING_PROFILE_DATA_DIR" --state-dir "ABSOLUTE_EXISTING_SHARED_STATE_DIR" --profile "EXACT_LOCAL_PROFILE_ID" --agent-ref "EXACT_SHARED_AGENT_REF" --dry-run
# After reviewing that result, repeat the same arguments with --enable.
# --check verifies an already enabled, matching configuration without writing.
```

Only `--enable` writes `shared-inbox.json`; conflicting bindings are refused.
All paths must resolve outside Git. The setup marker, endpoint and key must be
existing regular files. Paused profiles can be configured without changing their
state; locked, stopped or disabled profiles are refused. No restart or wake is
performed. Existing active sessions do not reload the binding: the next normally
authorised host-native session adopts it. Configure each computer locally after
review; one machine's credentials or paths must never be copied to the other.
The helper refuses missing or incompatible control databases instead of creating
or migrating them. Its errors never print supplied arguments or credentials.

Stop checks and writes are not a cross-process transaction: a synchronous queue
write already in progress can finish at the same time another process pauses the
profile. The session watchdog observes loss of authority within 250 ms and aborts
the current request; already accepted provider RPC cannot be recalled. No later
enqueue or cursor commit occurs once that loss is observed. Replay remains safe.
