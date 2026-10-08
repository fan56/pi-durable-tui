// durable-p1: session identity, naming, and listing (wayfinder ticket 009,
// resolution 6, gap 3). Durable has no session metadata API (R1 §3.1 #11/#16),
// so the app layer owns a `session.json` sidecar next to each session.sqlite:
// zero coupling to the Experimental durable API, fork-friendly. `/name`
// persists here; `--list` reads here.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { P1SessionLocation } from "./session-location.ts";

/** Sidecar record stored at `<session-dir>/session.json`. */
export interface P1SessionMeta {
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

export function metaPath(directory: string): string {
	return join(directory, "session.json");
}

/** Create the sidecar for a fresh session; never throws into the boot path. */
export async function writeInitialMeta(location: P1SessionLocation): Promise<void> {
	const meta: P1SessionMeta = {
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
	const meta: P1SessionMeta = {
		...existing,
		updatedAt: new Date().toISOString(),
		...(change.name === undefined ? {} : { name: change.name }),
		...(change.title === undefined ? {} : { title: change.title }),
	};
	await writeMeta(directory, meta);
}

export async function readMeta(directory: string): Promise<P1SessionMeta | undefined> {
	try {
		const raw = await readFile(metaPath(directory), "utf-8");
		return JSON.parse(raw) as P1SessionMeta;
	} catch {
		return undefined;
	}
}

async function writeMeta(directory: string, meta: P1SessionMeta): Promise<void> {
	try {
		await writeFile(metaPath(directory), `${JSON.stringify(meta, null, "\t")}\n`, "utf-8");
	} catch (error) {
		console.error("[durable-p1] session meta write failed:", error);
	}
}

/** One row of the per-cwd session listing, newest first. */
export interface P1SessionSummary extends P1SessionMeta {
	directory: string;
}

/** List sessions for one sessions root (the per-cwd directory from selectP1Session). */
export async function listSessions(root: string): Promise<P1SessionSummary[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const summaries: P1SessionSummary[] = [];
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
