# Changelog

All notable changes to the `pi-durable-tui` early-access builds.

This is a fork layer on top of [`earendil-works/pi`](https://github.com/earendil-works/pi).
Upstream releases are tracked in that repository's changelog, which ships inside
each release archive as `UPSTREAM-CHANGELOG.md`.

## [0.6.0] — 2026-10-09

> First packaged early-access build. Version follows the fork's own line
> (`packages/coding-agent/src/experimental/durable-tui/README.md` calls the
> feature set "v0.6"), not upstream pi's 1.x.

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
