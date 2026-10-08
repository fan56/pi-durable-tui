#!/bin/bash
# e2e for durable-p1: drives the real TUI in tmux through the acceptance
# scenarios (real model via ~/.pi/agent/auth.json or DEEPSEEK_API_KEY).
# Usage: e2e/durable-p1/run.sh [--keep]   (--keep preserves the lab dir on exit)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTRY="$REPO_ROOT/packages/coding-agent/src/experimental/durable-p1/main.ts"
RESOLVER="$REPO_ROOT/packages/coding-agent/src/experimental/source-resolver.ts"
MCP_BUILTIN="$REPO_ROOT/packages/coding-agent/src/extensions/mcp/index.ts"
MCP_FIXTURE="$REPO_ROOT/e2e/durable-p1/fixtures/mcp-server.mjs"
[ -f "$ENTRY" ] || { echo "FATAL: entry not found at $ENTRY" >&2; exit 2; }
[ -f "$MCP_FIXTURE" ] || { echo "FATAL: MCP fixture missing" >&2; exit 2; }

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

LAB="$(mktemp -d "${TMPDIR:-/tmp}/pi-durable-e2e.XXXXXX")"
SESSIONS_ROOT=""
PASS=0
FAIL=0
FAILED_SCENARIOS=()
CURRENT=""

# --- tmux helpers -----------------------------------------------------------

t() { tmux "$@"; }

tui_start() { # tui_start <name> [entry args...]
	local name="$1"; shift
	local -a quoted=()
	local arg
	for arg in "$@"; do quoted+=("$(printf '%q' "$arg")"); done
	local envprefix=""
	[ -n "${DEEPSEEK_API_KEY:-}" ] && envprefix="env DEEPSEEK_API_KEY=$(printf '%q' "$DEEPSEEK_API_KEY") "
	t kill-session -t "$name" 2>/dev/null || true
	t new-session -d -s "$name" -x 200 -y 50 \
		"cd $(printf '%q' "$LAB") && ${envprefix}node --import $(printf '%q' "$RESOLVER") $(printf '%q' "$ENTRY") ${quoted[*]} 2>$(printf '%q' "$LAB/$name.err"); echo EXITED >>$(printf '%q' "$LAB/$name.err"); sleep 300"
}

tui_keys() { t send-keys -t "$1" "${@:2}"; }

pane() { t capture-pane -t "$1" -p; }

# tui_expect <name> <timeout-sec> <egrep-pattern> — poll until matched
tui_expect() {
	local name="$1" timeout="$2" pattern="$3" waited=0
	while [ "$waited" -lt "$timeout" ]; do
		if pane "$name" | grep -qE -- "$pattern"; then return 0; fi
		if grep -q "^EXITED$" "$LAB/$name.err" 2>/dev/null; then return 1; fi
		sleep 2; waited=$((waited + 2))
	done
	return 1
}

tui_dead() { grep -q "^EXITED$" "$LAB/$1.err" 2>/dev/null; }

tui_kill() { t kill-session -t "$1" 2>/dev/null || true; }

scenario() { # scenario <name> <fn>
	CURRENT="$1"
	echo "── scenario: $CURRENT"
	if "$2"; then
		echo "PASS  $CURRENT"; PASS=$((PASS + 1))
	else
		echo "FAIL  $CURRENT (evidence in $LAB/$CURRENT.pane + $LAB/*.err)"
		pane "$CURRENT" >"$LAB/$CURRENT.pane" 2>/dev/null || true
		FAIL=$((FAIL + 1)); FAILED_SCENARIOS+=("$CURRENT")
	fi
}

skip_scenario() { # skip_scenario <name> <reason>
	echo "SKIP  $1 ($2)"
}

cleanup() {
	for name in boot tool mcp mcpcmd compact steer mswitch killu cont listw footer; do
		t kill-session -t "$name" 2>/dev/null || true
	done
	if [ -n "$SESSIONS_ROOT" ] && [ -d "$SESSIONS_ROOT" ]; then
		rm -rf "$SESSIONS_ROOT"
	fi
	if [ "$KEEP" = 1 ]; then
		echo "lab kept at $LAB"
	else
		rm -rf "$LAB"
	fi
}
trap cleanup EXIT

# --- lab setup ---------------------------------------------------------------

mkdir -p "$LAB/.pi"
cat >"$LAB/.pi/settings.json" <<'EOF'
{
	"defaultProvider": "deepseek",
	"defaultModel": "deepseek-flash",
	"defaultThinkingLevel": "off",
	"compaction": { "enabled": true, "keepRecentTokens": 50, "reserveTokens": 500 }
}
EOF
cat >"$LAB/.pi/mcp.json" <<EOF
{
	"mcpServers": {
		"echo-test": {
			"command": "node",
			"args": ["$MCP_FIXTURE"],
			"description": "e2e echo/add server",
			"exposure": "direct"
		}
	}
}
EOF
# The per-cwd durable sessions root (hash of the lab path), removed on exit.
SESSIONS_ROOT="$HOME/.pi/agent/experimental/durable-p1-sessions/$(realpath "$LAB" | shasum -a 256 | cut -c1-24)"

BOOT_ARGS=(-ne -e "$MCP_BUILTIN")

# --- scenarios ---------------------------------------------------------------

s_boot() {
	tui_start boot "${BOOT_ARGS[@]}"
	tui_expect boot 60 "deepseek-flash" || return 1
	tui_keys boot "Reply with exactly: e2e-boot-ok"; sleep 1; tui_keys boot Enter
	tui_expect boot 90 "e2e-boot-ok" || return 1
}

s_tool() {
	tui_start tool "${BOOT_ARGS[@]}"
	tui_expect tool 60 "deepseek-flash" || return 1
	tui_keys tool "Use the bash tool to run: echo e2e-tool-token — then reply with its exact output."; sleep 1; tui_keys tool Enter
	tui_expect tool 120 "e2e-tool-token" || return 1
	tui_expect tool 20 "Took" || return 1
}

s_mcp() {
	tui_start mcp "${BOOT_ARGS[@]}"
	tui_expect mcp 60 "deepseek-flash" || return 1
	# The MCP server must connect without the deferred-exposure warning.
	pane mcp | grep -q "only reachable from the codemode" && return 1
	tui_keys mcp "Call the tool mcp__echo-test__add with a=17 and b=26, then reply with just its result."; sleep 1; tui_keys mcp Enter
	tui_expect mcp 120 "mcp__echo_test__add" || return 1
	tui_expect mcp 60 "43" || return 1
}

s_mcpcmd() {
	tui_start mcpcmd "${BOOT_ARGS[@]}"
	tui_expect mcpcmd 60 "deepseek-flash" || return 1
	tui_keys mcpcmd "/mcp"; sleep 1; tui_keys mcpcmd Escape; sleep 1; tui_keys mcpcmd Enter
	tui_expect mcpcmd 30 "echo-test.*connected|connected.*echo-test" || return 1
	# The command must open the panel, not leak to the model as a prompt.
	pane mcpcmd | grep -q "Want me to run" && return 1
	tui_keys mcpcmd Escape
	return 0
}

s_compact() {
	tui_start compact "${BOOT_ARGS[@]}"
	tui_expect compact 60 "deepseek-flash" || return 1
	tui_keys compact "Write a 200-word story about a river ferry."; sleep 1; tui_keys compact Enter
	tui_expect compact 150 "ferry" || return 1
	tui_keys compact "/compact Focus on the ferry"; sleep 1; tui_keys compact Escape; sleep 1; tui_keys compact Enter
	tui_expect compact 90 "Compacted from" || return 1
	tui_keys compact "/compact again"; sleep 1; tui_keys compact Escape; sleep 1; tui_keys compact Enter
	tui_expect compact 30 "Already compacted" || return 1
}

s_steer() {
	tui_start steer "${BOOT_ARGS[@]}"
	tui_expect steer 60 "deepseek-flash" || return 1
	tui_keys steer "Use the bash tool to run: sleep 15 && echo steer-main-done — while waiting I will send another message. Report both outputs at the end."; sleep 1; tui_keys steer Enter
	sleep 6
	tui_keys steer "STEER: also run echo steer-inject-ok and include its output"; sleep 1; tui_keys steer Enter
	tui_expect steer 150 "steer-main-done" || return 1
	tui_expect steer 60 "steer-inject-ok" || return 1
}

s_mswitch() {
	tui_start mswitch "${BOOT_ARGS[@]}"
	tui_expect mswitch 60 "deepseek-flash" || return 1
	tui_keys mswitch "/model"; sleep 2
	tui_keys mswitch Enter; sleep 2      # select "model" from the command menu
	tui_expect mswitch 20 "deepseek-v4-pro" || return 1
	tui_keys mswitch Down; sleep 1; tui_keys mswitch Enter; sleep 3
	tui_expect mswitch 20 "deepseek-v4-pro" || return 1
	tui_keys mswitch "Reply with exactly: v4-ok"; sleep 1; tui_keys mswitch Enter
	tui_expect mswitch 90 "v4-ok" || return 1
	pane mswitch | grep -q "deepseek-v4-pro" || return 1
}

s_killu() {
	tui_start killu "${BOOT_ARGS[@]}"
	tui_expect killu 60 "deepseek-flash" || return 1
	tui_keys killu "Use the bash tool to run: sleep 20 && echo kill-survived — when it finishes reply DONE plus its output."; sleep 1; tui_keys killu Enter
	tui_expect killu 30 "sleep 20" || return 1
	sleep 5
	t kill-session -t killu     # hard kill mid-tool
	sleep 2
	tui_start killu -c          # resume the newest session
	tui_expect killu 90 "interrupted|kill-survived" || return 1
}

s_cont() {
	# Release the session lock held by killu's still-running resumed process.
	tui_kill killu
	sleep 2
	# killu's session (newest) must rebuild with its history visible.
	tui_start cont -c
	tui_expect cont 60 "sleep 20 && echo kill-survived" || return 1
}

s_list() {
	(cd "$LAB" && node --import "$RESOLVER" "$ENTRY" --list >"$LAB/list.out" 2>"$LAB/list.err")
	grep -q "No durable-p1 sessions" "$LAB/list.out" && return 1
	grep -qE "^[0-9]{4}-" "$LAB/list.out" || return 1
	return 0
}

s_footer() {
	tui_start footer -ne -e "$HOME/repo/pi-powerline-footer" -e "$MCP_BUILTIN"
	tui_expect footer 60 "deepseek-flash" || return 1
	tui_expect footer 30 "☁️ deepseek" || return 1
	pane footer | grep -qE "─ 📁 .*durable-e2e" || return 1
	tui_keys footer "Call mcp__echo-test__echo with text=footer-e2e and reply with its output."; sleep 1; tui_keys footer Enter
	tui_expect footer 120 "echo: footer-e2e" || return 1
	return 0
}

# --- run ----------------------------------------------------------------------

echo "lab: $LAB"
echo "sessions root: $SESSIONS_ROOT"

scenario boot s_boot
scenario tool s_tool
scenario mcp s_mcp
scenario mcpcmd s_mcpcmd
scenario compact s_compact
scenario steer s_steer
scenario mswitch s_mswitch
scenario killu s_killu
scenario cont s_cont
scenario list s_list
if [ -f "$HOME/repo/pi-powerline-footer/index.ts" ]; then
	scenario footer s_footer
else
	skip_scenario footer "fixture ~/repo/pi-powerline-footer not present"
fi

echo
echo "════ e2e summary: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
	printf 'failed: %s\n' "${FAILED_SCENARIOS[*]}"
	exit 1
fi
exit 0
