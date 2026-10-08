// durable-p1 spike: session directory under an isolated prototype-marked root.
// Same shape as ../durable/sessions.ts, but rooted at durable-p1-sessions.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";

/** One session directory holding `session.sqlite`, locked by this process. */
export interface P1SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/** The per-cwd sessions root directory (hash-partitioned, prototype-isolated). */
export function p1SessionsRoot(cwd: string): string {
	return join(
		getAgentDir(),
		"experimental",
		"durable-p1-sessions",
		createHash("sha256").update(cwd).digest("hex").slice(0, 24),
	);
}

/** A new session for `cwd`, or its newest one with `continueSession`. */
export async function selectP1Session(cwdInput: string, continueSession: boolean): Promise<P1SessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	const root = p1SessionsRoot(cwd);
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
		if (!newest) throw new Error(`No durable-p1 session exists for ${cwd}`);
		directory = join(root, newest);
	} else {
		directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(directory);
		created = true;
	}

	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(directory, {
			realpath: false,
			retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
		});
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}
