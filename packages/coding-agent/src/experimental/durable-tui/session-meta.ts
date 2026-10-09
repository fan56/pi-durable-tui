// durable-tui: session identity, naming, and listing (wayfinder ticket 009,
// resolution 6, gap 3). Durable has no session metadata API (R1 §3.1 #11/#16),
// so the app layer owns a `session.json` sidecar next to each session.sqlite:
// zero coupling to the Experimental durable API, fork-friendly. `/name`
// persists here; `--list` reads here.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TuiSessionLocation } from "./session-location.ts";

/** Sidecar record stored at `<session-dir>/session.json`. */
export interface TuiSessionMeta {
	id: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	/** Set by /name (AgentSession.setSessionName routed through the facade). */
	name?: string;
	/** First user input, kept for a future resume picker. */
	title?: string;
}

const SESSION_DIR_PATTERN = /^\d{13}-[0-9a-f-]{36}$/u;

/** The session this process currently has open, for pickers to exclude. */
let currentTuiSessionId: string | undefined;

export function getCurrentTuiSessionId(): string | undefined {
	return currentTuiSessionId;
}

export function setCurrentTuiSessionId(id: string | undefined): void {
	currentTuiSessionId = id;
	// Extensions load through jiti and get their own module instances, so the
	// module variable above is invisible to them; the process env is the one
	// shared channel (single-process by the session lock).
	if (id === undefined) delete process.env.PI_DURABLE_SESSION_ID;
	else process.env.PI_DURABLE_SESSION_ID = id;
}

export function metaPath(directory: string): string {
	return join(directory, "session.json");
}

/** Create the sidecar for a fresh session; never throws into the boot path. */
export async function writeInitialMeta(location: TuiSessionLocation): Promise<void> {
	// Never clobber: reattaching (via /sessions or --session) must keep the
	// recorded title/name/createdAt of the existing session.
	if ((await readMeta(location.directory)) !== undefined) return;
	const meta: TuiSessionMeta = {
		id: location.id,
		cwd: location.cwd,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await writeMeta(location.directory, meta);
}

/** Best-effort partial update; requires the sidecar written by writeInitialMeta. */
export async function updateMeta(
	directory: string,
	change: { name?: string; title?: string },
): Promise<void> {
	const existing = await readMeta(directory);
	if (existing === undefined) return;
	const meta: TuiSessionMeta = {
		...existing,
		updatedAt: new Date().toISOString(),
		...(change.name === undefined ? {} : { name: change.name }),
		...(change.title === undefined ? {} : { title: change.title }),
	};
	await writeMeta(directory, meta);
}

export async function readMeta(directory: string): Promise<TuiSessionMeta | undefined> {
	try {
		const raw = await readFile(metaPath(directory), "utf-8");
		return JSON.parse(raw) as TuiSessionMeta;
	} catch {
		return undefined;
	}
}

async function writeMeta(directory: string, meta: TuiSessionMeta): Promise<void> {
	try {
		await writeFile(metaPath(directory), `${JSON.stringify(meta, null, "\t")}\n`, "utf-8");
	} catch (error) {
		console.error("[durable-tui] session meta write failed:", error);
	}
}

/** One row of the per-cwd session listing, newest first. */
export interface TuiSessionSummary extends TuiSessionMeta {
	directory: string;
}

/** List sessions for one sessions root (the per-cwd directory from selectTuiSession). */
export async function listSessions(root: string): Promise<TuiSessionSummary[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const summaries: TuiSessionSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !SESSION_DIR_PATTERN.test(entry.name)) continue;
		const directory = join(root, entry.name);
		const meta = await readMeta(directory);
		if (meta === undefined) continue;
		summaries.push({ ...meta, directory });
	}
	summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	return summaries;
}
