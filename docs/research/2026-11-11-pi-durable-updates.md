# pi-durable updates: 2026-11-03 → 2026-11-11

Date: 2026-11-11
Scope: read-only investigation. The only file written is this one. No code changed, nothing
committed, nothing published.
Method: `git` inspection of the local checkout, `gh api`/`gh release` queries against the fork and
the upstream monorepo, upstream changelogs read at each release tag, and a line-level diff of the
published npm tarballs (`@earendil-works/pi-durable` and `@earendil-works/chord`, versions 1.5.0,
1.5.1, 1.5.2) to establish the API surface instead of inferring it from prose.

Legend: **[released]** = shipped in an upstream release on or before 2026-11-11;
**[unreleased]** = on upstream `main` only; **unverified** = not confirmed by direct evidence.

Companion document (written earlier today, different scope): `research/2026-11-11-pi-durable-tui-inventory.md`
(identity, version pinning, coupling surface inventory). This document is the delta report.

---

## 0. Bottom line

1. **This repo has not moved since the baseline.** `origin/main` = `e079ecd66` = tag `v0.11.0`,
   working tree clean, zero commits since 2026-11-03, and the fork's `pushedAt` is
   `2026-11-03T05:47:17Z`. The latest fork release is still `pi-durable-tui 0.11.0 (experimental)`.
2. **Upstream shipped two patch releases since v1.5.0: v1.5.1 (2026-11-09) and v1.5.2 (2026-11-10).**
   v1.5.1 carries the bulk (373 commits v1.5.0→v1.5.1; 22 commits v1.5.1→v1.5.2). Its structural
   break is chord: **`@earendil-works/chord` moved Chord v2 to its root and deleted Chord v1**
   (`ed4f48840`); coding-agent lists two breaking changes for 1.5.1 (`GrepOperations.readFile` no
   longer called for context lines; `"tools": []` omitted when tools are off).
3. **The durable package itself changed little in released form.** 1.5.1 adds API (`Tx.submission`,
   per-conversation compaction settings, read-only JSONL open, faster SQLite commit); its only
   `.d.ts` signature change is `compactionPolicy` gaining a required third parameter. 1.5.2 has an
   empty durable changelog section. The conversation-view / live-state shapes the TUI adapter diffs
   are unchanged between 1.5.0 and 1.5.2 (verified by tarball diff).
4. **The next durable breaking wave is unreleased on `main`:** suspendable work (signals, tools
   that park, gates, hook tasks), commit `473515f9c`, with `pi.tool` → v4, `pi.generation` → v3,
   `RunEndTask` → `HookTask`, `execute()` being allowed to return a park, and new tool-slot states
   `"sleeping" | "waiting"`. None of that is in a release as of 2026-11-11.
5. **The concrete compile break waiting in a v1.5.1/v1.5.2 sync is the chord import path, not
   durable:** three fork-owned files under `packages/coding-agent/src/experimental/durable-tui/`
   import `Context`/`JsonValue` from the chord package root, and that root no longer exports them
   (they moved to `/context` and `/json`). Details in §5.

---

## 1. Coordinates and sync mechanism

From the baseline memory file
(`/Users/qingguee/.zcode/cli/memories/projects/repo-fd8548edf6bb68d0/memory/pi-durable-coding-agent-v01.md`)
and verified against the checkout:

| Thing | Value | Evidence |
|---|---|---|
| Local project | `/Users/qingguee/github/pi-durable-coding-agent` | exists, clean tree |
| Fork remote (`origin`) | `git@github.com:fan56/pi-durable-tui.git` | `git remote -v` |
| Upstream remote | `https://github.com/earendil-works/pi.git` | `git remote -v` |
| Upstream product | `pi` monorepo; durable runtime is the workspace package `packages/durable` (`@earendil-works/pi-durable`) | `packages/durable/package.json` |
| Separate upstream `pi-durable` repo | **does not exist** (`earendil-works/pi-durable` → HTTP 404) | `gh api repos/earendil-works/pi-durable` |
| Fork release channel | GitHub Releases only, `durable-tui-release.yml`, self-contained archives, no npm publish | `research/2026-11-11-pi-durable-tui-inventory.md` §2; release assets below |
| Sync mechanism | merge the upstream release tag into a `sync/upstream-vX.Y.Z` branch, then bump `VERSION`, tag `vX.Y.Z`, run the release workflow | `git log` (`939fd2085` merge of tag `v1.5.0`; `e079ecd66` version commit) |

Also checked, since the task asked for both sides: `earendil-works/pi-durable-cloudflare` is a
**separate example repository** ("Example of a durable Pi harness running on Cloudflare"), not the
upstream of pi-durable. It has **no releases** and two commits in the window:
`2046d92c2` (2026-11-04, "Upgrade to Pi Durable 1.5.0: conversation views instead of events") and
`b68bf924c` (2026-11-10, "chore: update dependencies").

---

## 2. This repo: state on 2026-11-11

Commands run in `/Users/qingguee/github/pi-durable-coding-agent`:

```
git log --oneline --since=2026-11-03        → (empty)
git status --porcelain | wc -l              → 0
git rev-parse --abbrev-ref HEAD             → sync/upstream-v1.4.0
git rev-parse HEAD origin/main refs/tags/v0.11.0
                                            → e079ecd66 (all three)
git remote -v                               → origin=fan56/pi-durable-tui, upstream=earendil-works/pi
```

- **No commits after the baseline.** HEAD is `e079ecd66` ("chore(release): version the fork's own
  line at 0.11.0", 2026-11-03T13:46:21+08:00). The active branch is still named
  `sync/upstream-v1.4.0` although it contains the v1.5.0 merge — the name is stale, the content is
  v0.11.0.
- **Remote agrees with local.** `git ls-remote origin` over SSH returns
  `e079ecd66... HEAD`, `e079ecd66... refs/heads/main`, `e079ecd66... refs/tags/v0.11.0`, and the
  older release tags `v0.7.0`…`v0.10.0`. `gh repo view fan56/pi-durable-tui` reports
  `pushedAt 2026-11-03T05:47:17Z`.
- **Releases** (`gh release list -R fan56/pi-durable-tui --limit 20`):

  | Tag | Published | Type |
  |---|---|---|
  | `v0.11.0` | 2026-11-03T05:48:40Z | pre-release |
  | `v0.10.0` | 2026-10-30T05:21:18Z | pre-release |
  | `v0.9.0` | 2026-10-21T05:32:05Z | pre-release |
  | `v0.8.0` | 2026-10-18T14:38:06Z | pre-release |

  `v0.11.0` assets: `pi-durable-tui-0.11.0-{darwin,linux}-{arm64,x64}.tar.gz` + `SHA256SUMS`
  (`https://github.com/fan56/pi-durable-tui/releases/tag/v0.11.0`).
- **CI since the baseline is green.** Scheduled runs on `main` at 11-07, 11-08, 11-09 and 11-10 all
  completed `success` (`gh run list -R fan56/pi-durable-tui`, e.g. CI run `42820121160`
  2026-11-10T12:57:10Z, npm audit run `42847481662` 2026-11-10T15:44:21Z).
- **Local tags are the fork's own line plus the upstream tags it fetched.** `git tag --sort=-creatordate`
  interleaves `v0.11.0` (fork) with `v1.5.0`, `v1.4.0`, … (upstream). Local `refs/tags/v1.5.0`
  peels to upstream `f9a263655` (2026-11-02).
- Local `main` is the upstream mirror branch (`7933a0e28`, tracking `upstream/main`), not the
  release line; the release line lives on `sync/upstream-v1.4.0`.

**Conclusion for this repo: nothing new to report locally. All movement is upstream.**

---

## 3. Upstream: releases and volume

- Latest upstream release: **v1.5.2**, tag object `b4afdddf44e059c67ccf5097e5317d913521b470`
  (`Release v1.5.2`, 2026-11-10T12:00:36Z; release published 2026-11-10T12:25:43Z).
  https://github.com/earendil-works/pi/releases/tag/v1.5.2
- Previous: **v1.5.1**, tag `dd30101cfc5b0609411dd80b6f93adbc14db14cf` (`Release v1.5.1`,
  2026-11-09T23:07:37Z; published 2026-11-09T23:47:44Z).
  https://github.com/earendil-works/pi/releases/tag/v1.5.1
- Volume (GitHub compare API):
  - `v1.5.0...v1.5.1`: **373 commits**
  - `v1.5.1...v1.5.2`: **22 commits**
  - `v1.5.2...main`: **42 commits** (as of 2026-11-11; all unreleased)
  - `commits?since=2026-11-03T00:00:00Z`: **387 commits** (a different window boundary than the
    tag comparison; both are correct)
- npm: `@earendil-works/pi-durable` latest = **1.5.2** (`npm view ... version`), i.e. the durable
  package ships with the monorepo version, no independent release train.
- Unreleased `main` composition (42 commits, by subject prefix): ~19 `p2`/`p2-mac` features,
  8 `p3` docs, 4 `chord` fixes, 2 `durable` commits, the rest release/CI/infra and one
  coding-agent crash fix (`ef9361ab7`, #12025).

---

## 4. Surface-by-surface delta

### 4.1 `packages/durable` (`@earendil-works/pi-durable`)

The published changelog sections were diffed 1.5.0 → 1.5.2
(`.../v1.5.1/packages/durable/CHANGELOG.md`, `.../v1.5.2/...`).

#### 4.1.1 Released in 1.5.1 — additive only

- `Tx.submission(id)` reads a committed submission record by ID (`9ca159208`; changelog entry in
  `packages/durable/CHANGELOG.md` @ v1.5.1; the entry carries no issue link).
- **Per-conversation compaction settings**: `configure({ compaction })` stores a
  `CompactionSettings` in the `pi.agent` document, inherited by children and forks
  (`922c3ff2b`; [#11771](https://github.com/earendil-works/pi/issues/11771)).
- **Read-only JSONL storage open** `{ readOnly: true }` for viewers of a directory another process
  writes; `commit()` then rejects with `JsonlStorageReadOnlyError` (`f5f4a71af`;
  [#11939](https://github.com/earendil-works/pi/issues/11939)).
- `SqliteStorage.commit()` rewritten to a few SQL statements per call instead of ~8 per batch
  (`fabf916fc`).
- `ConversationStreamOptions` gained `thinkingBudgets` and `websocketConnectTimeoutMs`
  (`dbc61d647`, [#10410](https://github.com/earendil-works/pi/issues/10410)).
- Fixed: scheduler notification lost while a pass plans (`e50dc7af9`;
  [#11892](https://github.com/earendil-works/pi/issues/11892)); `tool_search`/codemode summaries
  following local `$ref`s under `$defs` (`6d3e342b2`; issue
  [#11803](https://github.com/earendil-works/pi/issues/11803) also covers the malformed
  percent-escape `URIError` fix); non-BMP truncation across grep, codemode, compaction and MCP
  summaries ([#7121](https://github.com/earendil-works/pi/issues/7121)); test timeout raise
  (`469d8651b`).

Tarball diff, 1.5.0 → 1.5.1 `.d.ts` (excluding maps and chord import-path lines), shows **only**
these public-surface changes plus one signature change:

- `compactionPolicy(settings, model)` → `compactionPolicy(settings, model, conversation)` — the
  third parameter is required and typed `CompactionSettings | undefined`
  (`packages/durable/dist/harness/compaction.d.ts` in 1.5.1).
- New exports/fields: `JsonlStorageReadOnlyError`, `JsonlStorageOptions.readOnly`,
  `AgentState.compaction`, `Agent.compaction` (readonly, resolved), `AgentChange.compaction`
  (`null` clears), and `Tx.submission(id): Promise<SubmissionRecord | undefined>`.
- **Unchanged**: `Harness.open`, `ConversationView`, `LiveState`, `ToolSlot` (including the status
  union), `EntryRecord`, `Harness`/`Session`/`Conversation` method shapes — their `.d.ts` files
  differ only in `@earendil-works/chord` import specifiers.

#### 4.1.2 Released in 1.5.2 — nothing

`packages/durable/CHANGELOG.md` at v1.5.2 contains the `## [1.5.2] - 2026-11-10` heading with **no
entries**. The durable commits that landed after the v1.5.2 release commit (`b4afdddf4`) are both
unreleased (§4.1.3).

#### 4.1.3 Unreleased on `main` — breaking

From `packages/durable/CHANGELOG.md` `## [Unreleased]` as of 2026-11-11, feature commit
`473515f9c` ("feat(durable): suspendable work: signals, tools that park, gates, hook tasks"),
design doc `815541a14`:

Breaking (as stated by upstream):

- `RunEndTask`/`runEndTask` renamed `HookTask`/`hookTask` (because `afterTools` and `onYield` hooks
  now return tasks).
- `execute()` may return `Promise<ToolExecutionResult | ToolPark>`; callers annotating
  `Promise<ToolExecutionResult>` must widen.
- `until` becomes optional on sleeping task states.
- `ToolResultMessage.durationMs` (and nested equivalents) now means first-run-to-result wall time
  on the Harness clock, including parks, crash downtime and reruns.
- `pi.tool` schema version → **4**, `pi.generation` → **3**; older Harnesses block these tasks
  (`task_too_old`).

Added: `defineSignal`/`harness.signal`/`tx.signal`/`readSignal`; sleeps that wait for signals;
`policy: "any"` waits; `WakeReason` (`time`, `expired`, `signal`, `tasks`); park shapes
`{ sleep: {...} }` / `{ wait: {...} }`; `cancel()` for parked calls; `executeTool(..., { wait:
false })` returning `{ taskId, result(context) }`; built-in `SubmissionSettled` signal;
`beforeTool` gates; hook tasks for `afterTools`/`onYield`; examples 38–46.

Also unreleased and durable-side: `64c96d00d` "clean up provider resources when a harness closes"
([#11961](https://github.com/earendil-works/pi/issues/11961)) — after the v1.5.2 release commit,
no changelog entry in 1.5.2.

### 4.2 `packages/chord` — the structural break for the next sync

**[released, 1.5.1]**

- Chord v2 becomes the package root: `@earendil-works/chord` now exports v2 (previously at
  `/next`). Chord v1 (`/old`, `/old/node`) is **deleted** in 1.5.1 (`ed4f48840`,
  2026-11-03T12:11:22Z, files `packages/chord/package.json`, `src/index.ts`, `src/old/**`,
  `test/old/**`, plus `scripts/browser-smoke-entry.ts`).
- Foundations moved to their own subpaths: `/context`, `/delta`, `/json`, `/watch`
  (`packages/chord/CHANGELOG.md` @ v1.5.1).
- Verified from the npm export map: 1.5.0 exports
  `[".", "./context", "./delta", "./next", "./node", "./output", "./sqlite", "./sqlite/*", "./telemetry-sqlite", "./package.json"]`;
  1.5.1 exports added `./app`, `./app/files`, `./http`, `./json`, `./plugins`, `./plugins/runtime`,
  `./react`, `./surfaces`, `./sync`, `./tui`, `./tui/launcher`, `./watch`, `./web`, `./workers`,
  `./workers/child` and **removed `./next`, `./node`, and any `/old`**.
  (1.5.2 adds `./compression`; root contents otherwise unchanged from 1.5.1.)
- **Durable is pinned to the chord minor exactly**: `@earendil-works/pi-durable@1.5.1` declares
  `"@earendil-works/chord": "1.5.1"` (1.5.2 → `"1.5.2"`), so upgrading durable forces chord v2.
- The old root API is gone from `.`: 1.5.1's root `index.d.ts` contains no `createHost`,
  `memoryLinkPair`, `replicatedState`, `Context`, `Draft` or `JsonValue`, and upstream's own
  migration note says root imports of `Context`/`Draft`/`JsonValue`/`copyJson`/watch types move to
  `/context`, `/delta`, `/json` and `/watch`.
- Chord 1.5.1 also lists other breaking changes unrelated to this fork's usage (Chord v2's
  `startWorker` loses `telemetry`; `createWorkers` becomes async and builds a worker base; reload
  restarts objects instead of swapping in place, with `swapped` removed from `ReloadReport`).
  Kept for completeness; the fork's only chord contact is the `Context` type.

Effect on published durable typings (verified by tarball diff): durable 1.5.0 `.d.ts` imported
`Context`/`JsonValue`/`Draft` from the chord **root**; durable 1.5.1 imports them from
`@earendil-works/chord/context`, `/json`, `/delta`, `/watch`.

### 4.3 Session persistence and rehydration

Terminology in this repo: "hydrate" appears in two unrelated places — model-catalog hydration
(`npm run hydrate:model-data`, build-time, not a session concept) and transcript rehydration on
resume (`transcript-rebuild.ts` rebuilding from durable entries). Facts for both:

- **Durable session storage** [released 1.5.1]: new read-only JSONL open for viewers
  (`f5f4a71af`); `SqliteStorage.commit()` batching rewrite (`fabf916fc`) with one behavior change:
  a stored document record that cannot be parsed now rejects the call as a storage failure instead
  of refusing the batch. `Harness.open` and `openNodeSqliteStorage` keep their signatures (tarball
  diff); the on-disk schema was not inspected.
- **Transcript entry shape** [released 1.5.1/1.5.2]: `EntryRecord` unchanged between 1.5.0 and
  1.5.2 (`.d.ts` identical apart from chord imports). Rehydration built on entries is not affected
  by released upstream changes.
- **Stable-session resume flow** [released 1.5.2]: when a session's working directory no longer
  exists, interactive mode now offers `Continue` / `Fork` / `Cancel`; this applies at startup
  (`--session`, `--resume`), `/resume`, `/import`, and **`ctx.switchSession()` from extensions**
  (`4ea883792`, PR [#11975](https://github.com/earendil-works/pi/pull/11975), fixes
  [#11060](https://github.com/earendil-works/pi/issues/11060)). `/import` no longer leaves a
  duplicate `s-1.jsonl` copy for a missing cwd (same commit).
- **Resume correctness fixes**: live thinking level is recorded on the new branch before each
  prompt, so resuming after `/tree` no longer restores an old level (`7860ff528`;
  [#11451](https://github.com/earendil-works/pi/issues/11451)); changelog "last seen version" no
  longer misparses prerelease suffixes (`9a1953961`; [#11703](https://github.com/earendil-works/pi/issues/11703)).
- **[unreleased]** `ef9361ab7` stops a crash when an aborted signal destroys an unwatched file
  stream ([#12025](https://github.com/earendil-works/pi/issues/12025)).
- **[unreleased]** the `[Unreleased]` section adds "Fixed pi exiting with an uncaught `AbortError`
  when the session picker cancels loading after skipping a non-session `.jsonl`, and fixed such
  files staying open" ([#11956](https://github.com/earendil-works/pi/issues/11956)).

### 4.4 Event / event-stream surface

- **No released change.** The durable event-stream layer was already removed in 1.5.0 (the fork's
  `event-adapter.ts` was rebuilt on `ConversationView` snapshots for that reason); 1.5.1 and 1.5.2
  add nothing to `ConversationView`, `LiveState`, `EntryRecord` or `ToolSlot` (tarball diff).
- `@earendil-works/pi-agent-core` declares no changes in 1.5.1/1.5.2 beyond
  `streamProxy()` forwarding `disableContinuation` (`packages/agent/CHANGELOG.md` @ v1.5.1), so the
  `AgentEvent` shapes the adapter emits are unchanged in released code.
- **[unreleased]** two adapter-visible changes come with suspendable work (`473515f9c`):
  - `ToolSlot.status` becomes `"pending" | "running" | "sleeping" | "waiting" | "done"`
    (`packages/durable/src/harness/live.ts:25` on `main`; a parked slot "holds no output").
  - tool `durationMs` semantics change (wall time including parks, hooks, crash downtime, reruns).
- **[unreleased]** `compactionFailure`/`CompactionStatus` keep the field name `trigger`; the
  `reason` → `trigger` rename is an older v1→v2 live-state migration, not new (`live.ts` comment on
  `main`; `LiveState` was already `trigger` at 1.5.0, verified by tarball diff).

### 4.5 Tool surface (names, schemas, validators)

- **Tool names unchanged.** No rename in durable `CodingTools` or coding-agent built-ins; MCP tools
  keep `mcp__<server>__<tool>`. 1.5.1 only extracted the naming/validation helpers into
  `@earendil-works/pi-mcp` (`76c040a2a`: `createMcpToolName()`, `mcpNamespace()`,
  `normalizeMcpInputSchema()`, `limitMcpContent()`, `MCP_OUTPUT_MAX_BYTES`,
  `validateMcpServerConfig()`), packaged as additive API (`packages/mcp/CHANGELOG.md` @ v1.5.1).
- **Validation engine** (`pi-schema`), released 1.5.1:
  - TypeBox JavaScript types now validate/coerce as TypeBox did: `{type:"bigint"}`,
    `{type:"undefined"}`, plus new `unsafe<T>()`, `recursive<T>()`, `Validator.validate()`,
    `Static` for `Enum`/`Tuple`/`BigInt`/`Undefined`, `equal()` (`af79b0c3d`,
    [#11833](https://github.com/earendil-works/pi/issues/11833)).
  - `number`/`integer` now reject `NaN`/`Infinity`/`-Infinity` (`55a5c6914`).
  - Faster inline checks; relative root `$id` applied once (`2bd2c2d0a`;
    [#11726](https://github.com/earendil-works/pi/issues/11726)).
  - Tool-argument behavior follows: `Type.BigInt()`/`Type.Undefined()` arguments convert instead of
    being rejected; `Type.Void()` still rejects (`packages/ai/CHANGELOG.md` @ v1.5.1).
- **Tool behavior changes**, released 1.5.1 unless noted:
  - `GrepOperations.readFile` is no longer called for context lines; the field is deprecated but
    still accepted. **This is listed as a breaking change** by upstream (`8da141c2a`;
    [#9276](https://github.com/earendil-works/pi/issues/9276)). Override `execute()` for remote
    grep instead.
  - grep globs are relative to `path` (`6bf2ab9bb`; [#11807](https://github.com/earendil-works/pi/issues/11807)).
  - `read` streams the file instead of loading it (`3a7bb6f48`; [#9654](https://github.com/earendil-works/pi/issues/9654));
    new optional `ReadOperations.createReadStream`.
  - `find`/`ls`: `limit: 0` and limits below 1 now mean 1; exact-limit no longer reports a limit
    notice (`676af1d77`; [#7121](https://github.com/earendil-works/pi/issues/7121)).
  - `bash` timeout errors also report the shell exit code and exit time (`06aa6563e`;
    [#11613](https://github.com/earendil-works/pi/issues/11613)); Windows `powershell` exit codes
    (`c9dd2c530`; [#11964](https://github.com/earendil-works/pi/issues/11964)).
  - `edit` preserves untouched line endings and diffs only changed regions (`d448c51e2`;
    [#8544](https://github.com/earendil-works/pi/issues/8544)).
  - OpenAI-compatible providers omit `"tools": []` when tools are disabled; new opt-out
    `compat.requiresToolsWithToolHistory` (**breaking**, `packages/ai/CHANGELOG.md` @ v1.5.1;
    [#11843](https://github.com/earendil-works/pi/issues/11843)).

### 4.6 Plugin / extension API

Released 1.5.1 unless noted:

- `pi.registerMarkdownTransformer()` accepts `{ messageTypes }` and can opt into `custom`,
  `summary`, `changelog` surfaces in addition to user/assistant/thinking (`eebd5d90c`;
  [#11756](https://github.com/earendil-works/pi/issues/11756)). Additive; defaults unchanged.
- `ctx.ui.custom()` honors `blocked` and reports blocked program status (OSC 7501) from show until
  `done()`, including while hidden (`7f47a2ed0`; [#11851](https://github.com/earendil-works/pi/issues/11851)).
- `/reload` and session switches now remove **all** extension overlays, including hidden ones
  (`80d4d3c86`; [#11853](https://github.com/earendil-works/pi/issues/11853)).
- `ctx.reload()` / SDK / RPC reload is **rejected while a response or compaction is running**
  instead of replacing extensions mid-flight (`c3b938e3e`; PR
  [#9222](https://github.com/earendil-works/pi/pull/9222)).
- Extension entry files are resolved through `realpath` before jiti import, fixing symlinked
  installs (`e6865ec7e`; [#8112](https://github.com/earendil-works/pi/pull/8112)).
- Extension selection dialogs now scroll (max ten options) instead of overflowing the terminal
  (`3b57ed7e2`; [#11072](https://github.com/earendil-works/pi/pull/11072)).
- `pi update --extensions` prints per-package version/commit changes; `PackageManager.update()`
  emits a new `result` progress event (`packages/coding-agent/CHANGELOG.md` @ v1.5.1;
  [#11707](https://github.com/earendil-works/pi/pull/11707), [#11711](https://github.com/earendil-works/pi/pull/11711)).
- RPC: idle `ctx.shutdown()` is honored (`1708b4788`; [#11599](https://github.com/earendil-works/pi/issues/11599)).
- No changelog entry in 1.5.1/1.5.2 for `ctx.ui.setWidget`, `pi.registerToolRenderer`,
  `pi.registerCommand` or `ExtensionAPI` shape — changelog-level evidence only, not a source diff.

### 4.7 Config / settings / model catalog

- `cacheWarming` now defaults to `"idle"` instead of `"streaming"` (`7bcc15c92`; settings docs @
  v1.5.1). Consecutive cache warms print as one cumulative line (`a013448fb`).
- New `compat` knobs in `models.json`: `supportsMessageThreads` (Anthropic message threads,
  `a758f3ae4`; [#11545](https://github.com/earendil-works/pi/pull/11545)),
  `requiresToolsWithToolHistory` ([#11843](https://github.com/earendil-works/pi/issues/11843)),
  `promptCacheKeyMode` ([#9442](https://github.com/earendil-works/pi/pull/9442)),
  `requiresNonNullAssistantContent` ([#8118](https://github.com/earendil-works/pi/pull/8118)).
- `pi auth login|logout <provider>` shell commands (`9b9cb30ae`; see v1.5.1 release notes).
- Default model moves (`d84123b32`, `b425754a2`): `anthropic` default is now Claude Opus 5.5
  (was Opus 4.8); `amazon-bedrock` → Opus 5.5; `azure` → GPT-6.1 Sol; `google` and
  `google-vertex` → Gemini 4 Argon; `vercel-ai-gateway` and `baseten` → GLM 5.3; `minimax` and
  `minimax-cn` → MiniMax-M3; `qwen-token-plan` and `qwen-token-plan-cn` → Qwen3.8 Max;
  `opencode-go` → Kimi K3.1 Pro; `moonshotai`, `moonshotai-cn`, `huggingface`, `opencode`,
  `openrouter`, `cloudflare-workers-ai`, `cloudflare-ai-gateway` → Kimi K2.7 Code.
- New model: Claude Fable 5.2 (`0d1793c2b`); new provider `qwen-token-plan-individual-cn`
  (`3e4f87265`; [#7989](https://github.com/earendil-works/pi/pull/7989)); GitHub Copilot
  Microsoft-Decision-1 classifiers ([#11679](https://github.com/earendil-works/pi/pull/11679)).
- Upstream release tooling changes (upstream's own release scripts, not the fork's
  `durable-tui-release.yml` path): releases require npm 11+ (`681d3a4de`), version bumps touch
  only top-level packages (`058496bad`), release scripts find published packages only in
  `packages/*` (`2930f5220`), release version sync pins only published packages (`4657d5428`),
  and CI checks released changelog sections against their tag (`b0ebcafc7`).

### 4.8 `packages/tui` (the widget/render layer used by the activity panel)

Released 1.5.1 contains **fixes only** — no API change (`packages/tui/CHANGELOG.md` @ v1.5.1):
Markdown HTML comments are hidden (`54280c4ff`; issue
[#11710](https://github.com/earendil-works/pi/issues/11710)); fullscreen Kitty images on every
terminal (`4622edb79`; issue [#11835](https://github.com/earendil-works/pi/issues/11835)); short
paste markers survive Backspace (`a77207d9c`; issue
[#11923](https://github.com/earendil-works/pi/issues/11923)); internal cursor markers no longer
leak into output (`25490ea49`; PR [#9441](https://github.com/earendil-works/pi/pull/9441));
Alacritty hyperlink detection without `TERM_PROGRAM` (`2af8a42f5`; issue
[#11767](https://github.com/earendil-works/pi/issues/11767)).
1.5.2: no entries. `Unreleased`: no TUI entries.

### 4.9 Upstream direction (context only, not a fork dependency)

- `apps/p2` is a **new experimental self-hosted Pi Durable UI** built from Chord plugins; its
  README says: "p2 is a prototype. It will be gone soon. It is not supported, its data formats and
  APIs change without notice, and it will be replaced." (`apps/p2/README.md` @ main).
- `apps/p2-mac` is a macOS app spike (`ee513549d`); `apps/p3` is docs/design only (no README).
- 42 unreleased commits are mostly p2 UI work, not durable-core work. No statement was found in
  the v1.5.1/v1.5.2 release notes or the changelogs that the coding-agent TUI is deprecated.
  **Intent/migration plan: unverified** (inference would be speculation).

---

## 5. What touches this fork's own durable-tui code

The fork owns `packages/coding-agent/src/experimental/durable-tui/**`. Upstream merges do not touch
these files, so the following are actual edits a sync would need, not things the merge carries.

### 5.1 Compile-level break: chord root imports (blocks any v1.5.1+ merge)

| File:line | Import | Status after chord 1.5.1 |
|---|---|---|
| `packages/coding-agent/src/experimental/durable-tui/harness-setup.ts:4` | `import type { Context } from "@earendil-works/chord"` | root no longer exports `Context` → TS error |
| `packages/coding-agent/src/experimental/durable-tui/subagent.ts:6` | `import type { Context } from "@earendil-works/chord"` | same |
| `packages/coding-agent/src/experimental/durable-tui/tool-bridge.ts:25` | `import type { JsonValue } from "@earendil-works/chord"` | root no longer exports `JsonValue` → TS error |
| `packages/coding-agent/src/experimental/durable-tui/durable-agent-session.ts:20` | `BACKGROUND_CONTEXT` from `@earendil-works/chord/context` | already on a surviving subpath |

Mechanical fix per upstream's own migration: `/context` and `/json`. The `Context` interface shape
is identical in both chord versions (verified by reading
`dist/context/index.d.ts` in 1.5.0 and 1.5.1), so this is an import-path migration, not a
semantic one — **runtime behavior equivalence unverified** (v2's `Context` module is a different
module instance; whether any identity check exists was not tested).

Fork-owned files that would not need edits: `activity-panel.ts`, `event-adapter.ts`,
`extensions-manager.ts`, `extension-picker.ts`, `lock.ts`, `main.ts`, `prompt.ts`,
`session-location.ts`, `session-meta.ts`, `sessions-extension.ts`, `transcript-rebuild.ts`
(no `@earendil-works/chord` root imports — grep over the directory).

Also in the repo but **upstream-owned** (the merge updates them itself): `scripts/browser-smoke-entry.ts`
imports `createHost`, `memoryLinkPair`, `replicatedState` from the chord root; upstream replaced
that file in `ed4f48840`.

### 5.2 Released durable changes: does the adapter care?

| Fork touchpoint | Upstream change | Effect |
|---|---|---|
| `event-adapter.ts:17` (`ConversationView`, `LiveState`, `ToolSlot`, `EntryRecord`) | 1.5.0→1.5.1→1.5.2 shapes unchanged (tarball diff) | no change needed for a 1.5.1/1.5.2 sync |
| `event-adapter.ts:23` `SlotTrack.status: "pending" \| "running" \| "done"` | **[unreleased]** `ToolSlot.status` adds `"sleeping" \| "waiting"` | type error on the next *durable main* sync; behavior for parked slots undefined in this adapter |
| `tool-bridge.ts:114` `execute(): Promise<ToolExecutionResult<JsonValue>>` | **[unreleased]** `execute()` may return `ToolPark` | annotation must widen; wrappers cannot park (upstream: "a composite's park its base did not return is invalid") |
| `durable-agent-session.ts:132` `Harness.open(await openNodeSqliteStorage(...))` | 1.5.1/1.5.2 `Harness.open`/storage open unchanged; 1.5.1 commit batching rewrite | no signature change; storage failure semantics tightened for unparsable document records |
| `durable-agent-session.ts:502,509` compaction override (`prepareCompaction` + `root.compact`) | 1.5.1 adds per-conversation `configure({ compaction })` and a 3-arg `compactionPolicy` | fork does not call `compactionPolicy`; new API unused (grep: no hits in durable-tui) |
| `sessions-extension.ts:94` `ctx.switchSession(join(directory, CARRIER_NAME))` | 1.5.2 adds Continue/Fork/Cancel prompt when the session cwd is gone (PR #11975) | same code path is now subject to the prompt; interaction with the carrier-path trick **unverified** (not exercised) |
| `main.ts:229` (resume branch) and `main.ts:241-242` (fork throws) | 1.5.2 adds a user-visible Fork option in the missing-folder flow (PR #11975) | fork still throws on `reason === "fork"`; upstream's new fork prompt can reach a factory that refuses — behavior **unverified** |
| `subagent.ts:42` `tx.scanConversations({ ownerTaskId })` | 1.5.1 adds cheaper `Tx.submission(id)` | optional optimization only |

### 5.3 Things NOT affected by released changes

- Tool names (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`, `tool_search`,
  `mcp__*`) — no rename appears in the 1.5.1/1.5.2 changelogs; MCP naming became a shared helper
  with the same `mcp__<server>__<tool>` format.
- `pi.registerToolRenderer` (activity panel audit rows) — no 1.5.1/1.5.2 changelog entry.
- `ctx.ui.setWidget` — no 1.5.1/1.5.2 changelog entry (changelog-level evidence only).
- TUI widget/render pipeline — 1.5.1 fixes only, no API change.
- `AgentEvent` from `@earendil-works/pi-agent-core` — no changes declared in 1.5.1/1.5.2.
- Fork's session persistence layout (`session.sqlite` + `session.json` sidecar + `lock.ts`) — no
  upstream API change; new read-only JSONL open is an unused capability, not a replacement.

---

## 6. Not verified / not done

- **No code was built or tested.** No `npm ci`, no `npm run check`, no fork or upstream test suite
  run. The chord import findings are from published `.d.ts`/export maps, not from a compile of the
  fork against 1.5.1.
- The 387-commit window was triaged by path filters (`packages/durable`, `packages/chord`,
  `packages/coding-agent/src/modes`, `.../core`) plus changelog reading, not by reviewing every
  commit diff.
- `.d.ts`-level API comparison cannot prove runtime behavior; park/signal semantics, chord v2
  `Context` identity, and storage failure changes were not executed.
- The interaction between the fork's carrier-path `ctx.switchSession` and upstream's new
  missing-cwd Continue/Fork prompt is **unverified**.
- Whether the fork's launcher exposes upstream's new `pi auth login|logout` shell commands (it is a
  separate binary entry) — **unverified**.
- Upstream p2/p3 intent, roadmap, or any plan to replace the coding-agent TUI — **unverified**; only
  the p2 README's self-description is quoted.
- No upstream release notes exist for anything after v1.5.2; the `[Unreleased]` sections are
  work-in-progress and can change.

---

## 7. Sources

- Fork: `gh release list -R fan56/pi-durable-tui`, `gh repo view fan56/pi-durable-tui`,
  `gh run list -R fan56/pi-durable-tui`, `git -C /Users/qingguee/github/pi-durable-coding-agent`
  (`log`, `status`, `rev-parse`, `tag`, `ls-remote`).
- Upstream releases: https://github.com/earendil-works/pi/releases/tag/v1.5.1 ,
  https://github.com/earendil-works/pi/releases/tag/v1.5.2
- Upstream changelogs at tags: `packages/{durable,chord,coding-agent,ai,schema,mcp,tui,agent,env,codemode}/CHANGELOG.md`
  at `v1.5.0`, `v1.5.1`, `v1.5.2`, and `main`.
- Upstream commits/compares: `gh api repos/earendil-works/pi/compare/v1.5.0...v1.5.1`,
  `.../v1.5.1...v1.5.2`, `.../v1.5.2...main`; individual commits `ed4f48840`, `473515f9c`,
  `815541a14`, `922c3ff2b`, `9ca159208`, `f5f4a71af`, `fabf916fc`, `e50dc7af9`, `dbc61d647`,
  `4ea883792`, `80d4d3c86`, `7f47a2ed0`, `c3b938e3e`, `eebd5d90c`, `76c040a2a`, `af79b0c3d`,
  `55a5c6914`, `2bd2c2d0a`, `3a7bb6f48`, `d448c51e2`, `06aa6563e`, `7860ff528`, `9a1953961`,
  `7bcc15c92`, `0d1793c2b`, `d84123b32`, `b425754a2`.
- Published packages diffed: `npm pack @earendil-works/pi-durable@{1.5.0,1.5.1,1.5.2}` and
  `@earendil-works/chord@{1.5.0,1.5.1,1.5.2}`, then `diff -ru .../dist -x '*.map' -x '*.js'`.
- Fork source paths cited in §5: `packages/coding-agent/src/experimental/durable-tui/{harness-setup.ts,subagent.ts,tool-bridge.ts,durable-agent-session.ts,event-adapter.ts,sessions-extension.ts,main.ts}`.
