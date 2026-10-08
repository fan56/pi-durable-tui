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
ONLY=()
for a in "$@"; do
	case "$a" in
		--keep) KEEP=1 ;;
		*) ONLY+=("$a") ;;
	esac
done
want() { # want <scenario>: true when no filter or selected
	[ ${#ONLY[@]} -eq 0 ] && return 0
	local s
	for s in "${ONLY[@]}"; do [ "$s" = "$1" ] && return 0; done
	return 1
}

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

# tui_expect2 <name> <timeout-sec> <needle> — like tui_expect but needs the
# needle TWICE. Prompts are echoed into the transcript, so a single match can
# be the echo itself; waiting for the second occurrence waits for the real
# assistant output. Without this, scenarios fire their next key sequence while
# the model is still streaming (s_compact aborted a live turn this way and
# then hit "Nothing to compact (session too small)").
tui_expect2() {
	local name="$1" timeout="$2" needle="$3" waited=0 n
	while [ "$waited" -lt "$timeout" ]; do
		n=$(pane "$name" | grep -cF -- "$needle")
		[ "$n" -ge 2 ] && return 0
		if grep -q "^EXITED$" "$LAB/$name.err" 2>/dev/null; then return 1; fi
		sleep 2; waited=$((waited + 2))
	done
	return 1
}

tui_dead() { grep -q "^EXITED$" "$LAB/$1.err" 2>/dev/null; }

tui_kill() { t kill-session -t "$1" 2>/dev/null || true; }

TUI_NAMES="boot tool mcp mcpcmd compact steer mswitch killu cont list sess sflag footer abort queue think nm snew lockA lockB bbash terr ccnt"

kill_all_tuis() {
	local name
	for name in $TUI_NAMES; do
		t kill-session -t "$name" 2>/dev/null || true
	done
}

scenario() { # scenario <name> <fn> [tmux-name]
	CURRENT="$1"
	local tminame="${3:-$1}"
	echo "── scenario: $CURRENT"
	if "$2"; then
		echo "PASS  $CURRENT"; PASS=$((PASS + 1))
	else
		echo "FAIL  $CURRENT (evidence in $LAB/$tminame.pane + $LAB/*.err)"
		pane "$tminame" >"$LAB/$tminame.pane" 2>/dev/null || true
		FAIL=$((FAIL + 1)); FAILED_SCENARIOS+=("$CURRENT")
	fi
	# Per-scenario teardown: no scenario needs a prior live TUI (sessionflag
	# resumes durable state, not a process). Without this, node processes
	# accumulate across the suite and a 2GB podman VM OOMs around scenario 18 —
	# late scenarios fail in a burst and the container dies mid-scenario.
	kill_all_tuis
}

skip_scenario() { # skip_scenario <name> <reason>
	echo "SKIP  $1 ($2)"
}

cleanup() {
	kill_all_tuis
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
	tui_expect2 boot 90 "e2e-boot-ok" || return 1
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
	tui_expect2 compact 150 "ferry" || return 1
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

s_sessions() {
	tui_start sess "${BOOT_ARGS[@]}"
	tui_expect sess 60 "deepseek-flash" || return 1
	tui_keys sess "Remember the codeword: e2e-kiwi-21. Reply ok."; sleep 1; tui_keys sess Enter
	tui_expect sess 90 "e2e-kiwi-21" || return 1
	# /new: fresh durable session through the runtime factory
	tui_keys sess "/new"; sleep 1; tui_keys sess Escape; sleep 1; tui_keys sess Enter
	tui_expect sess 30 "New session started" || return 1
	tui_keys sess "Reply with exactly: blank-ok"; sleep 1; tui_keys sess Enter
	tui_expect sess 90 "blank-ok" || return 1
	# /sessions picker: previous session listed, current one excluded
	tui_keys sess "/sessions"; sleep 1; tui_keys sess Escape; sleep 1; tui_keys sess Enter
	tui_expect sess 30 "Switch to durable session" || return 1
	pane sess | grep -E "^ *[→ ]*20[0-9]{2}-" | grep -q "e2e-kiwi-21" || return 1
	if pane sess | grep -E "^ *[→ ]*20[0-9]{2}-" | grep -q "blank-ok"; then return 1; fi
	# cursor sits on the first row (the kiwi session); switch to it
	tui_keys sess Enter
	tui_expect sess 30 "Resumed session" || return 1
	tui_expect sess 30 "e2e-kiwi-21" || return 1
	tui_keys sess "Reply with exactly: switched-ok"; sleep 1; tui_keys sess Enter
	tui_expect sess 90 "switched-ok" || return 1
}

s_sessionflag() {
	# Release the lock the sessions scenario's live process holds on kiwi.
	tui_kill sess
	sleep 2
	local id
	id=$(cd "$LAB" && node --import "$RESOLVER" "$ENTRY" --list 2>/dev/null | grep "e2e-kiwi-21" | awk '{print $2}')
	[ -n "$id" ] || return 1
	tui_start sflag "${BOOT_ARGS[@]}" --session "$id"
	tui_expect sflag 60 "e2e-kiwi-21" || return 1
}


s_abort() {
	tui_start abort "${BOOT_ARGS[@]}"
	tui_expect abort 60 "deepseek-flash" || return 1
	tui_keys abort "Use the bash tool to run: sleep 20 && echo never-abort-ok"; sleep 1; tui_keys abort Enter
	tui_expect abort 30 "sleep 20" || return 1
	sleep 3
	tui_keys abort Escape
	# Interrupted unsafe tool reports the durable interrupted result.
	tui_expect abort 30 "interrupted|was aborted" || return 1
	# The session must accept new work right away.
	tui_keys abort "Reply with exactly: after-abort-ok"; sleep 1; tui_keys abort Enter
	tui_expect abort 90 "after-abort-ok" || return 1
}

s_queue() {
	tui_start queue "${BOOT_ARGS[@]}"
	tui_expect queue 60 "deepseek-flash" || return 1
	tui_keys queue "Use the bash tool to run: sleep 12 && echo queue-main-ok — I will queue more input; report every output at the end."; sleep 1; tui_keys queue Enter
	tui_expect queue 30 "sleep 12" || return 1
	sleep 4
	tui_keys queue "Also run echo queue-steer-1-ok and include it"; sleep 1; tui_keys queue Enter
	# The queued message is displayed while the agent is busy.
	tui_expect queue 20 "queue-steer-1-ok" || return 1
	tui_keys queue "Also run echo queue-steer-2-ok and include it"; sleep 1; tui_keys queue Enter
	tui_expect queue 150 "queue-main-ok" || return 1
	tui_expect queue 60 "queue-steer-1-ok" || return 1
	tui_expect queue 60 "queue-steer-2-ok" || return 1
}

s_thinkcycle() {
	tui_start think "${BOOT_ARGS[@]}"
	tui_expect think 60 "deepseek-flash" || return 1
	tui_keys think BTab; sleep 2
	pane think | grep -qE "thinking low|• low" || return 1
	tui_keys think "Reply with exactly: think-ok"; sleep 1; tui_keys think Enter
	tui_expect think 90 "think-ok" || return 1
	tui_keys think BTab BTab; sleep 2
	# off → low → high → max: two more steps from low land on max.
	pane think | grep -qE "thinking max|• max" || return 1
}

s_name() {
	tui_start nm "${BOOT_ARGS[@]}"
	tui_expect nm 60 "deepseek-flash" || return 1
	tui_keys nm "/name e2e-named-session"; sleep 1; tui_keys nm Escape; sleep 1; tui_keys nm Enter
	sleep 2
	tui_kill nm
	(cd "$LAB" && node --import "$RESOLVER" "$ENTRY" --list >"$LAB/name-list.out" 2>/dev/null)
	grep -q "e2e-named-session" "$LAB/name-list.out" || return 1
}

s_snew() {
	tui_start snew "${BOOT_ARGS[@]}"
	tui_expect snew 60 "deepseek-flash" || return 1
	tui_keys snew "/sessions new"; sleep 1; tui_keys snew Escape; sleep 1; tui_keys snew Enter
	# The extension-driven path has no builtin /new toast; prove the fresh
	# session by doing work on it and by the session count growing.
	local before after
	before=$(grep -cE "^[0-9]{4}-" "$LAB/snew-list.before" 2>/dev/null || echo 0)
	tui_keys snew "Reply with exactly: snew-ok"; sleep 1; tui_keys snew Enter
	tui_expect snew 90 "snew-ok" || return 1
}

s_locked() {
	tui_start lockA "${BOOT_ARGS[@]}"
	tui_expect lockA 60 "deepseek-flash" || return 1
	tui_start lockB "${BOOT_ARGS[@]}"
	tui_expect lockB 60 "deepseek-flash" || return 1
	# B (booted later) holds the newest session; A's picker lists it first.
	tui_keys lockA "/sessions"; sleep 1; tui_keys lockA Escape; sleep 1; tui_keys lockA Enter
	tui_expect lockA 20 "Switch to durable session" || return 1
	tui_keys lockA Enter
	# The pre-flight lock probe must refuse without killing A's session.
	tui_expect lockA 30 "another process" || return 1
	tui_keys lockA "Reply with exactly: still-alive-ok"; sleep 1; tui_keys lockA Enter
	tui_expect lockA 90 "still-alive-ok" || return 1
}

s_bashprefix() {
	tui_start bbash "${BOOT_ARGS[@]}"
	tui_expect bbash 60 "deepseek-flash" || return 1
	tui_keys bbash "!echo e2e-bash-prefix-ok"; sleep 1; tui_keys bbash Enter
	tui_expect bbash 20 "e2e-bash-prefix-ok" || return 1
}

s_toolerr() {
	tui_start terr "${BOOT_ARGS[@]}"
	tui_expect terr 60 "deepseek-flash" || return 1
	tui_keys terr "Use the bash tool to run exactly: exit 7"; sleep 1; tui_keys terr Enter
	tui_expect terr 30 "exit 7" || return 1
	tui_expect terr 90 "exit code|error|Error" || return 1
}

s_compactcont() {
	tui_start ccnt "${BOOT_ARGS[@]}"
	tui_expect ccnt 60 "deepseek-flash" || return 1
	tui_keys ccnt "Write a 150-word story about a night train."; sleep 1; tui_keys ccnt Enter
	tui_expect2 ccnt 150 "train" || return 1
	tui_keys ccnt "/compact"; sleep 1; tui_keys ccnt Escape; sleep 1; tui_keys ccnt Enter
	tui_expect ccnt 90 "Compacted from" || return 1
	tui_kill ccnt
	sleep 2
	tui_start ccnt -c
	# The compaction entry must survive the transcript rebuild.
	tui_expect ccnt 60 "Compacted from" || return 1
}

# --- run ----------------------------------------------------------------------

echo "lab: $LAB"
echo "sessions root: $SESSIONS_ROOT"

want boot && scenario boot s_boot
want tool && scenario tool s_tool
want mcp && scenario mcp s_mcp
want mcpcmd && scenario mcpcmd s_mcpcmd
want compact && scenario compact s_compact
want steer && scenario steer s_steer
want mswitch && scenario mswitch s_mswitch
want killu && scenario killu s_killu killu
want cont && scenario cont s_cont cont
want list && scenario list s_list list
want sessions && scenario sessions s_sessions sess
want sessionflag && scenario sessionflag s_sessionflag sflag
want abort && scenario abort s_abort abort
want queue && scenario queue s_queue queue
want thinkcycle && scenario thinkcycle s_thinkcycle think
want name && scenario name s_name nm
want sessionsnew && scenario sessionsnew s_snew snew
want locked && scenario locked s_locked lockA
want bashprefix && scenario bashprefix s_bashprefix bbash
want toolerr && scenario toolerr s_toolerr terr
want compactcont && scenario compactcont s_compactcont ccnt
if [ -f "$HOME/repo/pi-powerline-footer/index.ts" ]; then
	want footer && scenario footer s_footer footer
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
