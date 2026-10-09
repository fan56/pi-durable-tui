Experimental early-access build of the durable coding agent.

The official durable coding agent is in development; this is a preview that runs
the stable pi TUI on the durable runtime. See the README in the archive for what
works and what is not wired yet.

Requires Node >= 24. The durable store uses `node:sqlite`, which Bun does not
implement — that is why this ships a bundle rather than a single-file binary.

**Install:** unpack the archive for your platform, then `npm install --omit=dev`
and `./pi-durable-tui`.

Assets: darwin-arm64, darwin-x64, linux-x64, linux-arm64. `SHA256SUMS` covers
all four.
