import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { DurableEventAdapter } from "../src/experimental/durable-tui/event-adapter.ts";

type AnyEvent = Record<string, unknown> & { type: string };

/** A conversation view fixture: entries plus built-in documents keyed by kind. */
function view(entries: EntryRecord[], docs: Record<string, unknown> = {}): ConversationView {
	return { conversation: { id: "c1" }, entries, docs } as unknown as ConversationView;
}

/** The `pi.live` document fixture. */
function live(state: Record<string, unknown>): Record<string, unknown> {
	return { "pi.live": state };
}

const RUN = { taskId: "t1", inputs: [], turns: 0 };

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: "" };
}

function assistantEntry(id: string, message: unknown): EntryRecord {
	return { id, kind: "pi.assistant", model: [message] } as unknown as EntryRecord;
}

/** Translate successive views, collecting every emitted event in order. */
function translateViews(adapter: DurableEventAdapter, views: ConversationView[]) {
	const out: AnyEvent[] = [];
	for (const one of views) out.push(...(adapter.translate(one).events as AnyEvent[]));
	return out;
}

describe("DurableEventAdapter", () => {
	test("the first view is baseline: entries are history, a live run is adopted", () => {
		const adapter = new DurableEventAdapter();
		const history = [
			assistantEntry("e0", { role: "assistant", content: [{ type: "text", text: "old" }], timestamp: "" }),
		];
		const step = adapter.translate(view(history, live({ run: { ...RUN } })));
		// History entries are not replayed; the recovered run is announced so
		// abort/settle keeps working.
		expect(step.appendedEntries).toHaveLength(0);
		expect(step.events.map((event) => event.type)).toEqual(["agent_start"]);
	});

	test("run and turn framing", () => {
		const adapter = new DurableEventAdapter();
		const answer = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: "" };
		const events = translateViews(adapter, [
			view([]),
			view([], live({ run: { ...RUN } })),
			view(
				[assistantEntry("e1", answer)],
				live({
					run: { ...RUN },
					generation: {
						attempt: 1,
						message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: "" },
					},
				}),
			),
			view([assistantEntry("e1", answer)], live({ run: { ...RUN } })),
			view([assistantEntry("e1", answer)]),
		]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_update",
			"message_update",
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
		const events = translateViews(adapter, [
			view([]),
			view(
				[],
				live({
					run: { ...RUN },
					generation: { attempt: 1, message: { role: "assistant", content: [], timestamp: "" } },
				}),
			),
			view(
				[],
				live({
					run: { ...RUN },
					generation: {
						attempt: 1,
						usage: { input: 0, output: 0 },
						message: { role: "assistant", content: [{ type: "text", text: "hello world" }], timestamp: "" },
					},
				}),
			),
			view([assistantEntry("e1", finalMessage)], live({ run: { ...RUN } })),
			view([assistantEntry("e1", finalMessage)]),
		]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		// The streamed partial is one live object mutated by the deltas; the
		// final message_end carries the durable entry's message.
		const update = events[4]!["message"] as { content: { type: string; text: string }[] };
		expect(update.content[0]!.text).toBe("hello world");
		const end = events[6]!["message"] as { content: { type: string; text: string }[] };
		expect(end.content[0]!.text).toBe("hello world");
		const delta = events[4]!["assistantMessageEvent"] as { type: string; delta: string };
		expect(delta.type).toBe("text_delta");
		expect(delta.delta).toBe("hello world");
	});

	test("message_update events reconstruct faithful assistantMessageEvent types", () => {
		const adapter = new DurableEventAdapter();
		const message = (content: unknown[]) => ({ role: "assistant", content, timestamp: "" });
		const events = translateViews(adapter, [
			view([]),
			view([], live({ run: { ...RUN }, generation: { attempt: 1, message: message([]) } })),
			// Thinking streams, finishes, and a text block opens after it.
			view(
				[],
				live({
					run: { ...RUN },
					generation: {
						attempt: 1,
						message: message([
							{ type: "thinking", thinking: "hmm" },
							{ type: "text", text: "hi" },
						]),
					},
				}),
			),
		]);
		const updates = events.filter((event) => event.type === "message_update");
		const ameTypes = updates.map((event) => event["assistantMessageEvent"]).map((e) => (e as AnyEvent)["type"]);
		// Each stored-partial step yields the stock streaming event types —
		// including the thinking_end inferred from the text block following it —
		// NOT a uniform "start" (which starved thinking widgets of deltas).
		expect(ameTypes).toEqual(["thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta"]);
		const delta = updates[1]!["assistantMessageEvent"] as AnyEvent;
		expect(delta["delta"]).toBe("hmm");
		const end = updates[2]!["assistantMessageEvent"] as AnyEvent;
		expect(end["content"]).toBe("hmm");
	});

	test("an assistant entry within a run synthesizes its message_start", () => {
		const adapter = new DurableEventAdapter();
		const message = { role: "assistant", content: [{ type: "text", text: "recovered" }], timestamp: "" };
		const events = translateViews(adapter, [
			view([]),
			view([], live({ run: { ...RUN } })),
			view([assistantEntry("e1", message)], live({ run: { ...RUN } })),
		]);
		expect(events.map((event) => event.type)).toEqual(["agent_start", "turn_start", "message_start", "message_end"]);
	});

	test("idle catch-up entries (no run announced) stream nothing", () => {
		const adapter = new DurableEventAdapter();
		const message = { role: "assistant", content: [{ type: "text", text: "from elsewhere" }], timestamp: "" };
		const events = translateViews(adapter, [view([]), view([assistantEntry("e1", message)])]);
		expect(events).toHaveLength(0);
	});

	test("tool execution events carry buffered output and the final result", () => {
		const adapter = new DurableEventAdapter();
		const resultMessage = {
			role: "toolResult",
			content: [{ type: "text", text: "done" }],
			toolCallId: "tc1",
			toolName: "bash",
			isError: false,
		};
		const answer = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }],
			timestamp: "",
		};
		const slot = (status: string, output?: string) =>
			live({
				run: { ...RUN },
				tools: [{ callId: "tc1", name: "bash", status, ...(output === undefined ? {} : { output }) }],
			});
		const events = translateViews(adapter, [
			view([]),
			// The tool-calling answer lands while the run is live.
			view([assistantEntry("e1", answer)], live({ run: { ...RUN } })),
			view([assistantEntry("e1", answer)], slot("running")),
			view([assistantEntry("e1", answer)], slot("running", "a.txt\n")),
			view([assistantEntry("e1", answer)], slot("running", "a.txt\nb.txt\n")),
			// The result entry lands with the slot flipping done.
			view(
				[
					assistantEntry("e1", answer),
					{ id: "e2", kind: "pi.tool-result", model: [resultMessage] } as unknown as EntryRecord,
				],
				live({ run: { ...RUN }, tools: [{ callId: "tc1", name: "bash", status: "done", entry: "e2" }] }),
			),
		]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_update",
			"message_end",
			"tool_execution_end",
		]);
		const start = events[4]!;
		expect(start["args"]).toEqual({ cmd: "ls" });
		const update = events[6]!["partialResult"] as { content: { text: string }[] };
		expect(update.content[0]!.text).toBe("a.txt\nb.txt\n");
		const end = events[8]!;
		expect(end["isError"]).toBe(false);
		const result = end["result"] as { content: { text: string }[] };
		expect(result.content[0]!.text).toBe("done");
	});

	test("new entries after the baseline are appendedEntries; system and compaction entries emit no agent events", () => {
		const adapter = new DurableEventAdapter();
		const baseline = [
			assistantEntry("e0", { role: "assistant", content: [{ type: "text", text: "old" }], timestamp: "" }),
		];
		const first = adapter.translate(view(baseline));
		expect(first.appendedEntries).toHaveLength(0);
		expect(first.events).toHaveLength(0);

		const system = {
			id: "s1",
			kind: "pi.system",
			model: [{ role: "system", content: "prompt" }],
		} as unknown as EntryRecord;
		const compaction = { id: "c1", kind: "pi.compaction", data: { reason: "threshold" } } as unknown as EntryRecord;
		const second = adapter.translate(view([...baseline, system, compaction, assistantEntry("e1", userMessage("q"))]));
		// Structural entries carry no agent events; non-message entries surface
		// through appendedEntries for the facade (compaction materialization).
		expect(second.events).toHaveLength(0);
		expect(second.appendedEntries.map((entry) => entry.id)).toEqual(["s1", "c1", "e1"]);
	});

	test("string user content is normalized to text blocks", () => {
		const adapter = new DurableEventAdapter();
		const raw = { role: "user", content: "plain string input", timestamp: "" };
		const events = translateViews(adapter, [
			view([]),
			view([], live({ run: { ...RUN } })),
			view([{ id: "e1", kind: "pi.user", model: [raw] } as unknown as EntryRecord], live({ run: { ...RUN } })),
		]);
		expect(events.filter((event) => event.type === "message_end")).toHaveLength(1);
		const message = events.find((event) => event.type === "message_end")!["message"] as {
			content: { type: string; text: string }[];
		};
		expect(Array.isArray(message.content)).toBe(true);
		expect(message.content[0]).toEqual({ type: "text", text: "plain string input" });
	});

	test("a streaming partial that vanishes before its entry still ends the run cleanly", () => {
		const adapter = new DurableEventAdapter();
		const events = translateViews(adapter, [
			view([]),
			view(
				[],
				live({
					run: { ...RUN },
					generation: {
						attempt: 1,
						message: { role: "assistant", content: [{ type: "text", text: "par" }], timestamp: "" },
					},
				}),
			),
			// The partial left pi.live with no entry (fault): agent_end still comes.
			view([], live({ run: { ...RUN, turns: 1 } })),
			view([]),
		]);
		expect(events.at(-1)!["type"]).toBe("agent_end");
		expect((events.at(-1)!["messages"] as unknown[]).length).toBe(0);
	});
});
