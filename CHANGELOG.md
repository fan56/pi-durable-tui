# Changelog

All notable changes to the `pi-durable-tui` early-access builds.

This is a fork layer on top of [`earendil-works/pi`](https://github.com/earendil-works/pi).
Upstream releases are tracked in that repository's changelog, which ships inside
each release archive as `UPSTREAM-CHANGELOG.md`.

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
