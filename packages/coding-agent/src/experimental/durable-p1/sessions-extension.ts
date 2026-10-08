// durable-p1: the "/sessions" command — the durable session picker (v0.4).
// The stock /resume selector lists stable JSONL sessions and switches through
// SessionManager.open, which cannot see durable SQLite sessions; this command
// lists our session.json sidecars instead and switches by passing a carrier
// path (a nonexistent "<session-dir>/carrier.jsonl") through
// ExtensionCommandContext.switchSession. The runtime factory recognizes the
// durable-p1-sessions path prefix and attaches that session by id —
// SessionManager.open tolerates the missing file, so the carrier needs no
// bytes on disk.
//
// UX notes borrowed from dsh-tui-pi's picker: newest first, exclude the
// current session (its lock is held), title from the first user input, and
// "new" as an explicit subcommand rather than an implicit picker entry.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { p1SessionsRoot } from "./session-location.ts";
import { listSessions } from "./session-meta.ts";

const CARRIER_NAME = "carrier.jsonl";

/** Pre-flight a switch target: undefined when openable, else a user message. */
async function validateSwitchTarget(directory: string): Promise<string | undefined> {
	if (!(await stat(join(directory, "session.sqlite")).then(() => true).catch(() => false))) {
		return "That session has no database file";
	}
	try {
		const release = await lockfile.lock(directory, {
			realpath: false,
			retries: { retries: 0 },
			stale: 0,
		});
		await release();
		return undefined;
	} catch {
		return "That session is open in another process";
	}
}

/** Recognize a switchSession carrier pointing into our sessions root. */
export function durableIdFromCarrierPath(path: string, cwd: string): string | undefined {
	const root = p1SessionsRoot(cwd);
	if (!path.startsWith(`${root}/`) || !path.endsWith(`/${CARRIER_NAME}`)) return undefined;
	const id = path.slice(root.length + 1, path.length - CARRIER_NAME.length - 1);
	return /^\d{13}-[0-9a-f-]{36}$/u.test(id) ? id : undefined;
}

export default function sessionsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("sessions", {
		description: "Switch durable session (picker), or start a new one with '/sessions new'",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (ctx.mode !== "tui") return;
			if (args.trim() === "new") {
				await ctx.newSession();
				return;
			}
			// jiti gives this extension its own module instances, so shared
			// in-process state is invisible here; identify the current session
			// by its durable conversation id via the session manager instead.
			// Set by the facade through the process env (jiti instances share it).
			const current = process.env.PI_DURABLE_SESSION_ID;
			const sessions = (await listSessions(p1SessionsRoot(ctx.cwd))).filter(
				(session) => session.id !== current,
			);
			if (sessions.length === 0) {
				ctx.ui.notify(current === undefined ? "No durable sessions yet" : "No other durable sessions", "info");
				return;
			}
			const byLabel = new Map<string, string>();
			const options: string[] = [];
			for (const session of sessions) {
				const created = session.createdAt.slice(0, 16).replace("T", " ");
				const title = (session.title ?? session.name ?? "(empty)").slice(0, 48);
				// The id tail keeps labels unique: two untitled sessions created
				// in the same minute render identical otherwise, and byLabel
				// would silently map both rows to whichever id was set last
				// (picked row 1, switched to a different, unlocked session).
				const label = `${created}  ${title}  ·${session.id.slice(-6)}`;
				byLabel.set(label, session.id);
				options.push(label);
			}
			const picked = await ctx.ui.select("Switch to durable session", options);
			if (picked === undefined) return;
			const id = byLabel.get(picked);
			if (id === undefined) return;
			const directory = join(p1SessionsRoot(ctx.cwd), id);
			// Validate BEFORE switching: switchSession tears the live session
			// down before the replacement factory runs, so a dead target must
			// refuse here instead of leaving a disposed TUI behind.
			const problem = await validateSwitchTarget(directory);
			if (problem !== undefined) {
				ctx.ui.notify(problem, "error");
				return;
			}
			await ctx.switchSession(join(directory, CARRIER_NAME));
		},
	});
}
