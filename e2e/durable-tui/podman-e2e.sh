#!/bin/bash
# podman harness for the durable-tui e2e suite: builds the e2e image and runs
# the whole tmux suite inside ONE container (the suite is the container
# command, so the tmux server lives for the entire run — separate podman execs
# would not share it).
#
# Usage: e2e/durable-tui/podman-e2e.sh [scenario...]
#   scenario names pass through to run.sh (e.g. `boot`, `boot tool`).
#   --keep is accepted but ignored: the lab dir lives and dies with the
#   container, there is nothing on the host to preserve.
#
# Environment:
#   DEEPSEEK_API_KEY                passed into the container when set
#   PODMAN_E2E_IMAGE                image tag (default pi-durable-e2e:latest)
#   PODMAN_E2E_GLOBAL_SETTINGS=1    also mount ~/.pi/agent/settings.json plus
#                                   every existing local dir it references
#                                   (default off: the lab project settings are
#                                   self-sufficient, and a read-only mount of
#                                   the global settings file can break the
#                                   agent's settings-lock/write path)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${PODMAN_E2E_IMAGE:-pi-durable-e2e:latest}"
LOG="${TMPDIR:-/tmp}/pi-durable-e2e-podman.$$.log"

# --- args: scenario filters pass through, --keep is dropped -----------------
ARGS=()
for a in "$@"; do
	case "$a" in
		--keep) echo "note: --keep ignored under podman (lab dir dies with the container)" ;;
		*) ARGS+=("$a") ;;
	esac
done

# --- mounts -------------------------------------------------------------------
# Required: deepseek credentials (read-only single-file mount; the rest of
# /root/.pi/agent stays writable container storage for the durable sessions root).
AUTH_SRC="$HOME/.pi/agent/auth.json"
if [ ! -f "$AUTH_SRC" ]; then
	echo "FATAL: $AUTH_SRC not found — the suite needs deepseek credentials" >&2
	exit 2
fi
VOL=(-v "$AUTH_SRC:/root/.pi/agent/auth.json:ro")

# Footer fixture: run.sh SKIPs the footer scenario without it, so mount it when
# present. Target path mirrors run.sh's $HOME/repo/pi-powerline-footer lookup.
FOOTER_SRC="$HOME/repo/pi-powerline-footer"
if [ -f "$FOOTER_SRC/index.ts" ]; then
	VOL+=(-v "$FOOTER_SRC:/root/repo/pi-powerline-footer:ro")
else
	echo "note: $FOOTER_SRC missing — footer scenario will SKIP"
fi

# Opt-in: full global-settings fidelity (see header). Entries in settings.json
# `packages` are host paths relative to ~/.pi/agent; mount the ones that exist.
if [ "${PODMAN_E2E_GLOBAL_SETTINGS:-0}" = "1" ]; then
	SETTINGS_SRC="$HOME/.pi/agent/settings.json"
	if [ -f "$SETTINGS_SRC" ]; then
		VOL+=(-v "$SETTINGS_SRC:/root/.pi/agent/settings.json:ro")
		PKGS="$(node -e '
			const fs = require("fs"), path = require("path");
			try {
				const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
				for (const p of s.packages || []) {
					if (typeof p === "string" && (p.startsWith(".") || p.startsWith("/"))) {
						const abs = path.resolve(process.argv[2], p);
						if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) console.log(abs);
					}
				}
			} catch {}
		' "$SETTINGS_SRC" "$HOME/.pi/agent")"
		while IFS= read -r d; do
			[ -n "$d" ] || continue
			echo "note: global extension mounted: $d"
			VOL+=(-v "$d:/root/repo/$(basename "$d"):ro")
		done <<EOF
$PKGS
EOF
	else
		echo "note: PODMAN_E2E_GLOBAL_SETTINGS=1 but $SETTINGS_SRC missing — nothing extra mounted"
	fi
fi

ENVARGS=()
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
	ENVARGS+=(-e DEEPSEEK_API_KEY)
fi

# --- build (cached; source changes invalidate the COPY layer, not npm ci) ----
# The base image must exist locally: registry-1.docker.io is DNS-poisoned on
# this network, so builds run with --pull-never and fail loudly here instead.
BASE="docker.io/library/node:24-bookworm-slim"
if ! podman image exists "$BASE"; then
	echo "FATAL: base image $BASE not in local storage. Bootstrap it once from a" >&2
	echo "reachable mirror, then retag (docker.io is unreachable from this network):" >&2
	echo "  podman pull docker.m.daocloud.io/library/node:24-bookworm-slim" >&2
	echo "  podman tag docker.m.daocloud.io/library/node:24-bookworm-slim $BASE" >&2
	exit 2
fi
echo "==> podman build $IMAGE"
podman build --pull-never \
	--ignorefile "$REPO_ROOT/e2e/durable-tui/.containerignore" \
	-t "$IMAGE" -f "$REPO_ROOT/e2e/durable-tui/Containerfile" "$REPO_ROOT"

# --- run: one container, suite as the command --------------------------------
echo "==> podman run: bash e2e/durable-tui/run.sh ${ARGS[*]:-(full suite)}"
# PODMAN_E2E_KEEP=1 keeps the stopped container for post-mortem (evidence
# lives inside the container FS; `podman cp` chokes on its /tmp symlinks, so
# dig evidence out with `podman export <name> -o x.tar`).
RMFLAG=(--rm)
[ "${PODMAN_E2E_KEEP:-0}" = "1" ] && RMFLAG=(--name pi-durable-e2e-debug)
# Keeping the container only pays off if the lab survives run.sh's EXIT trap,
# so forward --keep to the suite (its own --keep handling is what preserves
# $LAB for podman export).
if [ "${PODMAN_E2E_KEEP:-0}" = "1" ]; then
	case " ${ARGS[*]-} " in *" --keep "*) ;; *) ARGS+=(--keep) ;; esac
fi
podman run "${RMFLAG[@]}" \
	"${VOL[@]+"${VOL[@]}"}" \
	"${ENVARGS[@]+"${ENVARGS[@]}"}" \
	"$IMAGE" \
	bash e2e/durable-tui/run.sh ${ARGS[@]+"${ARGS[@]}"} 2>&1 | tee "$LOG"
rc="${PIPESTATUS[0]}"

echo
echo "==> suite exit: $rc (full log: $LOG)"
echo "==> summary tail:"
tail -n 12 "$LOG"
exit "$rc"
