# durable-p1 (spike, wayfinder ticket 006 route B)

**Throwaway prototype.** The stable interactive-mode TUI
(`packages/coding-agent/src/modes/interactive/`) running unmodified on the
durable backend (`@earendil-works/pi-durable` Harness + root Conversation),
through an `AgentSession` facade. Answers: how much glue does route B take, and
where does it hurt?

## Run

```bash
cd /Users/fliu56/github/pi-durable-coding-agent
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable-p1/main.ts
```

- One turn end-to-end: input streams into the transcript, tool calls
  (read/bash/edit/write) render, the final answer renders; Esc aborts.
- Model: pi's default from `~/.pi/agent` settings. Credentials are shared with
  pi; there is no login flow. Do not run `/login`.
- Sessions live under `~/.pi/agent/experimental/durable-p1-sessions/`
  (isolated, prototype-marked; each boot starts a fresh session; `--continue`
  attaches the newest durable session but the transcript renders empty).
- Exit: `/exit` or the usual TUI quit keys.

## How it works

| file | role |
| --- | --- |
| `main.ts` | entry: theme init, `AgentSessionRuntime`, `InteractiveMode` |
| `durable-agent-session.ts` | the facade: a real `AgentSession` (in-memory SessionManager, real services, engine never runs) wrapped in a Proxy; prompt/steer/followUp/abort/compact/model mutation reroute to the durable root Conversation; durable `watchEvents` batches feed the parent's private `_handleAgentEvent` so persistence-to-memory, extension dispatch, and the `AgentSessionEvent` fan-out run the production path |
| `event-adapter.ts` | durable `AgentEvent` (spec §9.4) → pi-agent-core `AgentEvent`: folds message deltas into a partial assistant message, tracks tool output buffers, rebuilds `turn_end`/`agent_end` payloads |
| `session-location.ts` | session directory + `proper-lockfile` lock under `durable-p1-sessions` |

## Not wired (throws or silently degrades)

`/new`, `/resume`, `/fork`, import (the runtime factory throws); images;
`/login`; transcript re-render on `--continue`; compaction chat re-render
(status events map, the summary line does not); session name/info panels read
the in-memory mirror, not the durable store.
