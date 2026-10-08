// durable-p1: rebuild a stable SessionManager transcript (header + SessionEntry
// chain) from a durable conversation's active entries, so the stock TUI renders
// history on `--continue` and session stats/usage read the real transcript
// (wayfinder ticket 009, resolution 6, gap 1).
//
// Mapping (durable entries.ts → session-manager.ts entry types):
//   pi.user / pi.assistant / pi.tool-result → { type: "message", message }
//   pi.compaction → { type: "compaction", summary, firstKeptEntryId, tokensBefore }
//   pi.reset with a handoff user message → { type: "message" }; without → skipped
//   pi.system (positional prompt) → skipped: stable has no transcript
//     counterpart, so rebuilt context estimates run slightly low.
// Session entry ids reuse the durable entry ids, so `pi.compaction`'s `head`
// reference (the first kept entry) is valid in the rebuilt chain as-is.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { FileEntry, SessionEntry, SessionHeader } from "../../core/session-manager.ts";
import { normalizeUserMessage } from "./event-adapter.ts";

const SUMMARY_OPEN = "<summary>";
const SUMMARY_CLOSE = "</summary>";

/** Result of rebuilding one durable conversation's active transcript. */
export interface RebuiltTranscript {
	/** `[header, ...entries]`, ready for `SessionManager.inMemory(cwd, opts, fileEntries)`. */
	fileEntries: FileEntry[];
	/** durable entry id → rebuilt session entry id (identity mapping today). */
	readonly idMap: ReadonlyMap<string, string>;
	/** Number of mapped and skipped entries, for diagnostics. */
	readonly stats: { mapped: number; skipped: number };
}

/** Unwrap the fixed summary envelope durable compaction writes around the text. */
export function unwrapCompactionSummary(text: string): string {
	const open = text.indexOf(SUMMARY_OPEN);
	const close = text.lastIndexOf(SUMMARY_CLOSE);
	if (open === -1 || close === -1 || close <= open) return text.trim();
	return text.slice(open + SUMMARY_OPEN.length, close).trim();
}

/** Map one durable entry to a session entry, or undefined when it has no stable counterpart. */
export function entryToSessionEntry(entry: EntryRecord, timestamp: string): SessionEntry | undefined {
	const message = entry.model?.[0];
	switch (entry.kind) {
		case "pi.user": {
			if (message === undefined) return undefined;
			return {
				type: "message",
				message: normalizeUserMessage(message),
				id: String(entry.id),
				parentId: null,
				timestamp,
			};
		}
		case "pi.assistant":
		case "pi.tool-result": {
			if (message === undefined) return undefined;
			return {
				type: "message",
				message: message as AgentMessage,
				id: String(entry.id),
				parentId: null,
				timestamp,
			};
		}
		case "pi.reset": {
			// A reset with a handoff message contributes that user text; a plain
			// reset is context bookkeeping only.
			if (message === undefined || message.role !== "user") return undefined;
			return {
				type: "message",
				message: normalizeUserMessage(message),
				id: String(entry.id),
				parentId: null,
				timestamp,
			};
		}
		case "pi.compaction": {
			const summaryText = message !== undefined && message.role === "user" ? contentTextOf(message) : "";
			return {
				type: "compaction",
				summary: unwrapCompactionSummary(summaryText),
				firstKeptEntryId: entry.head === undefined ? "" : String(entry.head),
				// durable does not report tokensBefore; the live facade captures it.
				tokensBefore: 0,
				id: String(entry.id),
				parentId: null,
				timestamp,
			};
		}
		default:
			// pi.system and unknown/future kinds: display-only here.
			return undefined;
	}
}

/** Rebuild the active transcript of a durable conversation view. */
export function rebuildTranscript(
	conversationId: string,
	cwd: string,
	entries: readonly EntryRecord[],
): RebuiltTranscript {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		id: conversationId,
		timestamp,
		cwd,
	};
	const mapped: SessionEntry[] = [];
	const idMap = new Map<string, string>();
	let skipped = 0;
	for (const entry of entries) {
		const sessionEntry = entryToSessionEntry(entry, timestamp);
		if (sessionEntry === undefined) {
			skipped++;
			continue;
		}
		mapped.push(sessionEntry);
		idMap.set(String(entry.id), sessionEntry.id);
	}
	// Linearize: each entry's parent is the previous mapped entry (mirrors the
	// durable active-transcript order; ids may be reused but parentage is what
	// getBranch() walks).
	for (let i = 0; i < mapped.length; i++) {
		mapped[i] = { ...mapped[i], parentId: i === 0 ? null : mapped[i - 1]!.id } as SessionEntry;
	}
	return { fileEntries: [header, ...mapped], idMap, stats: { mapped: mapped.length, skipped } };
}

function contentTextOf(message: { content?: unknown }): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
		.map((block) => block.text)
		.join("\n");
}
