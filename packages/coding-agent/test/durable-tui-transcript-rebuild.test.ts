import { describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	rebuildTranscript,
	unwrapCompactionSummary,
} from "../src/experimental/durable-tui/transcript-rebuild.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** Minimal durable EntryRecord fixture (loose fields on purpose: the branded
 * id/message types are upstream-internal; only rebuildTranscript's runtime
 * shape matters here). */
function entry(fields: object): EntryRecord {
	return { conversationId: "conv-1", ...fields } as unknown as EntryRecord;
}

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: "2026-10-08T00:00:00.000Z" };
}

function assistantMessage(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5 },
		timestamp: "2026-10-08T00:00:01.000Z",
	};
}

describe("unwrapCompactionSummary", () => {
	test("strips the durable summary envelope", () => {
		const wrapped =
			"The conversation history before this point was compacted into the following summary:\n\n<summary>\nKey points.\n</summary>";
		expect(unwrapCompactionSummary(wrapped)).toBe("Key points.");
	});

	test("passes through text without the envelope", () => {
		expect(unwrapCompactionSummary("plain")).toBe("plain");
	});
});

describe("rebuildTranscript", () => {
	test("maps the conversation kinds onto a linear SessionEntry chain", () => {
		const entries = [
			entry({ id: "e1", kind: "pi.system", model: [{ role: "system", content: [], timestamp: "" }] }),
			entry({ id: "e2", kind: "pi.user", model: [userMessage("hello")] }),
			entry({ id: "e3", kind: "pi.assistant", model: [assistantMessage("hi there")] }),
			entry({ id: "e4", kind: "pi.tool-result", model: [{ role: "toolResult", content: [], toolCallId: "tc1", toolName: "bash", isError: false }] }),
			entry({ id: "e5", kind: "pi.reset" }),
		];
		const rebuilt = rebuildTranscript("conv-1", "/tmp/lab", entries);

		// pi.system and the bare pi.reset have no stable counterpart.
		expect(rebuilt.stats).toEqual({ mapped: 3, skipped: 2 });
		expect(rebuilt.fileEntries).toHaveLength(4); // header + 3

		const [header, ...chain] = rebuilt.fileEntries as unknown as [Record<string, unknown>, ...Record<string, unknown>[]];
		expect(header["type"]).toBe("session");
		expect(header["id"]).toBe("conv-1");
		expect(header["cwd"]).toBe("/tmp/lab");

		expect(chain.map((item) => item["type"])).toEqual(["message", "message", "message"]);
		expect(chain[0]!["parentId"]).toBe(null);
		expect(chain[1]!["parentId"]).toBe(chain[0]!["id"]);
		expect(chain[2]!["parentId"]).toBe(chain[1]!["id"]);
		// Entry ids are reused so durable head references stay valid.
		expect(rebuilt.idMap.get("e2")).toBe("e2");
	});

	test("maps a compaction entry with unwrapped summary and head reference", () => {
		const entries = [
			entry({ id: "e1", kind: "pi.user", model: [userMessage("old")] }),
			entry({
				id: "e2",
				kind: "pi.compaction",
				head: "e1",
				data: { reason: "threshold" },
				model: [
					{
						role: "user",
						content: [{ type: "text", text: "<summary>\nThe summary.\n</summary>" }],
						timestamp: "",
					},
				],
			}),
			entry({ id: "e3", kind: "pi.user", model: [userMessage("after")] }),
		];
		const rebuilt = rebuildTranscript("conv-1", "/tmp/lab", entries);
		const compaction = rebuilt.fileEntries.find(
			(item) => (item as { type?: string }).type === "compaction",
		) as { summary: string; firstKeptEntryId: string; tokensBefore: number };
		expect(compaction.summary).toBe("The summary.");
		expect(compaction.firstKeptEntryId).toBe("e1");
		expect(compaction.tokensBefore).toBe(0);
	});

	test("output feeds SessionManager.inMemory and reads back through getBranch", () => {
		const entries = [
			entry({ id: "e1", kind: "pi.user", model: [userMessage("one")] }),
			entry({ id: "e2", kind: "pi.assistant", model: [assistantMessage("two")] }),
		];
		const rebuilt = rebuildTranscript("conv-1", "/tmp/lab", entries);
		const manager = SessionManager.inMemory("/tmp/lab", {}, rebuilt.fileEntries);
		expect(manager.getSessionId()).toBe("conv-1");
		const branch = manager.getBranch();
		expect(branch).toHaveLength(2);
		expect((branch[0] as { message: { content: { text: string }[] } }).message.content[0]!.text).toBe("one");
		expect((branch[1] as { message: { content: { text: string }[] } }).message.content[0]!.text).toBe("two");
	});

	test("pi.reset with a handoff message is kept as a user message", () => {
		const entries = [
			entry({ id: "e1", kind: "pi.reset", model: [userMessage("handoff text")] }),
		];
		const rebuilt = rebuildTranscript("conv-1", "/tmp/lab", entries);
		expect(rebuilt.stats.mapped).toBe(1);
		expect(rebuilt.fileEntries[1]!["type"]).toBe("message");
	});
});
