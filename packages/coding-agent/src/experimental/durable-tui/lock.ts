// durable-tui session directory locks.
//
// Replaces proper-lockfile here: its options are normalized in ways that
// cannot be made safe for us — `stale` is clamped to >=2000ms (another
// acquirer steals — i.e. rmdir's — a lock that briefly looks stale) and
// `update` is clamped to >=1000ms (an internal timer stat()s the lock dir and
// an ENOENT there surfaces as an uncaught exception, which crashed a live
// TUI when the sessions tree was renamed externally, 2026-10-09). This module
// keeps the same `<dir>.lock` directory layout (a stray proper-lockfile lock
// from an older boot still reads as held, then heals as an orphan), but all
// timers are ours and guarded.

import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { sleep } from "../../utils/sleep.ts";

const LOCK_REFRESHER_MS = 2000;
const LOCK_ORPHAN_MS = 10_000;

export interface DirectoryLock {
	/** Stop the refresher and remove the lock directory. Idempotent. */
	release(): Promise<void>;
}

function lockDirOf(directory: string): string {
	return `${directory}.lock`;
}

async function tryAcquire(lockDir: string): Promise<boolean> {
	return mkdir(lockDir)
		.then(() => true)
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === "EEXIST") return false;
			throw error;
		});
}

/**
 * Lock `directory` via an atomic mkdir of `<directory>.lock`. A lock that
 * exists but has not been refreshed for LOCK_ORPHAN_MS belongs to a dead
 * owner (live owners refresh every LOCK_REFRESHER_MS) and heals: removed,
 * retried once. `retries` keeps the historical double-boot pacing (12 x 1s)
 * before giving up with ELOCKED.
 */
export async function lockSessionDirectory(directory: string, retries = 0): Promise<DirectoryLock> {
	const lockDir = lockDirOf(directory);
	let acquired = await tryAcquire(lockDir);
	if (!acquired) {
		const lockStat = await stat(lockDir).catch(() => null);
		if (lockStat !== null && Date.now() - lockStat.mtimeMs >= LOCK_ORPHAN_MS) {
			await rm(lockDir, { recursive: true, force: true }).catch(() => {});
			acquired = await tryAcquire(lockDir);
		}
	}
	for (let attempt = 0; !acquired && attempt < retries; attempt++) {
		await sleep(1000);
		acquired = await tryAcquire(lockDir);
		if (acquired) break;
		// Re-check orphaning inside the retry window: a process killed right
		// before our first attempt leaves a lock that only crosses the
		// staleness threshold a few retries in (the historical proper-lockfile
		// behavior healed these via its stale-steal during retries).
		const lockStat = await stat(lockDir).catch(() => null);
		if (lockStat !== null && Date.now() - lockStat.mtimeMs >= LOCK_ORPHAN_MS) {
			await rm(lockDir, { recursive: true, force: true }).catch(() => {});
			acquired = await tryAcquire(lockDir);
		}
	}
	if (!acquired) {
		const error = new Error(`Lock file is already being held: ${lockDir}`) as NodeJS.ErrnoException;
		error.code = "ELOCKED";
		throw error;
	}

	// Guarded liveness refresher: marks the owner alive for orphan healing,
	// and downgrades external lock loss (rename/delete under our feet) to a
	// warning instead of an unhandled-exception crash.
	let warnedLost = false;
	let released = false;
	const refresher = setInterval(() => {
		if (released) return;
		const now = new Date();
		void utimes(lockDir, now, now).catch(() => {
			if (warnedLost) return;
			warnedLost = true;
			console.error(
				`[durable-tui] session lock directory vanished (${lockDir}) — continuing without lock protection; another process may write concurrently`,
			);
		});
	}, LOCK_REFRESHER_MS);
	refresher.unref();

	return {
		release: async () => {
			if (released) return;
			released = true;
			clearInterval(refresher);
			await rm(lockDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

/** Probe without any acquisition side effect: held = lock dir exists. */
export async function isSessionDirectoryLocked(directory: string): Promise<boolean> {
	return stat(lockDirOf(directory))
		.then(() => true)
		.catch(() => false);
}
