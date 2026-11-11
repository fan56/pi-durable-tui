# Verdict: does pi-durable-tui need to adapt after upstream 1.5.1 / 1.5.2 — now or later?

Date: 2026-11-11
Role: review/judgment pass over the two companion research docs, with independent
re-verification of the facts that drive the decision.

- Companion docs (relocated to this directory per AGENTS.md:147):
  `2026-11-11-pi-durable-updates.md` (upstream delta), `2026-11-11-pi-durable-tui-inventory.md`
  (fork coupling surface).
- Baseline under review: fork `v0.11.0` = upstream `v1.5.0` merge `939fd2085`, zero commits since.

---

## 0. Verdict

**Do nothing now. Adaptation is not urgent and should be bound to the next upstream sync
(when a `sync/upstream-v1.5.x` branch is created), not done today.**

Three-part conclusion per the task's framing:

- **(a) Do now: nothing.** Nothing in released 1.5.1/1.5.2 can reach this fork without a merge.
  The current tree typechecks clean (`tsc -p tsconfig.build.durable.json --noEmit` → exit 0,
  run today). Fresh installs cannot resolve any pi-family package above 1.5.0 (§3). Users run
  self-contained archives inlined at build time (§4).
- **(b) Can wait — this is the bucket for the 1.5.1/1.5.2 sync work.** Trigger condition:
  starting the next upstream sync. The full change list is 3 import-path lines + 1 behavioral
  decision (§5). Two of the three lines cannot even be landed today (`/json` subpath does not
  exist in chord 1.5.0 — proven below), which is further evidence this belongs in the sync PR,
  not ahead of it.
- **(c) Not needed:** zero fork changes are required by durable 1.5.1's only signature change
  (`compactionPolicy` — never called in the fork tree, grep zero hits), by the event/view
  surfaces (unchanged 1.5.0→1.5.2), or by coding-agent 1.5.1's `GrepOperations.readFile`
  breaking change (the fork never overrides Grep/Read operations; grep
  `GrepOperations|ReadOperations` in `src/experimental/durable-tui/` → zero hits; only
  `node:fs/promises` readFile calls exist).

**Suspendable-work wave (unreleased, `473515f9c`): wait for the release tag. Do not track
`main`.** Strategy in §6.

---

## 1. Fact-check of the "known key facts" (independent re-verification)

Everything below was re-verified today from primary sources, not taken from the docs.

### 1.1 Chord root-import breakpoints — CONFIRMED, now with compiled proof

- Fork sites (exact lines re-read):
  - `packages/coding-agent/src/experimental/durable-tui/harness-setup.ts:4` —
    `import type { Context } from "@earendil-works/chord"`
  - `packages/coding-agent/src/experimental/durable-tui/subagent.ts:6` — same
  - `packages/coding-agent/src/experimental/durable-tui/tool-bridge.ts:25` —
    `import type { JsonValue } from "@earendil-works/chord"`
  - `durable-agent-session.ts:20` already imports from `@earendil-works/chord/context` —
    unaffected. These are the only 4 chord imports in the 17-file tree (grep).
- chord 1.5.0 (workspace copy) root DOES export both:
  `packages/chord/dist/index.d.ts:3` (`Context`), `:10` (`JsonValue`). Current tree compiles
  because of this.
- chord 1.5.2 (npm tarball `npm pack @earendil-works/chord@1.5.2`) root `dist/index.d.ts`
  contains zero occurrences of `Context` or `JsonValue`; `Context` and `BACKGROUND_CONTEXT`
  live in `dist/context/index.d.ts:9,15`; `JsonValue` lives in `dist/json.d.ts:1`
  (exports-map subpath `./json`).
- **Compiled proof** (read-only, outside the repo): a probe project in `/tmp` with
  `node_modules/@earendil-works/chord` = the 1.5.2 tarball, containing byte-identical imports
  to the fork's three sites, fails with exactly:
  ```
  probe.ts(2,15): error TS2305: Module '"@earendil-works/chord"' has no exported member 'Context'.
  probe.ts(3,15): error TS2305: Module '"@earendil-works/chord"' has no exported member 'JsonValue'.
  ```
  The same probe against the workspace chord 1.5.0 exits 0. And
  `import ... from "@earendil-works/chord/json"` against chord 1.5.0 fails with
  `TS2307: Cannot find module '@earendil-works/chord/json'` — the `./json` subpath does not
  exist in 1.5.0's exports map. **Consequence: the JsonValue fix cannot land before the merge;
  a partial pre-fix (Context → `/context`, which exists in both versions) is possible but
  pointless. Land all three in the sync PR.**
- Break arrival mechanism: `packages/durable/package.json:161` pins
  `"@earendil-works/chord": "1.5.0"` (exact, same-version pin upstream maintains), so merging
  upstream 1.5.1+ flips the workspace chord under the fork in the same merge — there is no
  state where durable is 1.5.x but chord stays 1.5.0.

### 1.2 Undeclared dependencies in packages/coding-agent — CONFIRMED, and it is airtight today

- `packages/coding-agent/package.json` `dependencies` (lines 43–66) list
  `pi-agent-core/pi-ai/pi-codemode/pi-mcp/pi-tui` all exact `"1.5.0"` — and **no**
  `@earendil-works/pi-durable`, **no** `@earendil-works/chord`.
- Resolution is via npm-workspace symlinks:
  `node_modules/@earendil-works/chord -> ../../packages/chord`,
  `node_modules/@earendil-works/pi-durable -> ../../packages/durable` (verified `ls -la`).
- The only other declarers of these two packages in the whole repo are workspace members with
  exact pins: `packages/env/package.json:48-49` (`chord 1.5.0`, `pi-durable 1.5.0`) and
  `packages/durable/package.json:161`. No range (`^`/`~`) anywhere.

### 1.3 "npm latest = 1.5.2" resolution risk — CONFIRMED HARMLESS for every real install path

This was the decisive question ("does a fresh install explode?"). Answer: **no, by mechanism,
on all three install paths.**

1. **Dev/CI path (`npm ci --ignore-scripts`, used by both fork workflows —
   `.github/workflows/durable-tui-ci.yml:48`, `durable-tui-release.yml:58`):**
   `package-lock.json` contains only workspace-link entries for the two packages
   (`node_modules/@earendil-works/chord` / `pi-durable` with `"resolved": "packages/..."`
   link form; zero `registry.npmjs.org/@earendil-works/chord|pi-durable` URLs in the lock).
   `npm ci` installs the lock verbatim → workspace 1.5.0, always.
2. **Plain `npm install` path:** resolution only consults the registry for packages *declared*
   with a range. No non-workspace declaration exists (§1.2); workspace members always win when
   versions satisfy, and the pins are exact matches. Nothing can float to 1.5.2.
3. **User path:** users install the self-contained release archive (or clone + `npm ci` +
   build). The archive inlines the entire pi family — see §4; no user-side npm resolution of
   pi-durable/chord occurs at all.
4. `pnpm install` is not a real path here (no `pnpm-workspace.yaml`; `pnpm` in root
   `devDependencies` is upstream tooling). Even if run, pnpm links workspace members the same
   way; versions come from `packages/*/package.json`, i.e. 1.5.0.

**The only event that can move chord/durable under this fork is a merge that bumps
`packages/*/package.json` — which is exactly when the §5 fix list lands. There is no
"silent float" scenario. The undeclared-dependency oddity is hygiene debt, not a live risk.**

Caveat for the future sync PR: if someone "fixes" §1.2 by adding
`"@earendil-works/pi-durable": "^1.5.0"` to `packages/coding-agent/package.json`, THAT would
create the float risk that does not exist today. If declaring, use exact pins
(`"1.5.x"` style, matching the existing pi-family entries) or leave workspace resolution as is.

### 1.4 Spot-checks of the two companion docs

- `2026-11-11-pi-durable-updates.md`: every load-bearing claim I re-tested held (§5.1 line
  numbers exact; chord exports map; npm latest; compactionPolicy 3-arg claim consistent with
  the fork's zero usage). **Gap**: it never analyzes install-time resolution (§1.3 here) —
  that is the question that decides urgency, now answered.
- `2026-11-11-pi-durable-tui-inventory.md`: held on all spot-checks. Its one "unverified"
  item — "whether the released archive actually resolves `@earendil-works/chord@1.1.0` at
  runtime" — is now **resolved: it does not** (§4).

---

## 2. Why staying on 1.5.0 is safe today (risk analysis)

- Build: baseline typecheck passes (exit 0, `tsc --noEmit --incremental false`).
- CI green through 2026-11-10 (durable-tui-ci runs 11-07..11-10 `success`; npm audit green).
- No external consumer can pull a different pi-family version into this build (§1.3).
- Cost of standing still (real but non-urgent): the fork misses durable 1.5.1 fixes
  (scheduler notification loss `e50dc7af9` / #11892; SQLite commit batching `fabf916fc`)
  and coding-agent fixes behind 373+22 commits. None is a known fork bug.
- Unchanged surfaces the fork depends on: `ConversationView` / `LiveState` / `ToolSlot` /
  `EntryRecord` / `Harness.open` — identical 1.5.0→1.5.2 apart from chord import specifiers
  (companion doc's tarball diff; I verified the same tarballs exist and spot-checked the
  direction via the 1.5.2 chord tarball and the workspace 1.5.0 copy).

## 3. Release-archive `chord 1.1.0` anomaly — resolved: dead manifest entry

`scripts/build-durable-tui-release.sh:135` writes `"@earendil-works/chord": "1.1.0"` into the
archive manifest, while the bundle build inlines everything except
`allowedExternalPackages` (`scripts/build-coding-agent-bundle.mjs:18-30` — chord not in the
set) and **hard-fails the build if any unexpected external remains** (`:111-119`). Therefore
chord is inlined into the bundle; the archive's node_modules chord copy is never loaded.
Corroborated by the CI "Install and launch" step (`durable-tui-ci.yml:77-90`) which installs
and starts the packed archive successfully. The `1.1.0` string is misleading hygiene debt —
suggest deleting or syncing it at the next sync PR (suggestion-level, zero runtime effect).

## 4. Minimal change list for the next sync (v1.5.1+ merge)

Compile fixes (mechanical, proven in §1.1):

1. `packages/coding-agent/src/experimental/durable-tui/harness-setup.ts:4` →
   `import type { Context } from "@earendil-works/chord/context";`
2. `packages/coding-agent/src/experimental/durable-tui/subagent.ts:6` → same as 1.
3. `packages/coding-agent/src/experimental/durable-tui/tool-bridge.ts:25` →
   `import type { JsonValue } from "@earendil-works/chord/json";`
   (only valid once workspace chord ≥ 1.5.1; TS2307 on 1.5.0 — proven)

Behavioral decision (not a break, decide during sync testing):

4. Upstream 1.5.2's missing-cwd flow (PR #11975, `4ea883792`) can now present a **Fork**
   option on paths that reach the fork's runtime factory, which throws on
   `reason === "fork"` (`main.ts:241-243`). Users hitting Fork will see that error. Either
   accept it for now, or map fork → new-session with a notice. Whether upstream exposes a way
   to suppress the Fork choice: **unverified**. The carrier-path `ctx.switchSession` in
   `sessions-extension.ts:94` now flows through the new Continue/Fork/Cancel prompt; its
   interaction with the carrier-path trick is **unverified** — exercise it in sync testing.

Explicitly NOT needed at that sync: `compactionPolicy` (fork never calls it), event/view
shapes, `GrepOperations.readFile`, `"tools": []` omission, `Tx.submission` (optional
optimization for `subagent.ts:42` only).

## 5. Suspendable-work wave (unreleased `473515f9c`): wait for the tag

- Hits at the sync **after** next: `event-adapter.ts:23` (`SlotTrack.status` union — upstream
  `main` `packages/durable/src/harness/live.ts:25` now
  `"pending" | "running" | "sleeping" | "waiting" | "done"`, verified via `gh api` today) and
  `tool-bridge.ts:114` (`execute()` may return `ToolPark`; annotation must widen; wrappers
  cannot park).
- Strategy: **adapt at the release-tag sync, never against `main`.** Reasons: (1) the 42
  unreleased commits are dominated by `apps/p2` prototype churn that self-declares
  "gone soon / unsupported"; (2) `pi.tool` v4 / `pi.generation` v3 are version-gated — older
  harnesses block v4 tasks, so pre-adapting buys nothing and tests nothing; (3) the fork's
  value proposition is a stable line on released durable; tracking main would couple it to
  an unfrozen API. When that tag ships, the work is: widen `SlotTrack.status`, define adapter
  behavior for parked slots (upstream: a parked slot "holds no output" — render semantics
  undefined in this adapter today), widen `execute()` return type, run the two
  `durable-tui-*.test.ts` suites.

## 6. What I ran (all read-only)

- Reads/greps of the files cited above; `ls -la node_modules/@earendil-works/`;
  lockfile inspection via `python3` JSON walk; `npm view` (pi-durable latest=1.5.2,
  pi-coding-agent latest=1.5.2, chord exports map); `npm pack @earendil-works/chord@1.5.2`
  into `/tmp/verify-chord/` (tarball grep + probe compiles);
  `gh api repos/earendil-works/pi/contents/.../live.ts?ref=main`.
- One compile of the repo itself: `npx tsc -p packages/coding-agent/tsconfig.build.durable.json
  --noEmit --incremental false` → exit 0 (no writes).
- Filesystem writes: this document, and `git mv` of the two companion docs into
  `docs/research/` (placement correction per AGENTS.md:147). No code, no commit, no publish.
