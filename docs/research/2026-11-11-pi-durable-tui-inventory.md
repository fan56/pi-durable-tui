# pi-durable-tui inventory and pi-durable coupling surface

Date: 2026-11-11
Scope: read-only inventory. No code changed, nothing committed, nothing published.
Method: filesystem inspection, `git log`, `gh` read queries, and `grep` over source. Every
claim below carries a path (and line where applicable). Items that could not be confirmed are
marked **unverified**.

Note on placement: the task specified `research/`. The repo's own convention (AGENTS.md:145)
puts throwaway research under `docs/research/` (AGENTS.md:147). Only the path named in the task was written.

---

## 1. Identity: where "pi-durable-tui" actually is

**Finding: `pi-durable-tui` is the GitHub remote of the very directory the task calls the
"pi-durable main repo". There is no separate `pi-durable` repository.**

- `/Users/qingguee/github/pi-durable-coding-agent` has:
  - `origin` = `git@github.com:fan56/pi-durable-tui.git`
  - `upstream` = `https://github.com/earendil-works/pi.git`
  (verified via `git remote -v` in that directory)
- `gh repo view fan56/pi-durable-tui` → `isFork: false`, `defaultBranchRef: main`,
  `createdAt 2026-10-09`, `pushedAt 2026-11-03`, description: "Experimental early-access coding
  agent: the stable pi TUI on the durable runtime…"
- `gh repo list fan56` (200 repos) contains exactly one `pi-durable*` entry: `pi-durable-tui`.
  There is no `pi-durable` repo.
- The durable runtime itself is a **workspace package inside that repo**:
  `packages/durable` → `@earendil-works/pi-durable` version `1.5.0`
  (`packages/durable/package.json`).
- The TUI code is a **fork layer inside the coding-agent package**:
  `packages/coding-agent/src/experimental/durable-tui/` — 17 files, 3254 lines of TypeScript.
  Its own README calls it "durable-tui (v0.5)": `packages/coding-agent/src/experimental/durable-tui/README.md:1`.
- The shipped artifact is a self-contained archive named `pi-durable-tui`
  (`scripts/build-durable-tui-release.sh`; archive `pi-durable-tui-<version>-<platform>.tar.gz`).
- `AGENTS.md:150` states the same thing: "origin（`fan56/pi-durable-tui`）是唯一分发渠道".

### Other candidates considered and ruled out

| path | package name | why it is not pi-durable-tui |
|---|---|---|
| `/Users/qingguee/repo/dsh-tui-pi` | `@aiwayds/dsh-tui-pi` | dsh (DeepSeek Harness) plugin, not durable; depends on `@earendil-works/pi-tui` 0.85.1 only (`package.json` deps). Remote `fan56/dsh-tui-pi`. |
| `/Users/qingguee/repo/dsh-tui-pi-tps` | `@aiwayds/dsh-tui-pi` | duplicate/secondary checkout of the same package. |
| `/Users/qingguee/repo/dsh-opentui`, `-spike`, `-wt-1954`, `-wt-gate` | `dsh-opentui*` | dsh ecosystem OpenTUI work; unrelated to durable. |
| `/Users/qingguee/github/pi-durable-demo`, `pi-durable-mcp-lab`, `pi-durable-mcp-test`, `durable-p1-lab` | — | not git repos / empty or tiny demo scripts. |

---

## 2. Package name, version, pinning

### Versions

| item | value | source |
|---|---|---|
| fork release line | `0.11.0` | `/Users/qingguee/github/pi-durable-coding-agent/VERSION` (also `git log -1`: `e079ecd66 chore(release): version the fork's own line at 0.11.0`) |
| monorepo root | `pi-monorepo` `0.0.3`, private | `package.json` |
| coding-agent package | `@earendil-works/pi-coding-agent` `1.5.0` | `packages/coding-agent/package.json` |
| durable package | `@earendil-works/pi-durable` `1.5.0` | `packages/durable/package.json` |
| chord package | `@earendil-works/chord` `1.5.0` | `packages/chord/package.json` |
| published archive manifest | name `pi-durable-tui`, version = `VERSION` file | `scripts/build-durable-tui-release.sh` (heredoc that writes `$BUNDLE_DIR/package.json`) |

### Dependency pinning for the pi family

`packages/coding-agent/package.json` `dependencies` pins exact versions (no `^`):

```
"@earendil-works/pi-agent-core": "1.5.0",
"@earendil-works/pi-ai": "1.5.0",
"@earendil-works/pi-codemode": "1.5.0",
"@earendil-works/pi-mcp": "1.5.0",
"@earendil-works/pi-tui": "1.5.0",
"typebox": "1.3.27",
```

**`@earendil-works/pi-durable` and `@earendil-works/chord` are NOT declared dependencies of
`packages/coding-agent`**, even though the durable-tui tree imports them. They resolve through
the npm-workspace root symlinks:

- `node_modules/@earendil-works/pi-durable -> ../../packages/durable`
- `node_modules/@earendil-works/chord -> ../../packages/chord`

So the effective pin is "whatever the workspace package version is" (`1.5.0` today), not an
explicit manifest entry. Why this passes CI: upstream's build config excludes the tree —
`packages/coding-agent/tsconfig.build.json` `exclude: [... "src/experimental"]` — and the fork
config narrows that exclusion to make the tree compile:
`packages/coding-agent/tsconfig.build.durable.json` (`exclude: ["node_modules","dist","src/client","src/cli/experimental"]`).

### Release-archive pinning (separate from the workspace)

`scripts/build-durable-tui-release.sh` writes a manifest with:

```
"@earendil-works/chord": "1.1.0",
"@silvia-odwyer/photon-node": "0.3.4",
"jiti": "2.7.0",
"quickjs-wasi": "3.6.2"
```

`@earendil-works/pi-durable` is not listed → it is expected to be inlined by esbuild
(`allowedExternalPackages` in `scripts/build-coding-agent-bundle.mjs:18-27` does not contain
pi-durable). **Observation, not a conclusion:** the archive pins chord `1.1.0` while the
workspace ships chord `1.5.0`; whether the archive actually loads chord `1.1.0` at runtime is
**unverified** (bundle inlining not inspected).

Build-path note (why not a Bun single binary): durable-tui's store is Node's built-in
`node:sqlite` (`@earendil-works/pi-durable/storage/sqlite/node`), which Bun does not implement —
`scripts/build-durable-tui-release.sh` header comment.

---

## 3. Git history

Local checkout: branch `sync/upstream-v1.4.0` (despite the name, HEAD contains the v1.5.0 merge).
Tags present: `v1.0.0` … `v1.5.0` (upstream tags).

### Last 20 commits (repo-wide)

```
e079ecd66 2026-11-03 chore(release): version the fork's own line at 0.11.0
b1c4019a4 2026-11-03 docs: disable the upstream Preview Packages workflow (ticket 012)
e43bfffac 2026-11-03 chore(deps): canonicalize the root lockfile after the v1.5.0 merge
41cb7e936 2026-11-03 fix(durable-tui): rebuild the event adapter on the conversation view
fa079b349 2026-11-03 fix(durable-tui): import Type from typebox for the subagent tool schema
9c7a4eb68 2026-11-03 fix(ai): keep Sonnet 5.5's official cache-read price in the models.dev v2 catalog
939fd2085 2026-11-03 Merge tag 'v1.5.0' into sync/upstream-v1.4.0
f9a263655 2026-11-02 Release v1.5.0
513f6f1ce 2026-11-02 fix: keep Chord example dependencies out of releases
7e7c98a0f 2026-11-02 docs(coding-agent): note branch summary context edits
87f69dbf3 2026-11-02 docs(chord): app kit principals and users
2dd44fb1c 2026-11-02 docs(chord): app kit shape
7edaa131d 2026-11-02 docs(chord): testing a plugin alone
95e2015f3 2026-11-02 docs(chord): single-file plugins
ee7f61f92 2026-11-02 docs(chord): contracts come from where the plugin's code came from
ddbe02cd2 2026-11-02 docs: audit changelogs and add release highlights
d0fe21308 2026-11-02 fix(coding-agent): apply context edits to branch summary input (#11680)
6ab6c1e0e 2026-11-02 docs(chord): cross-plugin import rule
c9f4c7b9f 2026-11-02 docs(chord): fold the cross-plugin import rule into design and slices
e1669ee4b 2026-11-01 docs(chord): contracts come from where the plugin's code came from
```

### Last 20 commits touching durable-tui (path-scoped)

```
41cb7e936 2026-11-03 fix(durable-tui): rebuild the event adapter on the conversation view
fa079b349 2026-11-03 fix(durable-tui): import Type from typebox for the subagent tool schema
2380687ea 2026-10-21 fix(coding-agent): port durable-tui to the durable 1.2 / coding-agent 1.3 APIs
b9aa329b1 2026-10-12 fix(ci): biome noImplicitAnyLet + unused imports + safe fixes
91ffb6e0c 2026-10-09 feat(durable-tui): activity panel v3 — fixed geometry, phase-bridged, reply-gated hide
330b3ba31 2026-10-09 feat(durable-tui): activity panel — 7-row default, per-phase 1s dwell, incremental partials
9b961d57b 2026-10-09 feat(durable-tui): activity panel uses native theme tokens + transcript stops duplicating tools
f6c8dff9e 2026-10-09 fix(durable-tui): activity panel scrolls — newest content, not the head
efee1c6dc 2026-10-09 feat(durable-tui): v0.7 activity panel — live think+tool viewport above the editor
0d3387374 2026-10-09 chore(release): package pi-durable-tui as a self-contained archive
9a8218a01 2026-10-09 test(e2e): compute the lockloss session-root hash with node
efadcf0f6 2026-10-09 feat(durable-tui): v0.6 — directory rename completion + crash-proof session locks
```

Tests that guard the fork layer: `packages/coding-agent/test/durable-tui-event-adapter.test.ts`,
`packages/coding-agent/test/durable-tui-transcript-rebuild.test.ts` (vitest).
E2E: `e2e/durable-tui/{run.sh,podman-e2e.sh,Containerfile,fixtures}`.
CI/release: `.github/workflows/durable-tui-ci.yml`, `.github/workflows/durable-tui-release.yml`.

---

## 4. Coupling surface: durable-tui → pi-durable

All paths below are relative to `/Users/qingguee/github/pi-durable-coding-agent`.
Consumer tree: `packages/coding-agent/src/experimental/durable-tui/`.

Import frequency over the 17 files (specifier occurrences):

```
9  @earendil-works/pi-durable            (main entry)
1  @earendil-works/pi-durable/tools
1  @earendil-works/pi-durable/env/node
1  @earendil-works/pi-durable/storage/sqlite/node
5  @earendil-works/pi-ai          2  @earendil-works/pi-ai/compat
4  @earendil-works/pi-agent-core  3  @earendil-works/chord  1  @earendil-works/chord/context
2  @earendil-works/pi-tui         1  typebox
```

### 4.1 Event adapter (`event-adapter.ts`) — durable view → pi AgentEvents

The adapter exists because durable 1.5 removed the event stream (`watchEvents`) and replaced it
with state watching; the file reconstructs pi-agent-core `AgentEvent`s by diffing
`ConversationView` snapshots (header comment `event-adapter.ts:1-7`).

| durable symbol | consumer site | note |
|---|---|---|
| `ConversationView` | `event-adapter.ts:17` (import), `:48` (field), `:56` (`translate(view)`), `:92` (`computeAppended`) | |
| `EntryRecord` | `event-adapter.ts:17`, `:31` (`AdapterStep.appendedEntries`), `:92`, `:392` (`entryById(id: EntryRecord["id"])`) | |
| `LiveState` | `event-adapter.ts:17`, `:48`, `:58` (`view.docs["pi.live"]`), `:144`, `:181`, `:311`, `:330`, `:397` | read via the `pi.live` document |
| `ToolSlot` | `event-adapter.ts:17`, `:377` (`slotEndEvent(slot: ToolSlot)`) | |
| `view.entries` | `event-adapter.ts:63`, `:94`, `:401-406` | entry window |
| `view.docs["pi.live"]` | `event-adapter.ts:58` | live document |
| `live.run` | `event-adapter.ts:59` | run-in-progress flag |
| `live.generation.message` | `event-adapter.ts:145`, `:183`, `:398` | streamed partial |
| `live.generation.attempt` | `event-adapter.ts:148`, `:185`, `:195` | retry generation identity |
| `live.generation.retry` | consumed by the facade, `durable-agent-session.ts:286-296` (`live?.generation?.retry`) | |
| `live.tools[]` (`callId`,`name`,`status`,`output`,`entry`) | `event-adapter.ts:313-327`, `:331-369`, `:378` | tool slot lifecycle |
| `live.compactions[]` (`taskId`,`trigger`) | `durable-agent-session.ts:305-312` | compaction_start synthesis |
| `entry.model?.[0]` | `event-adapter.ts:521`, `durable-agent-session.ts:263`, `transcript-rebuild.ts:43` | message payload |
| `entry.head` | `durable-agent-session.ts:271`, `transcript-rebuild.ts:83` | compaction head pointer |
| `entry.id` | `durable-agent-session.ts:273`, `:369`, `transcript-rebuild.ts:50` etc. | entry identity |
| `entry.kind` (`pi.user`/`pi.assistant`/`pi.tool-result`/`pi.reset`/`pi.compaction`/`pi.system`) | `transcript-rebuild.ts:44-94` | transcript mapping switch |

### 4.2 Session storage / hydrate / conversation control

| durable API | consumer site | provider anchor |
|---|---|---|
| `openNodeSqliteStorage` | `durable-agent-session.ts:35` (import), `:133` | `packages/durable/src/storage/sqlite/node.ts:15` |
| `Harness.open(storage, options, context)` | `durable-agent-session.ts:132-142` | `packages/durable/src/harness/harness.ts:586-592` |
| `harness.root(context, { agent })` | `durable-agent-session.ts:144-148` | `packages/durable/src/harness/types.ts:896` |
| `harness.waitForTask(taskId, context)` → `receipt.state.outcome.status` | `durable-agent-session.ts:510-515` | `packages/durable/src/harness/harness.ts:355` |
| `harness.close(context)` | `durable-agent-session.ts:663` | `packages/durable/src/harness/harness.ts` (HarnessImpl, `:209`) |
| `harness.resume()` | `durable-agent-session.ts:676` | `packages/durable/src/harness/types.ts:886`; impl `:303` |
| `root.watch(context)` → `watch.start(call)` / `watch.stop()` | `durable-agent-session.ts:259`, `:321`, `:662` | `packages/durable/src/harness/types.ts:873` |
| `root.submit({ type:"input", content, whenBusy }, context)` | `durable-agent-session.ts:406`, `:416` | `packages/durable/src/harness/types.ts:820` |
| `Submission.wait(context)` / `Submission.abort(context)` | `durable-agent-session.ts:409`, `:417`, `:598` | `packages/durable/src/harness/types.ts` (Submission) |
| `root.abort(context)` | `durable-agent-session.ts:481`, `:486` | `packages/durable/src/harness/types.ts:862` |
| `root.compact(instructions, context)` | `durable-agent-session.ts:509` | `packages/durable/src/harness/types.ts:841` |
| `root.configure(change, context)` — `{model, thinkingLevel}` and `{tools:{remove}}` | `durable-agent-session.ts:159-165`, `:558`, `:562`, `:578-587`, `:618` | `packages/durable/src/harness/agent.ts:90` (`configure`), `:44` (`AgentDoc`) |
| `root.agent(context)` → `.model`, `.thinkingLevel`, `.tools` | `durable-agent-session.ts:167-171`, `:245` | `packages/durable/src/harness/types.ts:808` |
| `root.context(context)` → `.entries` | `durable-agent-session.ts:179` | `packages/durable/src/harness/types.ts:849` |
| `root.entries({order:"descending"}, 16, undefined, context)` | `durable-agent-session.ts:524` | `packages/durable/src/harness/types.ts:851` |
| `root.id` | `durable-agent-session.ts:179`, `:184` | `packages/durable/src/harness/types.ts:804` (Conversation) |
| `ModelRef` (`{provider, modelId}`) | `durable-agent-session.ts:168`, `:557`, `:577`; `harness-setup.ts:88`, `:105`, `:118` | `packages/durable/src/harness/types.ts` |
| `Conversation` (type) | `durable-agent-session.ts:25`, `:144` | `packages/durable/src/harness/types.ts:804` |
| `JsonObject` (durable's) | `durable-agent-session.ts:28`, `:282` | `packages/durable/src/types.ts` |
| `Submission` (type) | `durable-agent-session.ts:31`, `:96` | `packages/durable/src/harness/types.ts` |
| session store file layout `session.sqlite` | `session-location.ts:107` | — |
| session root `~/.pi/agent/experimental/durable-tui-sessions/<hash>` | `session-location.ts:22-26` | — |
| legacy root migration `durable-p1-sessions` → `durable-tui-sessions` | `session-location.ts:38-43` | — |

Transcript hydration (durable entries → pi `SessionManager` chain):
`transcript-rebuild.ts:42` (`entryToSessionEntry`), `:98` (`rebuildTranscript`), producing
`FileEntry[]` consumed at `durable-agent-session.ts:177-188`.

### 4.3 Tool surface

| durable API | consumer site | provider anchor |
|---|---|---|
| `createRegistry()` | `harness-setup.ts:7`, `:56` | `packages/durable/src/harness/registry.ts:112` |
| `Registry.install(extension)` | `harness-setup.ts:57` (CodingTools), `:58` (pi prompt), `durable-agent-session.ts:131` (Subagent), `tool-bridge.ts:199` (mirrored tools) | `packages/durable/src/harness/registry.ts:73` |
| `Registry.snapshot().tools()` | `durable-agent-session.ts:613-614`, `tool-bridge.ts:181-186` | `packages/durable/src/harness/registry.ts:64` |
| `Registry.subscribe(listener)` | `durable-agent-session.ts:250` | `packages/durable/src/harness/registry.ts:68` |
| `CodingTools` (durable's built-in read/write/edit/bash…) | `harness-setup.ts:14` (import), `:57` | `packages/durable/src/tools/index.ts:39` |
| `NodeExecutionEnv` | `harness-setup.ts:13` (import), `:74`, `:83` (`env.cleanup(context)`) | `packages/durable/src/env/node.ts:612` |
| `EnvTarget` | `harness-setup.ts:8`, `:71` | `packages/durable/src/harness/types.ts` |
| `defineExtension` | `harness-setup.ts` n/a; `prompt.ts:4`, `:72`; `subagent.ts:11`, `:30`; `tool-bridge.ts:27`, `:99` | `packages/durable/src/harness/define.ts:15` |
| `defineTool` (parameters = plain JSON Schema since 1.5.0) | `subagent.ts:12`, `:33`, `:37` | `packages/durable/src/harness/define.ts:22` |
| `section(key, fn, { tag:false })` | `prompt.ts:4`, `:75` | `packages/durable/src/harness/define.ts:29` |
| `ToolRegistration` (`name`,`description`,`parameters`,`prepareArguments`,`replay:"unsafe"`) | `tool-bridge.ts:27`, `:105-113`; `durable-agent-session.ts:32`, `:235-241`, `:604-611` | `packages/durable/src/harness/types.ts` |
| `ToolExecutionApi` (`commit`, `output`, `details`, `conversation`, `taskId`) | `tool-bridge.ts:26`, `:114`, `:122`, `:129`; `subagent.ts:15`, `:19`, `:41`, `:49`, `:50` | `packages/durable/src/harness/types.ts` |
| `ToolExecutionResult` (`output`, `isError`, `details`, `usage`, `control.terminate`) | `tool-bridge.ts:26`, `:114`, `:143-149` | `packages/durable/src/harness/types.ts` |
| durable hook task `"pi.tool"` (`beforeTool`) | `tool-bridge.ts:102`, `:67-97` | `packages/durable/src/harness/define.ts` / `harness/types.ts` (`HookRegistration`) |
| `configure(tx, conversationId, { extensions: { remove: [...] } })` | `subagent.ts:10`, `:46` | `packages/durable/src/harness/agent.ts:90` |
| `AssistantEntry` | `subagent.ts:9`, `:20` (`tx.entry(AssistantEntry, answer)`) | `packages/durable/src/entries.ts:17` |
| `EntryId` | `subagent.ts:13`, `:19` | `packages/durable/src/types.ts` |
| `Extension` (durable's) | `subagent.ts:14`, `:30`; `tool-bridge.ts:27`, `:99` | `packages/durable/src/harness/types.ts` |
| `tx.scanConversations({ ownerTaskId }, 1)` | `subagent.ts:42` | `packages/durable/src/types.ts` (Tx) |
| `tx.createConversation({ ownership: { kind:"task", taskId } })` | `subagent.ts:45` | `packages/durable/src/types.ts` |
| `api.conversation(child, context)` → `handle.submit(request, context)` → `.wait(context)` | `subagent.ts:50-52` | `packages/durable/src/harness/types.ts:164` (ConversationHandle) |
| durable tool result channel is `output` (was `content` in 1.2) | `subagent.ts:57-58`, `tool-bridge.ts:143-144` | — |

Note the two host systems bridged: stable extension tools are mirrored into the durable registry
(`tool-bridge.ts:199`), and durable tool calls are forwarded back as stable `tool_call` extension
events (`tool-bridge.ts:86-95`).

### 4.4 Config / settings surface

| surface | consumer site | durable anchor |
|---|---|---|
| `HarnessSettings` (`stream`, `compaction`, `retry`, `steeringMode`, `followUpMode`) built from pi's `SettingsManager` | `harness-setup.ts:9`, `:28-52`; passed at `durable-agent-session.ts:137` | `packages/durable/src/harness/types.ts` |
| `PromptInput` (`input.env?.cwd`, `input.agent.cwd`, `input.agent.tools`) | `prompt.ts:4`, `:44`, `:53-55` | `packages/durable/src/harness/types.ts` |
| durable `pi-prompt` extension sections (preamble/tools/rules/docs/project_context/skills/cwd) | `prompt.ts:23`, `:72-76` | `packages/durable/src/harness/define.ts:29` |
| `pi.agent` document read (`view.docs["pi.agent"]`) | `durable-agent-session.ts:313` | `packages/durable/src/harness/agent.ts:44` |
| `pi.live` document read | `event-adapter.ts:58`, `durable-agent-session.ts:329` | `packages/durable/src/harness/live.ts` |
| extension selection file `~/.pi/agent/durable-tui-extensions.json`; override env `PI_DURABLE_EXT_CONFIG` | `extension-picker.ts:19`, `:21`, `:59-62` | — (fork-level config) |
| current-session env `PI_DURABLE_SESSION_ID` | `session-meta.ts:38-39`, read at `sessions-extension.ts:62` | — |
| pi-tui capability overrides | `main.ts:14`, `:209` (`setCapabilityOverrides`) | `@earendil-works/pi-tui` (not durable) |

### 4.5 Non-durable pi-family coupling (adjacent surface)

These are not pi-durable, but they are the same "pi ecosystem" surface and move with upstream:

- `@earendil-works/pi-ai`: `durable-agent-session.ts:22-23` (`Model`, `ModelThinkingLevel`,
  `clampThinkingLevel`), `event-adapter.ts:10-16` (`AssistantMessage`, `AssistantMessageEvent`,
  `Message`, `ToolResultMessage` from `pi-ai/compat`), `subagent.ts:7`, `headless-session.ts:13`.
- `@earendil-works/pi-agent-core`: `durable-agent-session.ts:21`, `event-adapter.ts:9`,
  `headless-session.ts:12`, `transcript-rebuild.ts:15` (`AgentEvent`, `AgentMessage`, `ThinkingLevel`).
- `@earendil-works/pi-tui`: `activity-panel.ts:28` (`Container`, `Text`, `TUI`,
  `truncateToWidth`, `wrapTextWithAnsi`), `main.ts:14` (`setCapabilityOverrides`).
- `@earendil-works/chord`: `durable-agent-session.ts:20` (`BACKGROUND_CONTEXT` from
  `chord/context`), `harness-setup.ts:4`, `subagent.ts:6`, `tool-bridge.ts:25` (`Context`, `JsonValue`).
- `typebox`: `subagent.ts:17` (`Type`) — direct import because pi-ai 1.5.0 no longer re-exports
  `Type` (commit `fa079b349`, and `CHANGELOG.md` 0.11.0 "Fixed" section).
- Upstream **coding-agent internals** (relative imports, i.e. the fork depends on upstream
  private shape): `core/agent-session.ts`, `core/agent-session-services.ts`,
  `core/agent-session-runtime.ts`, `core/session-manager.ts`, `core/compaction/compaction.ts`,
  `core/extensions/types.ts`, `core/settings-manager.ts`, `core/model-runtime.ts`,
  `core/model-resolver.ts`, `core/resource-loader.ts`, `core/system-prompt.ts`,
  `core/tools/{bash,edit,read,write}.ts`, `core/http-dispatcher.ts`, `core/source-info.ts`,
  `modes/interactive/interactive-mode.ts`, `modes/interactive/theme/*`, `config.ts`, `utils/sleep.ts`.
- **Private-seam dependency (highest fragility):** `headless-session.ts:24-38` reaches into
  `AgentSession` privates (`_handleAgentEvent`, `_emit`, `_emitQueueUpdate`, `_steeringMessages`,
  `_followUpMessages`, `_runInputHandlers`, `_entryIdsByMessage`, `_tryExecuteExtensionCommand`),
  and `durable-agent-session.ts:634-640` pokes `services.resourceLoader.additionalExtensionPaths`.
  Both are documented as upstream-shape assumptions
  (`headless-session.ts:1-10`, `durable-agent-session.ts:636-638`).

---

## 5. Upstream delta facts relevant to a possible adaptation

Base state: the fork merged upstream **v1.5.0** on 2026-11-03 (`939fd2085`), and its 0.11.0
changelog documents the two durable-tui fixes that sync required
(`CHANGELOG.md` "0.11.0" section): the event-adapter rebuild (durable 1.5 removed
`watchEvents`/AgentEvent stream, spec §9.4) and the typebox `Type` import.

Upstream today: `earendil-works/pi` latest release **v1.5.2 (2026-11-10)**; v1.5.1 (2026-11-09).
`gh release list --repo earendil-works/pi` output: v1.5.2, v1.5.1, v1.5.0, …

Durable package changelog (read from GitHub at the tags):

- **durable 1.5.1** (`packages/durable/CHANGELOG.md` @ v1.5.1):
  - Added `Tx.submission(id)` — reads a committed submission record by ID.
  - Added **per-conversation compaction settings**: `configure({ compaction })` stores a
    `CompactionSettings` in `pi.agent`, inherited by children and forks.
  - Added JSONL read-only open (`{ readOnly: true }`).
  - Changed `SqliteStorage.commit()` to fewer round trips (behavioral/perf).
  - Fixed: `tool_search` `$ref` lookup; a task stuck `waiting` when the last waited-for task
    ended during a scheduler pass; codemode `URI malformed` on malformed `$ref` percent escapes.
- **durable 1.5.2**: the changelog contains the `## [1.5.2] - 2026-11-10` heading with **no
  entries** — i.e. no durable-side change recorded.

Coding-agent package changelog:

- **1.5.1**: breaking change — custom `GrepOperations.readFile` callbacks are no longer called for
  context lines (field deprecated but accepted). New: Anthropic message threads, idle prompt cache
  warming, Mermaid pie charts, `pi update --extensions`, `pi auth login/logout`, etc.
- **1.5.2**: when a session's working directory no longer exists, interactive mode now offers
  Continue / **Fork** / Cancel at startup (`--session`, `--resume`), `/resume`, `/import`, and
  `ctx.switchSession()` (PR #11975).

Interaction points that are facts about the fork, not judgments:

1. durable-tui's runtime factory handles resume/fork explicitly and **refuses** fork:
   `main.ts:227-248` — `reason === "resume"` → `durableIdFromCarrierPath`; `reason === "fork"` →
   `throw new Error("durable-tui: cross-store fork is not supported yet (planned)")` (`main.ts:241-243`).
   Upstream 1.5.2 adds a user-visible Fork option in the missing-folder flow.
2. durable-tui's compaction override computes compaction with **pi's** `prepareCompaction` and then
   calls `root.compact(...)` (`durable-agent-session.ts:488-553`); durable 1.5.1's new per-conversation
   `configure({ compaction })` is **not used** anywhere in the durable-tui tree (no `compaction`
   key in any `root.configure` call — sites `:159-165`, `:558`, `:562`, `:578-587`, `:618`).
3. durable-tui's subagent tool uses `tx.scanConversations({ ownerTaskId })` (`subagent.ts:42`);
   durable 1.5.1 added `Tx.submission(id)` as a cheaper way to locate a run's inputs.
4. The fork already had to react to durable 1.5.0's breaking `Storage.commit()` batch API and to
   `typebox` removal from durable — both handled inside the fork layer, upstream files untouched
   (`AGENTS.md:148`, R4 constraint: prefer new files, do not modify upstream).

---

## 6. Explicitly unverified

- Whether the released archive actually resolves `@earendil-works/chord@1.1.0` at runtime (the
  bundle's external set was read, but the built bundle was not inspected).
- Whether the local checkout equals the remote tip: no `git fetch` was performed (read-only
  constraint). Local HEAD date 2026-11-03 matches `gh` `pushedAt 2026-11-03T05:47:17Z`.
- Whether upstream v1.5.1/v1.5.2 changed any coding-agent **private** member that
  `headless-session.ts` depends on — the upstream changelog for 1.5.1/1.5.2 lists no such
  change, but a diff of `core/agent-session.ts` was not performed.
- Whether `packages/durable` 1.5.1/1.5.2 changed the **shape** of `LiveState`, `ConversationView`,
  `ToolSlot`, or `EntryRecord` — the 1.5.1 changelog does not mention them, but no source diff
  against v1.5.0 was performed.
- The upstream `pi` release notes for 1.5.1/1.5.2 were read via `gh`; the full upstream
  `packages/durable/CHANGELOG.md` beyond the 1.5.0 entry was not diffed line by line.
