import { describe, expect, test } from "vitest";
import { DurableEventAdapter } from "../src/experimental/durable-p1/event-adapter.ts";
import type { AgentEvent as DurableEvent } from "@earendil-works/pi-durable";

type AnyEvent = Record<string, unknown> & { type: string };

function translateBatches(adapter: DurableEventAdapter, batches: AnyEvent[][]) {
	const out: AnyEvent[] = [];
	for (const batch of batches) out.push(...(adapter.translate(batch as readonly DurableEvent[]) as AnyEvent[]));
	return out;
}

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: "" };
}

describe("DurableEventAdapter", () => {
	test("run and turn framing", () => {
		const adapter = new DurableEventAdapter();
		const answer = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: "",
		};
		const events = translateBatches(adapter, [
			[{ type: "run_start", inputs: [] }],
			[{ type: "turn_start" }],
			[
				{ type: "message_start", message: answer },
				{ type: "message_end", entry: { id: "e1", kind: "pi.assistant", model: [answer] } },
			],
			[{ type: "turn_end" }],
			[{ type: "run_end", inputs: [] }],
		]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		// agent_end carries the run's accumulated messages.
		const agentEnd = events.at(-1)!;
		expect(agentEnd["messages"]).toHaveLength(1);
	});

	test("folds streamed assistant deltas into message_start/update/end", () => {
		const adapter = new DurableEventAdapter();
		const finalMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello world" }],
			usage: { input: 1, output: 2 },
			timestamp: "",
		};
		const events = translateBatches(adapter, [
			[
				{
					type: "message_start",
					message: { role: "assistant", content: [], usage: undefined, timestamp: "" },
				},
			],
			[
				{
					type: "message_update",
					usage: { input: 0, output: 0 },
					changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }],
				},
				{
					type: "message_update",
					usage: { input: 0, output: 0 },
					changes: [{ type: "text_delta", contentIndex: 0, delta: "hello world" }],
				},
			],
			[{ type: "message_end", entry: { id: "e1", kind: "pi.assistant", model: [finalMessage] } }],
		]);
		expect(events.map((event) => event.type)).toEqual([
			"message_start",
			"message_update",
			"message_update",
			"message_end",
		]);
		// The streamed partial is one live object mutated by the deltas; the
		// final message_end carries the durable entry's message.
		const lastUpdate = events[2]!["message"] as { content: { type: string; text: string }[] };
		expect(lastUpdate.content[0]!.text).toBe("hello world");
		const end = events[3]!["message"] as { content: { type: string; text: string }[] };
		expect(end.content[0]!.text).toBe("hello world");
	});

	test("user messages pass their durable message_start through", () => {
		const adapter = new DurableEventAdapter();
		const events = translateBatches(adapter, [
			[
				{ type: "message_start", message: userMessage("q") },
				{ type: "message_end", entry: { id: "e1", kind: "pi.user", model: [userMessage("q")] } },
			],
		]);
		expect(events.map((event) => event.type)).toEqual(["message_start", "message_end"]);
	});

	test("an assistant entry without a prior partial synthesizes its message_start", () => {
		const adapter = new DurableEventAdapter();
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "recovered" }],
			timestamp: "",
		};
		const events = translateBatches(adapter, [
			[{ type: "message_end", entry: { id: "e1", kind: "pi.assistant", model: [message] } }],
		]);
		expect(events.map((event) => event.type)).toEqual(["message_start", "message_end"]);
	});

	test("tool execution events carry buffered output and final result", () => {
		const adapter = new DurableEventAdapter();
		const resultMessage = {
			role: "toolResult",
			content: [{ type: "text", text: "done" }],
			toolCallId: "tc1",
			toolName: "bash",
			isError: false,
		};
		const events = translateBatches(adapter, [
			[{ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "ls" } }],
			[
				{
					type: "tool_execution_update",
					toolCallId: "tc1",
					toolName: "bash",
					output: { append: "a.txt\n" },
				},
				{
					type: "tool_execution_update",
					toolCallId: "tc1",
					toolName: "bash",
					output: { trimStart: 0, append: "b.txt\n" },
				},
			],
			[
				{
					type: "tool_execution_end",
					toolCallId: "tc1",
					toolName: "bash",
					entry: { id: "e2", kind: "pi.tool-result", model: [resultMessage] },
				},
			],
		]);
		expect(events.map((event) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_update",
			"tool_execution_end",
		]);
		const update = events[2]!["partialResult"] as { content: { text: string }[] };
		expect(update.content[0]!.text).toBe("a.txt\nb.txt\n");
		const end = events[3]!;
		expect(end["isError"]).toBe(false);
		const result = end["result"] as { content: { text: string }[] };
		expect(result.content[0]!.text).toBe("done");
	});

	test("session-layer-only durable events translate to nothing", () => {
		const adapter = new DurableEventAdapter();
		const events = translateBatches(adapter, [
			[
				{ type: "snapshot", entries: [] },
				{ type: "inbox_update", items: [] },
				{ type: "submission", record: {} },
				{ type: "usage_changed", usage: {} },
				{ type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "x" },
				{ type: "compaction_start", taskId: "t1", reason: "threshold", blocking: true },
			],
		]);
		expect(events).toHaveLength(0);
	});

	test("string user content is normalized to text blocks", () => {
		const adapter = new DurableEventAdapter();
		const raw = { role: "user", content: "plain string input", timestamp: "" };
		const events = translateBatches(adapter, [
			[
				{ type: "message_start", message: raw },
				{ type: "message_end", entry: { id: "e1", kind: "pi.user", model: [raw] } },
			],
		]);
		expect(events.map((event) => event.type)).toEqual(["message_start", "message_end"]);
		for (const event of events) {
			const message = event["message"] as { content: { type: string; text: string }[] };
			expect(Array.isArray(message.content)).toBe(true);
			expect(message.content[0]).toEqual({ type: "text", text: "plain string input" });
		}
	});

	test("system-role messages are dropped (stable parity)", () => {
		const adapter = new DurableEventAdapter();
		const system = { role: "system", content: "positional prompt" };
		const events = translateBatches(adapter, [
			[
				{ type: "message_start", message: system },
				{ type: "message_end", entry: { id: "e0", kind: "pi.system", model: [system] } },
			],
			[{ type: "message_end", entry: { id: "e1", kind: "pi.user", model: [userMessage("q")] } }],
		]);
		// Only the user message survives.
		expect(events.map((event) => event.type)).toEqual(["message_end"]);
	});
});
