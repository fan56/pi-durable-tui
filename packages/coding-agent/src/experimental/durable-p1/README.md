# durable-p1 (v0.2)

The stable interactive-mode TUI (`packages/coding-agent/src/modes/interactive/`,
unmodified) running on the durable backend (`@earendil-works/pi-durable`
Harness + SQLite root Conversation) through a production AgentSession facade.
Wayfinder tickets 006 (route B) and 009 (host-surface API); decision map in
`wayfinder/MAP.md` at the repo root. Local launcher: `pi-durable`.

## Run

```bash
cd <any working directory>
node --import <repo>/packages/coding-agent/src/experimental/source-resolver.ts \
  <repo>/packages/coding-agent/src/experimental/durable-p1/main.ts [flags]
```

Flags: `--continue|-c` (attach newest session for cwd) · `--provider P
--model M` · `--no-extensions|-ne` · `-e PATH` (extra extension, repeatable) ·
`--list` (print recorded sessions) · `-h`. The local launcher runs this with a
clean base plus stable's built-in MCP extension by default.

Credentials are shared with stable pi (`~/.pi/agent/auth.json`, stored wins
over env). Sessions live under
`~/.pi/agent/experimental/durable-p1-sessions/<cwd-hash>/`, one directory per
session (`session.sqlite` + `session.json` sidecar), `proper-lockfile` locked.
`~/.pi/agent` otherwise stays untouched.

## Layout

| file | role |
| --- | --- |
| `main.ts` | entry: arg parsing, theme init, `AgentSessionRuntime`, `InteractiveMode` |
| `durable-agent-session.ts` | the facade: real `AgentSession` (in-memory SessionManager, engine never runs) + durable reroutes; closes the six host-surface gaps (ticket 009 resolution 6) |
| `headless-session.ts` | the externally-driven headless session contract: the single typed place reaching AgentSession private seams (ticket 009 resolution 7) |
| `event-adapter.ts` | durable `AgentEvent` → pi-agent-core `AgentEvent`; folds streamed deltas, buffers tool output, normalizes string user content, drops positional system messages |
| `tool-bridge.ts` | v0.2: mirrors ACTIVE stable extension tools into the durable registry (same-name reinstall) and forwards durable tool calls as stable `tool_call` events — this is what makes stable's built-in MCP integration run unmodified |
| `transcript-rebuild.ts` | durable active entries → `SessionManager` entry chain, so `--continue` renders history |
| `session-location.ts` | session directories + locks under the isolated p1 root |
| `session-meta.ts` | `session.json` sidecars: identity, `/name` persistence, `--list` |

Tests: `packages/coding-agent/test/durable-p1-*.test.ts` (vitest).
Typecheck: `npx tsc -p tsconfig.p1check.json` from the repo root.

## Verified (2026-10-08, real model)

Core loop (streaming/tools/abort), `--continue` transcript rebuild,
`--list`, manual `/compact` (summary entry + tokensBefore + Already/Nothing
refusals), steering mid-run, `/model` switch (takes effect next request),
kill-and-resume (interrupted unsafe tools report `interrupted`, generation
continues), subagent tool (task-owned child conversation), and
**pi-powerline-footer fully green** as the v0.1 acceptance sample (footer
segments, cwd-border editor, last-request widget, thinking-level segment).

v0.2: **stable MCP reuse end-to-end** — hand-written stdio MCP server
(echo/add) via `.pi/mcp.json` (`"exposure": "direct"`), model calls
`mcp__echo-test__add(17,26)` → `43` through the bridge; `/mcp` management
panel (server status); footer and MCP co-exist; extension commands dispatch
from the facade prompt path.

## Not wired (by design, per the phasing)

`/new`, `/resume`, `/fork`, import (v0.4 session management); images;
`/login`; extension `tool_result` events (stable emits them from the real
tool pipeline only — harmless for pure-UI extensions); prompt templates and
`/skill:name` expansion; MCP exposure modes other than `direct` (codemode /
tool_search / deferred need the v0.2 tool-search/codemode story or bridge
work); `tool_call` argument mutation by handlers (block/wait is bridged,
in-place `event.input` mutation is not). Extension `before_agent_start`
injection does not run — engine-side prompts belong to the durable `pi-prompt`
extension.
