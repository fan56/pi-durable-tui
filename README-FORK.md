# pi-durable-tui — experimental early-access coding agent

> **The official durable coding agent is in development.** This is an
> **experimental preview** that lets you try the durable runtime today, with the
> look and feel of the stable `pi` interactive UI. It is not the official
> product, it is not feature-complete, and it will change.

`pi-durable-tui` runs the **stable `pi` TUI, unmodified**, on top of the
**durable backend** ([`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)
Harness + SQLite root conversation) through a production `AgentSession` facade.

What that means in practice: you get the same editor, footer, commands, and
extensions you already know — but conversations live in a durable store that
survives crashes, interrupted tool calls, and process kills.

## Why this exists

The upstream `pi` ships a durable runtime, but the interactive TUI still runs on
the stable session backend. This fork wires the two together so the durable
engine can be exercised through a real, daily-driver interface — the fastest way
to find out what a durable coding agent should feel like.

It is a **fork layer**: it adds new files and a small number of narrowly-scoped
hooks, and otherwise tracks upstream `earendil-works/pi` untouched. That
constraint is deliberate — it keeps upstream merges clean and makes it obvious
what is experimental.

## Install

Requirements: **Node ≥ 24** on **macOS or Linux**.

> Node is required because the durable conversation store is backed by Node's
> built-in `node:sqlite`. [Bun does not implement that module](https://bun.sh/docs/runtime/sqlite),
> which is also why this project ships a bundle rather than a single-file binary.

Download the archive for your platform from [Releases](../../releases), then:

```bash
tar -xzf pi-durable-tui-<version>-<platform>.tar.gz
cd pi-durable-tui
npm install --omit=dev
./pi-durable-tui
```

That is the whole install: unpack, install three runtime packages, run.

## Use

```bash
./pi-durable-tui                     # new session (clean base on first boot)
./pi-durable-tui -c                  # continue the newest session for this cwd
./pi-durable-tui --list              # list sessions recorded for this cwd
./pi-durable-tui --session <id>      # attach a specific session
./pi-durable-tui -e <path>           # load one extra extension (repeatable)
./pi-durable-tui --with-extensions   # load every extension from global settings
./pi-durable-tui --provider P --model M
./pi-durable-tui --help
```

Roughly the same flags as `pi`, minus its print/JSON/RPC modes and its `/login`.

### In the TUI

| Command | What it does |
| --- | --- |
| `/extensions` | Pick which of your globally configured extensions load at startup. Newly checked ones apply immediately; unchecked ones take effect next boot. |
| `/sessions` | Switch to another durable session for this cwd, newest first. |
| `/new` | Start a fresh durable session. |
| `/model` | Switch model (takes effect on the next request). |
| `/compact` | Manually compact the conversation. |

### Credentials and state

- Credentials are **shared with stable `pi`** (`~/.pi/agent/auth.json`; a stored
  credential wins over the environment variable).
- Sessions live under
  `~/.pi/agent/experimental/durable-tui-sessions/<cwd-hash>/`, one directory per
  session (`session.sqlite` + a `session.json` sidecar).
- Startup extension selection is stored at
  `~/.pi/agent/durable-tui-extensions.json` (override with
  `PI_DURABLE_EXT_CONFIG`).
- Nothing else under `~/.pi/agent` is touched.

If no model is configured in your `settings.json` and you pass no `--model`, the
launcher falls back to `deepseek/deepseek-flash`.

## What works

Verified against a real model:

- Core loop: streaming, tool calls, abort.
- **Kill and resume.** Kill the process mid-run and restart with `-c`: the
  transcript rebuilds, interrupted unsafe tools report `interrupted`, and
  generation continues.
- **Session management**: `/new`, the `/sessions` picker, `--session` attach,
  `--list`.
- **Startup extension selection** via `/extensions`, persisted across boots.
- **Stable MCP reuse end-to-end.** A hand-written stdio MCP server via
  `.pi/mcp.json` (`"exposure": "direct"`) is reachable by the model as
  `mcp__<server>__<tool>`, with `/mcp` for status.
- **Your existing extensions**, including UI-heavy ones such as
  `@aiwayds/pi-powerline-footer`.
- Steering mid-run, `/compact`, `/model` switching.

## What is not wired

By design, per the current phasing:

- `/fork` and `/tree` — durable forks are new conversations in another store;
  the cross-store mapping needs its own design.
- `/resume` over stable JSONL sessions (refused with a clear error — use
  `/sessions`).
- Images, `/login`, prompt templates, and `/skill:name` expansion.
- Extension `tool_result` events (stable emits those from the real tool pipeline
  only; harmless for pure-UI extensions).
- `tool_call` argument mutation by extension handlers (block/wait is bridged;
  in-place `input` mutation is not).
- MCP exposure modes other than `direct`.
- Extension `before_agent_start` injection — engine-side prompts belong to the
  durable `pi-prompt` extension.

## Relationship to upstream

This repository is a fork of [`earendil-works/pi`](https://github.com/earendil-works/pi).
The upstream README, packages, and release process are unchanged and live
alongside this experiment:

- Upstream README: [`README.md`](README.md)
- The experimental feature set in detail:
  [`packages/coding-agent/src/experimental/durable-tui/README.md`](packages/coding-agent/src/experimental/durable-tui/README.md)
- Build reports and the decision map: [`docs/`](docs/), [`wayfinder/`](wayfinder/)

Nothing here is published to npm. Releases are GitHub Releases carrying the
self-contained archive described above.

## Building from source

```bash
npm ci --ignore-scripts
./scripts/build-durable-tui-release.sh          # → release/pi-durable-tui-<version>-<platform>.tar.gz
```

For development against the source tree (no bundle, no packaging):

```bash
node --import packages/coding-agent/src/experimental/source-resolver.ts \
  packages/coding-agent/src/experimental/durable-tui/main.ts
```

## License

MIT, as upstream. See [`LICENSE`](LICENSE).
