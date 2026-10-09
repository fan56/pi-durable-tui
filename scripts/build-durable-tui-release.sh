#!/usr/bin/env bash
#
# Fork layer: build the self-contained `pi-durable-tui` release archive.
#
# WHY NOT A BUN BINARY: upstream build-binaries.sh compiles a single-file
# executable with `bun build --compile`. That route is closed to durable-tui —
# its conversation store is backed by Node's built-in `node:sqlite`
# (@earendil-works/pi-durable/storage/sqlite/node), which Bun does not
# implement ("No such built-in module: node:sqlite" at runtime). The archive
# therefore ships the esbuild bundle plus the three runtime packages the bundle
# deliberately leaves external, and runs on stock Node.
#
# Usage:
#   ./scripts/build-durable-tui-release.sh [--skip-build] [--out <dir>] [--platform <name>]
#
# Options:
#   --skip-build       Reuse the existing dist/ (rebuild only the bundle)
#   --out <dir>        Output directory (default: release/)
#   --platform <name>  darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
#                      (default: the host platform)
#
# Output:
#   <out>/pi-durable-tui-<version>-<platform>.tar.gz
#   <out>/pi-durable-tui-<version>-<platform>.tar.gz.sha256
#
# The archive unpacks to a directory containing:
#   pi-durable-tui        launcher (node ./bundle/durable-tui.js)
#   bundle/               esbuild output; every dependency except the three
#                         externals below is inlined here
#   package.json          pins those three runtime dependencies
#   README.md             install + usage
#   CHANGELOG.md
#
# Install: unpack, run `npm install --omit=dev` inside, then ./pi-durable-tui

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_BUILD=false
OUTPUT_DIR="release"
PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-build) SKIP_BUILD=true; shift ;;
        --out) OUTPUT_DIR="$2"; shift 2 ;;
        --platform) PLATFORM="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) host_platform="darwin-arm64" ;;
    Darwin-x86_64) host_platform="darwin-x64" ;;
    Linux-x86_64) host_platform="linux-x64" ;;
    Linux-aarch64) host_platform="linux-arm64" ;;
    *) echo "Unsupported host: $(uname -s)-$(uname -m)"; exit 1 ;;
esac
PLATFORM="${PLATFORM:-$host_platform}"
case "$PLATFORM" in
    darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;;
    *) echo "Invalid platform: $PLATFORM"; exit 1 ;;
esac

if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    echo "==> Building all workspace packages..."
    npm run build
else
    echo "==> Skipping workspace build (--skip-build)"
    echo "==> Recompiling the experimental durable-tui tree..."
    npx tsc -p packages/coding-agent/tsconfig.build.durable.json
    echo "==> Rebuilding the coding-agent bundle..."
    node scripts/build-coding-agent-bundle.mjs
fi

# The fork's own version line, deliberately independent of upstream pi's 1.x:
# the feature set this archive packages is the one the durable-tui README calls
# "v0.6". Keeping it in VERSION (not packages/coding-agent/package.json) means
# an upstream version bump never collides with this fork's releases.
VERSION="$(tr -d '[:space:]' < VERSION)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

BUNDLE_DIR="$STAGE/pi-durable-tui"
mkdir -p "$BUNDLE_DIR"
cp -r packages/coding-agent/dist/bundle "$BUNDLE_DIR/bundle"

# The runtime packages the bundle keeps external (see allowedExternalPackages in
# scripts/build-coding-agent-bundle.mjs). Keep this list in sync with that set:
# shipping a missing one breaks the launch with ERR_MODULE_NOT_FOUND.
cat > "$BUNDLE_DIR/package.json" <<EOF
{
	"name": "pi-durable-tui",
	"version": "${VERSION}",
	"private": true,
	"description": "Experimental early-access coding agent: the stable pi TUI on the durable runtime",
	"type": "module",
	"license": "MIT",
	"engines": { "node": ">=24.0.0" },
	"dependencies": {
		"@earendil-works/chord": "1.1.0",
		"@silvia-odwyer/photon-node": "0.3.4",
		"jiti": "2.7.0"
	}
}
EOF

# Launcher. Mirrors the local pi-durable-tui wrapper's contract, but resolves
# relative to its own directory so the archive is relocatable.
cat > "$BUNDLE_DIR/pi-durable-tui" <<'EOF'
#!/usr/bin/env node
// pi-durable-tui — the stable pi TUI on the durable runtime.
//
// Dynamic import, not createRequire: the runtime graph has top-level await,
// which require() rejects with ERR_REQUIRE_ASYNC_MODULE.
import { enableCompileCache } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

enableCompileCache();
const here = dirname(fileURLToPath(import.meta.url));
import(join(here, "bundle", "durable-tui.js"));
EOF
chmod +x "$BUNDLE_DIR/pi-durable-tui"

cp README-FORK.md "$BUNDLE_DIR/README.md"
cp CHANGELOG.md "$BUNDLE_DIR/CHANGELOG.md" 2>/dev/null || true
cp packages/coding-agent/CHANGELOG.md "$BUNDLE_DIR/UPSTREAM-CHANGELOG.md" 2>/dev/null || true
cp LICENSE "$BUNDLE_DIR/LICENSE" 2>/dev/null || true

# Ship a lockfile so the install is reproducible without network resolution
# guesswork. `npm install --package-lock-only` writes it in place — only the
# manifest is kept, no node_modules is materialized.
( cd "$BUNDLE_DIR" && npm install --package-lock-only --omit=dev --no-audit --no-fund >/dev/null )

ARCHIVE="pi-durable-tui-${VERSION}-${PLATFORM}.tar.gz"
mkdir -p "$OUTPUT_DIR"
tar -czf "$OUTPUT_DIR/$ARCHIVE" -C "$STAGE" pi-durable-tui

if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$OUTPUT_DIR" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256" )
else
    ( cd "$OUTPUT_DIR" && shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256" )
fi

echo "==> Done."
ls -lh "$OUTPUT_DIR/$ARCHIVE"
cat "$OUTPUT_DIR/$ARCHIVE.sha256"
