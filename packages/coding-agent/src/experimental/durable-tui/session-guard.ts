// durable-tui: refuse session switches and forks the durable runtime factory
// cannot serve, BEFORE AgentSessionRuntime tears the live session down.
//
// AgentSessionRuntime.switchSession()/fork() call teardownCurrent() first and
// the runtime factory last, so a factory refusal (main.ts: "fork"/non-durable
// resume) fires after the live session is already disposed: the extension path
// leaves the TUI bound to a dead session, and the built-in fork command hits
// handleFatalRuntimeError() and exits the process.
//
// Upstream 1.5.2 (PR #11975) added a Continue/Fork/Cancel prompt when a stored
// session cwd no longer exists, reachable here through ctx.switchSession()
// (durable-tui's /sessions uses a carrier path, but any extension call is
// subject to the prompt). Picking Fork routes into the factory refusal above.
// Cancelling at session_before_switch / session_before_fork — both emitted
// before teardown — keeps the user in the current session instead.

import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { durableIdFromCarrierPath } from "./sessions-extension.ts";

export const FORK_UNSUPPORTED_NOTICE =
	"durable-tui: fork is not supported yet (planned) — staying in the current session";
export const NON_DURABLE_SWITCH_NOTICE =
	"durable-tui: that session is not a durable session — use /sessions to pick one";

export default function sessionGuardExtension(pi: ExtensionAPI): void {
	pi.on("session_before_fork", (_event, ctx) => {
		notify(ctx, FORK_UNSUPPORTED_NOTICE);
		return { cancel: true };
	});
	pi.on("session_before_switch", (event, ctx) => {
		// "new" (ctx.newSession, /new, /clear) has no target file to inspect.
		if (event.reason !== "resume" || event.targetSessionFile === undefined) return;
		// Only the carrier paths this fork's picker hands to the factory are
		// switchable; the factory resolves the durable id from them.
		if (durableIdFromCarrierPath(event.targetSessionFile, ctx.cwd) !== undefined) return;
		notify(ctx, NON_DURABLE_SWITCH_NOTICE);
		return { cancel: true };
	});
}

function notify(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	else console.error(message);
}
