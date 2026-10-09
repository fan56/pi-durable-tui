// durable-tui spike: session directory under an isolated prototype-marked root.
// Same shape as ../durable/sessions.ts, but rooted at durable-tui-sessions.

import { existsSync, statSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { lockSessionDirectory } from "./lock.ts";
import { getAgentDir } from "../../config.ts";

/** One session directory holding `session.sqlite`, locked by this process. */
export interface TuiSessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/** The per-cwd sessions root directory (hash-partitioned, prototype-isolated). */
export function tuiSessionsRoot(cwd: string): string {
	return join(
		getAgentDir(),
		"experimental",
		"durable-tui-sessions",
		createHash("sha256").update(cwd).digest("hex").slice(0, 24),
	);
}

let legacySessionsMigrated = false;
/**
 * One-time move of the pre-rename sessions tree (durable-p1-sessions →
 * durable-tui-sessions). Same-volume rename keeps open sqlite fds valid, so a
 * still-running old process keeps writing into the moved files. Idempotent:
 * skipped once done or when the legacy root is gone.
 */
export function migrateLegacySessionsRoot(): void {
	if (legacySessionsMigrated) return;
	legacySessionsMigrated = true;
	const experimental = join(getAgentDir(), "experimental");
	const legacy = join(experimental, "durable-p1-sessions");
	const current = join(experimental, "durable-tui-sessions");
	try {
		if (statSync(legacy).isDirectory() && !existsSync(current)) {
			renameSync(legacy, current);
		}
	} catch {
		// Best-effort: a locked/moving tree just means the next boot retries.
	}
}

/** A new session for `cwd`, or its newest one with `continueSession`. */
export async function selectTuiSession(cwdInput: string, continueSession: boolean): Promise<TuiSessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	const root = tuiSessionsRoot(cwd);
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const newest = entries
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.at(-1);
		if (!newest) throw new Error(`No durable-tui session exists for ${cwd}`);
		directory = join(root, newest);
	} else {
		directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(directory);
		created = true;
	}
	return lockLocation(cwd, directory, created);
}

/** Attach one specific session for `cwd` by its directory id. */
export async function selectTuiSessionById(cwdInput: string, sessionId: string): Promise<TuiSessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	if (!/^\d{13}-[0-9a-f-]{36}$/u.test(sessionId)) {
		throw new Error(`durable-tui: invalid session id ${sessionId}`);
	}
	const directory = join(tuiSessionsRoot(cwd), sessionId);
	if (!(await stat(directory).then(() => true).catch(() => false))) {
		throw new Error(`durable-tui: no session ${sessionId} for ${cwd}`);
	}
	return lockLocation(cwd, directory, false);
}

async function lockLocation(cwd: string, directory: string, created: boolean): Promise<TuiSessionLocation> {
	let release: () => Promise<void>;
	try {
		// 12 x 1s keeps the historical double-boot pacing; the lock itself is
		// our mkdir-based one (see ./lock.ts for why proper-lockfile is out).
		release = await lockSessionDirectory(directory, 12)
			.then((lock) => lock.release.bind(lock));
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
	return {
		id: basename(directory),
		directory,
		database: join(directory, "session.sqlite"),
		cwd,
		created,
		release,
	};
}
