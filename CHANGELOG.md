# Changelog

All notable changes to the `pi-durable-tui` early-access builds.

This is a fork layer on top of [`earendil-works/pi`](https://github.com/earendil-works/pi).
Upstream releases are tracked in that repository's changelog, which ships inside
each release archive as `UPSTREAM-CHANGELOG.md`.

## [0.12.1] — 2026-11-11

### Fixed

- **`/import` no longer crashes when the current session is in-memory**
  (`--no-session`, or a durable session that has never been written to disk).
  The import used to fall back to an empty session directory (`mkdir ''` →
  ENOENT); it now resolves the cwd's default session store — the same
  directory `SessionManager.create` uses, honoring `PI_CODING_AGENT_DIR` — and
  the imported session lands there.
- **The think display is single even with `hideThinkingBlock: false`.** The
  activity panel used to keep rendering its 🧠 band next to the transcript's
  native expanded thinking block. During thinking phases (and the
  thinking→tool bridge) the panel now yields the whole viewport so the native
  block is the only thinking display; tool phases keep the panel, and the
  setting is re-read on entry into each thinking phase, so a live toggle takes
  effect on the next phase.
- **The activity panel reads the host's effective settings instead of its own
  settings-file pass.** Building a private `SettingsManager` defaulted
  `projectTrusted` to true and could diverge from the host's real project-trust
  decision — on an untrusted project with a project-level
  `hideThinkingBlock: true`, the double display above could resurface. The
  panel now reads `pi.getSettings()`, the same merged view the host runs on.
  A committed regression test covers the yield path (yield vs panel-owned vs
  per-phase refresh timing).

### Changed

- Dropped the daily `schedule:` trigger from the `durable-tui-ci` workflow; it
  runs on push, pull request, and manual dispatch only.

## [0.12.0] — 2026-11-11

### Changed

- **Synced the upstream base to pi v1.5.2** (coding-agent 1.5.2, durable 1.5.2,
  ai 1.5.2). The upstream change that reaches this fork most directly: a session
  whose original folder no longer exists now offers `Continue`, `Fork`, or
  `Cancel` instead of only continuing. `Continue` runs the session in the current
  directory without storing the choice; `Fork` is refused here (see Fixed) and
  leaves the current session untouched.
- **The coding-agent package now declares its chord dependencies at the v2
  subpaths** (`@earendil-works/chord/context`, `@earendil-works/chord/json`), and
  `@earendil-works/pi-durable` and `@earendil-works/chord` are pinned exactly at
  `1.5.2`. The generated install-lock is regenerated to match.
- **The release archive no longer pins the dead `@earendil-works/chord@1.1.0`
  entry.** It was unreachable from the bundle but could make a mirror-default
  install fail; the archive manifest now lists only the three public runtime
  dependencies.

### Fixed

- **The thinking panel no longer shows twice.** While the activity panel is
  enabled it is the only thinking view: the transcript's collapsed one-line
  "Thinking..." placeholder is suppressed, so a run shows the panel's rows and
  nothing else, and no placeholder is left in history after the turn settles.
  `/activity off` and session shutdown restore the stock placeholder. With
  `hideThinkingBlock` off, the transcript's expanded thinking block is unaffected.
- **Forks and cross-store session switches are refused before the live session
  is torn down.** Upstream tears the current session down first and lets the
  runtime factory refuse afterwards, which killed the process for `/fork` and
  left the TUI bound to a dead session for extension switches. The new guard
  cancels at `session_before_fork` / `session_before_switch` and reports
  "fork is not supported yet (planned) — staying in the current session"; picking
  `Fork` in the missing-folder prompt behaves the same way and keeps the open
  session usable.

## [0.11.0] — 2026-11-03

### Changed

- **Synced the upstream base to pi v1.5.0** (coding-agent 1.5.0, durable 1.5.0,
  ai 1.5.0). Highlights from upstream: tool argument validation moved from
  TypeBox to `pi-schema`, so plain JSON Schema tools (including MCP tools) now
  get the same coercion TypeBox tools had, while TypeBox-only features
  (`Type.Refine()`, `Type.BigInt()`, codecs, custom formats) no longer apply
  to tool arguments and validation failures list pi-schema's messages;
  GPT-6.1 Terra is available through OpenAI, Azure OpenAI Responses, and
  Codex; the built-in model catalog moved to the models.dev v2 pipeline, so
  realtime and image-only models are no longer offered as chat models;
  extension packages can show their changelog on the next fresh launch after
  an update, condensed by the `collapseChangelog` setting; streaming renders
  faster — large tool calls are parsed incrementally and code-heavy answers
  and tool rows reuse highlighting and rendered Markdown; `pi.exec()` gained
  a `maxBuffer` option and a `truncated` result field; and `undici` was
  updated to 8.12.3 for security advisories.
- **The durable-tui event adapter was rebuilt on conversation-view snapshot
  diffing.** Upstream durable 1.5.0 removed the event stream layer
  (`watchEvents` and its AgentEvent types, spec §9.4): renderers watch state
  via `Conversation.watch()`. The pi-agent-core AgentEvents the stable
  session pipeline consumes are now re-derived by diffing successive
  ConversationView snapshots — transcript entry appends become
  message_start/message_end, `pi.live.generation.message` becomes the
  streamed message_start/message_update partials, `pi.live.tools` slots
  become tool_execution_start/update/end, and runs frame as
  agent_start/agent_end. A recovered run is adopted into the first snapshot
  so abort/settle keep working, and it reports `agent_start` immediately.
- **Turn boundaries are now inferred.** Upstream emits no explicit turn
  events, so the adapter closes a turn at assistant/user transcript
  boundaries instead of a dedicated turn marker.
- **Entries persisted while the agent is idle no longer emit `message_end`
  to the TUI event surface.** Persistence is unaffected — only what live
  event listeners see changes.

### Fixed

- **Zhipu/Z.ai usage-limit errors (code `1308`) are no longer retried
  automatically.** They were treated as transient HTTP 429 errors, causing
  retries that cannot succeed until the usage cap resets.
- **`tool_search` (and codemode `searchTools()`) now matches Chinese,
  Japanese, Thai, and other non-ASCII queries.** The tokenizer kept only
  ASCII letters and digits, so such queries found nothing; words in any
  script now match, and space-less text such as `搜索记录` is split into
  words.
- **Sonnet 5.5 keeps Anthropic's official 0.2 cache-read price** in the
  models.dev v2 catalog pipeline, where models.dev lists 0.1 — the fork's
  earlier price override is ported into the catalog's Anthropic provider map
  step.
- The subagent extension's tool parameter schema imports `Type` from
  `typebox` directly, since pi-ai 1.5.0 no longer re-exports TypeBox; a
  TypeBox schema is plain JSON Schema, which durable 1.5's `defineTool`
  takes.

## [0.10.0] — 2026-10-30

### Changed

- **Synced the upstream base to pi v1.4.0** (coding-agent 1.4.0, durable 1.4.0,
  ai 1.4.0). The fork's own catalog-drift fixes are retired in favor of the
  upstream ones: Xiaomi providers now default to `mimo-v2.6-pro` and
  `github-copilot` defaults to `gpt-6.1-sol` (upstream's pick after gpt-5.4
  left the catalog; the fork's interim `gpt-5.6-luna` default is gone).
  Model-catalog fixtures follow the upstream 1.4.0 catalog.
- **Upstream durable 1.4.0 migrates the SQLite conversation store to schema
  version 2 on first open.** The migration is automatic and one-way: after a
  session store has been opened by this release, pi-durable-tui 0.9.x and
  earlier cannot open it. The fork's session directory locks are file locks
  and are unaffected.

### Fixed

- **The release archive boots again: `activity-panel.js` was missing from
  `bundle/`.** The durable-tui entry loads the panel as a jiti extension
  resolved next to itself; the bundle script only emitted the other two
  siblings (sessions-extension, extensions-manager), so every released
  archive since 0.7.0 crashed at startup with "cannot locate the bundled
  extension ./activity-panel.{ts,js}" (source runs were unaffected — the
  `.ts` sibling probe hit first). The bundle script now emits all three, and
  a comment ties its list to the `resolveSiblingExtension()` calls in
  durable-tui/main.ts.
- The tui package's CJK punctuation now renders bold/italic correctly
  (upstream added `marked-cjk-friendly`, #3353).

### Changed (from the accumulated [Unreleased])

- **The repo root README is now the project's own.** The fork's readme moved
  from `README-FORK.md` to `README.md` (upstream pi's README is preserved
  verbatim at `README-UPSTREAM.md`), `README-FORK.md` is removed, and the
  release bundle ships the new root README. The flag table now matches the
  shipped launcher — `--with-extensions` never parsed (it exits with
  "unknown argument"); the clean-base switch is `--no-extensions`, which
  applies the saved `/extensions` selection — and the stale
  `deepseek/deepseek-flash` fallback note is gone.

## [0.7.1] — 2026-10-13

### Fixed

- **Release archive shipped no runtime assets.** The archive copied only
  `dist/bundle`, but the bundled-node layout resolves builtin themes under
  `<install>/dist/modes/interactive/theme/` (`getThemesDir`), so opening the
  settings/theme selector crashed with ENOENT on `dark.json`. The build now
  also ships the theme JSONs, the bundled interactive asset, the HTML export
  templates (used by `/export`), and the docs/examples referenced from the
  system prompt — copied from `src/` so `--skip-build` builds work too.
- **Codemode wasm missing from the archive.** `getQuickJSWasmPath` resolves
  `quickjs-wasi/quickjs.wasm` from `node_modules` at runtime, but the archive's
  pinned dependencies did not include the package, so the first codemode call
  would fail resolution. `quickjs-wasi` is now pinned in the archive's
  `package.json`.

## [0.7.0] — 2026-10-09

> First packaged early-access build. The version is the fork's own line, not
> upstream pi's 1.x, and starts at 0.7.0 because upstream already uses the
> 0.6.x tags for unrelated 2025 releases — reusing v0.6.0 would make
> `git tag` ambiguous between the two histories.

### Added

- **Self-contained release archive.** `pi-durable-tui-<version>-<platform>.tar.gz`
  ships the esbuild bundle plus the three runtime packages the bundle keeps
  external, so a download unpacks, runs `npm install --omit=dev`, and starts.
  Selection of this shape (rather than a Bun single-file binary) is documented
  in `scripts/build-durable-tui-release.sh`.
- **`/extensions` startup selection.** First boot loads none of the global
  settings packages; the picker toggles them, persists the choice to
  `~/.pi/agent/durable-tui-extensions.json`, and appends newly checked paths to
  the live resource loader so additions apply without a restart.
- **`/sessions` picker and `/new`.** Session management on the durable store:
  newest-first listing with titles from the first prompt, the current session
  excluded, switch pre-validating the target's lock, and `--session <id>` direct
  attach.
- **Crash-proof session locks and directory-rename completion.** Interrupted
  unsafe tools report `interrupted` and generation continues on resume.

### Fixed

- **Sibling extension resolution under bundling.** The entry located
  `sessions-extension` / `extensions-manager` with `new URL("./x.ts",
  import.meta.url)`, which breaks once the entry is bundled to
  `durable-tui-runtime.js`. It now probes the `.ts` sibling first (source runs)
  and falls back to the emitted `.js` sibling (the release archive).

### Known limitations

See the "Not wired (by design, per the phasing)" section of the package README.
In short: `/fork` and `/tree` across stores, stable-JSONL `/resume`, images,
`/login`, prompt-template and `/skill:` expansion, and MCP exposure modes other
than `direct` are not implemented.

### Requirements

- **Node ≥ 24.** The durable conversation store is backed by `node:sqlite`,
  which Bun does not implement — this is why no standalone binary is published.
