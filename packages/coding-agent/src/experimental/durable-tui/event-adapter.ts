// durable-tui spike: reconstructs pi-agent-core AgentEvents — the stream
// AgentSession._handleAgentEvent and the interactive TUI already understand —
// from durable conversation-view snapshots (spec §9.3). Upstream durable 1.5
// removed the event stream (watchEvents, spec §9.4): a renderer watches state
// (`Conversation.watch()`), so this adapter diffs successive ConversationView
// values — transcript entries plus the `pi.live` document — and re-derives the
// event shapes the stock agent would have emitted for the same steps.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	JsonObject as AiJsonObject,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
} from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import type { ConversationView, EntryRecord, LiveState, ToolSlot } from "@earendil-works/pi-durable";

type ContentBlock = AssistantMessage["content"][number];
/** What the adapter announced about one `pi.live.tools` slot so far. */
interface SlotTrack {
	name: string;
	status: "pending" | "running" | "done";
	args: AiJsonObject | undefined;
	output: string;
}

/** One `translate()` step: the agent events to ingest and the entries that are new since the previous view. */
export interface AdapterStep {
	events: AgentEvent[];
	appendedEntries: readonly EntryRecord[];
}

/** Translate successive conversation views into AgentEvents; stateful across views of a run. */
export class DurableEventAdapter {
	private started = false;
	private runAnnounced = false;
	private partial: AssistantMessage | undefined;
	private partialAttempt: number | undefined;
	/** The streamed blocks that have not been closed with a *_end event yet. */
	private readonly openBlocks = new Set<number>();
	private readonly slots = new Map<string, SlotTrack>();
	private runMessages: AgentMessage[] = [];
	private turnMessage: AgentMessage | undefined;
	private turnToolResults: ToolResultMessage[] = [];
	private readonly seenEntryIds = new Set<string>();
	/** The view being translated; result-entry lookups read its window. */
	private view: ConversationView | undefined;

	/**
	 * Diff one conversation view against the previous one. The first call
	 * establishes the baseline: the entry window is history (no message_end
	 * replay, nothing appended), while live state (`pi.live`) is adopted so a
	 * facade attaching to a recovered run keeps streaming it.
	 */
	translate(view: ConversationView): AdapterStep {
		this.view = view;
		const live = (view.docs["pi.live"] ?? undefined) as LiveState | undefined;
		const running = live?.run !== undefined;

		if (!this.started) {
			this.started = true;
			for (const entry of view.entries) this.seenEntryIds.add(String(entry.id));
			const events: AgentEvent[] = [];
			if (running) {
				this.runAnnounced = true;
				events.push({ type: "agent_start" });
				this.adoptPartial(live, events);
				this.adoptSlots(live, events);
			}
			return { events, appendedEntries: [] };
		}

		const events: AgentEvent[] = [];
		if (running && !this.runAnnounced) {
			this.runAnnounced = true;
			this.runMessages = [];
			events.push({ type: "agent_start" });
		}
		const appended = this.computeAppended(view);
		// The streamed partial first, so the entry that completes it lands after
		// the last deltas (the same commit clears `generation` and places the
		// entry — message_end must not re-announce the message).
		this.syncPartial(live, events);
		this.syncEntries(appended, events);
		this.syncSlots(live, events);
		if (!running) this.endRun(events);
		return { events, appendedEntries: appended };
	}

	/** Entries of this view never seen before, in view order; records them as seen. */
	private computeAppended(view: ConversationView): EntryRecord[] {
		const appended: EntryRecord[] = [];
		for (const entry of view.entries) {
			const id = String(entry.id);
			if (!this.seenEntryIds.has(id)) {
				this.seenEntryIds.add(id);
				appended.push(entry);
			}
		}
		return appended;
	}

	// --- transcript entries -> message_start/message_end/turn framing ---

	private syncEntries(appended: readonly EntryRecord[], events: AgentEvent[]): void {
		for (const entry of appended) {
			const message = entryMessage(entry);
			if (message === undefined) continue;
			if (message.role === "system") continue; // stable never emits system messages as agent events
			if (message.role === "assistant") {
				// A streamed assistant already had its message_start from the partial;
				// its blocks close with the entry (they are final there).
				if (this.partial === undefined) {
					if (this.runAnnounced) {
						if (this.turnMessage !== undefined) events.push(...this.closeTurn());
						events.push({ type: "turn_start" }, { type: "message_start", message });
					}
				} else {
					events.push(...this.closeStreamingBlocks());
				}
				this.partial = undefined;
				this.partialAttempt = undefined;
				this.turnMessage = message;
			} else if (message.role === "user" && this.turnMessage !== undefined && this.runAnnounced) {
				// A user entry while a turn is open starts the next one.
				events.push(...this.closeTurn(), { type: "turn_start" });
			}
			if (!this.runAnnounced) continue; // idle catch-up: record, don't stream
			const normalized = message.role === "user" ? normalizeUserMessage(message) : (message as AgentMessage);
			events.push({ type: "message_end", message: normalized });
			this.runMessages.push(normalized);
			if (message.role === "toolResult") this.turnToolResults.push(message);
		}
	}

	// --- pi.live.generation.message -> message_start/message_update streaming ---

	/** One streaming step: the mutated partial plus the stock per-delta event. */
	private updateEvent(assistantMessageEvent: AssistantMessageEvent): AgentEvent {
		return { type: "message_update", message: this.partial as AssistantMessage, assistantMessageEvent };
	}

	private adoptPartial(live: LiveState | undefined, events: AgentEvent[]): void {
		const streamed = live?.generation?.message;
		if (streamed === undefined) return;
		this.partial = cloneAssistant(streamed as AssistantMessage);
		this.partialAttempt = live?.generation?.attempt;
		this.openBlocks.clear();
		this.partial.content.forEach((_, index) => {
			this.openBlocks.add(index);
		});
		events.push({ type: "turn_start" }, { type: "message_start", message: this.partial });
		// Content that arrived with the first sighting is delivered as the stock
		// start-then-delta pair, so widgets see the text twice-tap they expect.
		this.partial.content.forEach((block, index) => {
			const delta = initialDelta(block);
			if (delta !== undefined && delta.length > 0) {
				events.push(this.deltaEvent(block.type, index, delta));
			}
		});
	}

	private deltaEvent(type: ContentBlock["type"], index: number, delta: string): AgentEvent {
		if (type === "text") {
			return this.updateEvent({
				type: "text_delta",
				contentIndex: index,
				delta,
				partial: this.partial as AssistantMessage,
			});
		}
		return this.updateEvent({
			type: "thinking_delta",
			contentIndex: index,
			delta,
			partial: this.partial as AssistantMessage,
		});
	}

	private syncPartial(live: LiveState | undefined, events: AgentEvent[]): void {
		const generation = live?.generation;
		const streamed = generation?.message as AssistantMessage | undefined;
		if (generation === undefined || streamed === undefined) {
			if (this.partial !== undefined && generation !== undefined && generation.attempt !== this.partialAttempt) {
				// A new attempt opened while the old partial never became an entry
				// (fault): close it; the retried partial is a fresh message.
				events.push(...this.closeStreamingBlocks());
				this.partial = undefined;
				this.partialAttempt = undefined;
				this.openBlocks.clear();
			}
			return;
		}
		if (this.partial !== undefined && generation.attempt !== this.partialAttempt) {
			// Retry: the previous attempt's partial closes, the new one starts.
			events.push(...this.closeStreamingBlocks());
			this.partial = undefined;
			this.partialAttempt = undefined;
		}
		if (this.partial === undefined) {
			this.adoptPartial(live, events);
			return;
		}
		this.partial.usage = streamed.usage;
		const prevContent = this.partial.content;
		const nextContent = streamed.content as ContentBlock[];
		// The stored partial only ever appends blocks in step; a shrink means the
		// response restarted — re-anchor without events, as the old whole-message
		// sync ("message" change) did.
		if (nextContent.length < prevContent.length) {
			this.partial.content = nextContent.map((block) => ({ ...block }));
			this.openBlocks.clear();
			this.partial.content.forEach((_, index) => {
				this.openBlocks.add(index);
			});
			return;
		}
		for (let index = 0; index < nextContent.length; index++) {
			const block = nextContent[index];
			const tracked = prevContent[index];
			if (tracked === undefined || tracked.type !== block.type) {
				// A new block also closes the one before it: the provider finished
				// that block before opening this one.
				const predecessor = index > 0 ? prevContent[index - 1] : undefined;
				if (predecessor !== undefined && this.openBlocks.has(index - 1)) {
					events.push(...this.closeBlock(index - 1, predecessor));
				}
				this.partial.content[index] = { ...block };
				this.openBlocks.add(index);
				if (block.type === "text") {
					events.push(this.updateEvent({ type: "text_start", contentIndex: index, partial: this.partial }));
				} else if (block.type === "thinking") {
					events.push(this.updateEvent({ type: "thinking_start", contentIndex: index, partial: this.partial }));
				} else if (block.type === "toolCall") {
					events.push(this.updateEvent({ type: "toolcall_start", contentIndex: index, partial: this.partial }));
				}
				const delta = initialDelta(block);
				if (delta !== undefined && delta.length > 0) {
					events.push(this.deltaEvent(block.type, index, delta));
				} else if (block.type === "toolCall" && typeof (block as { arguments?: unknown }).arguments === "string") {
					const args = (block as unknown as { arguments: string }).arguments;
					if (args.length > 0) {
						events.push(
							this.updateEvent({
								type: "toolcall_delta",
								contentIndex: index,
								delta: args,
								partial: this.partial,
							}),
						);
					}
				}
				continue;
			}
			const current = { ...tracked };
			this.partial.content[index] = current;
			if (block.type === "text" && current.type === "text") {
				const delta = block.text.slice(current.text.length);
				if (delta.length > 0) {
					current.text = block.text;
					events.push(this.updateEvent({ type: "text_delta", contentIndex: index, delta, partial: this.partial }));
				}
			} else if (block.type === "thinking" && current.type === "thinking") {
				const delta = block.thinking.slice(current.thinking.length);
				if (delta.length > 0) {
					current.thinking = block.thinking;
					events.push(
						this.updateEvent({ type: "thinking_delta", contentIndex: index, delta, partial: this.partial }),
					);
				}
			} else if (block.type === "toolCall" && current.type === "toolCall") {
				applyToolcallBlock(current, block, index, events, this.partial, (ame) => this.updateEvent(ame));
			}
		}
	}

	/** *_end events for every block still open, in index order. */
	private closeStreamingBlocks(): AgentEvent[] {
		const events: AgentEvent[] = [];
		const partial = this.partial;
		if (partial === undefined) {
			this.openBlocks.clear();
			return events;
		}
		for (const index of [...this.openBlocks].sort((a, b) => a - b)) {
			const block = partial.content[index];
			if (block !== undefined) events.push(...this.closeBlock(index, block));
		}
		return events;
	}

	private closeBlock(index: number, block: ContentBlock): AgentEvent[] {
		this.openBlocks.delete(index);
		const partial = this.partial;
		if (partial === undefined) return [];
		if (block.type === "thinking") {
			return [this.updateEvent({ type: "thinking_end", contentIndex: index, content: block.thinking, partial })];
		}
		if (block.type === "text") {
			return [this.updateEvent({ type: "text_end", contentIndex: index, content: block.text, partial })];
		}
		if (block.type === "toolCall") {
			return [this.updateEvent({ type: "toolcall_end", contentIndex: index, toolCall: block, partial })];
		}
		return [];
	}

	// --- pi.live.tools -> tool_execution_* ---

	private adoptSlots(live: LiveState | undefined, events: AgentEvent[]): void {
		// Baseline: announce only calls still in flight; done slots are history.
		for (const slot of live?.tools ?? []) {
			if (slot.status === "done") continue;
			this.slots.set(slot.callId, {
				name: slot.name,
				status: slot.status,
				args: this.resolveArgs(slot.callId, live),
				output: slot.output ?? "",
			});
			events.push({
				type: "tool_execution_start",
				toolCallId: slot.callId,
				toolName: slot.name,
				args: this.slots.get(slot.callId)?.args ?? {},
			});
		}
	}

	private syncSlots(live: LiveState | undefined, events: AgentEvent[]): void {
		for (const slot of live?.tools ?? []) {
			const tracked = this.slots.get(slot.callId);
			if (tracked === undefined) {
				const args = this.resolveArgs(slot.callId, live);
				this.slots.set(slot.callId, {
					name: slot.name,
					status: slot.status,
					args,
					output: slot.output ?? "",
				});
				events.push({
					type: "tool_execution_start",
					toolCallId: slot.callId,
					toolName: slot.name,
					args: args ?? {},
				});
				if (slot.status === "done") {
					// Created and settled between two views.
					events.push(...this.slotEndEvent(slot));
				}
				continue;
			}
			if (tracked.args === undefined) tracked.args = this.resolveArgs(slot.callId, live);
			const output = slot.output ?? "";
			if (slot.status !== "done" && output !== tracked.output) {
				tracked.output = output;
				events.push({
					type: "tool_execution_update",
					toolCallId: slot.callId,
					toolName: slot.name,
					args: tracked.args ?? {},
					partialResult: { content: [{ type: "text", text: output }] },
				});
			}
			if (slot.status === "done" && tracked.status !== "done") {
				tracked.status = "done";
				events.push(...this.slotEndEvent(slot));
			}
		}
		// A slot the view dropped left with its round: already ended, drop quietly.
		for (const callId of [...this.slots.keys()]) {
			if (!(live?.tools ?? []).some((slot) => slot.callId === callId)) this.slots.delete(callId);
		}
	}

	/** tool_execution_end for a settled slot, with the result entry's message when placed. */
	private slotEndEvent(slot: ToolSlot): AgentEvent[] {
		const entry = slot.entry === undefined ? undefined : this.entryById(slot.entry);
		const message = entry === undefined ? undefined : entryMessage(entry);
		const result = message?.role === "toolResult" ? (message as ToolResultMessage) : undefined;
		return [
			{
				type: "tool_execution_end",
				toolCallId: slot.callId,
				toolName: slot.name,
				result: { content: result?.content ?? [{ type: "text", text: "(no result entry)" }] },
				isError: result?.isError === true,
			},
		];
	}

	private entryById(id: EntryRecord["id"]): EntryRecord | undefined {
		return this.view?.entries.find((entry) => String(entry.id) === String(id));
	}

	/** The tool call's parsed arguments: the streamed block first, then the transcript. */
	private resolveArgs(callId: string, live: LiveState | undefined): AiJsonObject | undefined {
		const streamed = live?.generation?.message as AssistantMessage | undefined;
		const fromStream = toolCallArgs(streamed, callId);
		if (fromStream !== undefined) return fromStream;
		for (let index = (this.view?.entries.length ?? 0) - 1; index >= 0; index--) {
			const message = entryMessage(this.view!.entries[index]);
			if (message?.role !== "assistant") continue;
			const args = toolCallArgs(message as AssistantMessage, callId);
			if (args !== undefined) return args;
		}
		return undefined;
	}

	// --- run framing ---

	private closeTurn(): AgentEvent[] {
		if (this.turnMessage === undefined) return [];
		const events: AgentEvent[] = [{ type: "turn_end", message: this.turnMessage, toolResults: this.turnToolResults }];
		this.turnMessage = undefined;
		this.turnToolResults = [];
		return events;
	}

	private endRun(events: AgentEvent[]): void {
		if (!this.runAnnounced) return;
		if (this.partial !== undefined) {
			events.push(...this.closeStreamingBlocks());
			this.partial = undefined;
			this.partialAttempt = undefined;
		}
		if (this.turnMessage !== undefined) events.push(...this.closeTurn());
		// Slots that never settled before the run ended (fault): close them so
		// extension and UI state does not stick.
		for (const [callId, tracked] of [...this.slots]) {
			this.slots.delete(callId);
			if (tracked.status === "done") continue;
			events.push({
				type: "tool_execution_end",
				toolCallId: callId,
				toolName: tracked.name,
				result: { content: [{ type: "text", text: "(no result entry)" }] },
				isError: true,
			});
		}
		this.runAnnounced = false;
		events.push({ type: "agent_end", messages: this.runMessages });
		this.runMessages = [];
	}
}

/** True while tool arguments still stream: a JSON text, not the parsed object. */
function isArgsText(args: unknown): boolean {
	return typeof args === "string";
}

/** The streamed content of a first-sighted block, as its delta: text or thinking. */
function initialDelta(block: ContentBlock): string | undefined {
	if (block.type === "text") return block.text;
	if (block.type === "thinking") return block.thinking;
	return undefined;
}

/** The parsed arguments of the call `callId` in `message`, if it carries them as an object. */
function toolCallArgs(message: AssistantMessage | undefined, callId: string): AiJsonObject | undefined {
	if (message === undefined) return undefined;
	for (const block of message.content ?? []) {
		if (block.type === "toolCall" && block.id === callId && !isArgsText(block.arguments)) return block.arguments;
	}
	return undefined;
}

/**
 * Fold a streamed tool-call block into the tracked partial. While arguments
 * stream they are an accumulated JSON string; the parsed object replaces it
 * once the block completes (the matching toolcall_end event).
 */
function applyToolcallBlock(
	tracked: Extract<ContentBlock, { type: "toolCall" }>,
	block: Extract<ContentBlock, { type: "toolCall" }>,
	index: number,
	events: AgentEvent[],
	partial: AssistantMessage,
	wrap: (assistantMessageEvent: AssistantMessageEvent) => AgentEvent,
): void {
	// While arguments stream they are an accumulated JSON string; the parsed
	// object replaces the field once the block completes (toolcall_end).
	const holder = tracked as unknown as { arguments: string | AiJsonObject };
	const streamed = block as unknown as { arguments: string | AiJsonObject };
	if (typeof holder.arguments === "string" && typeof streamed.arguments === "string") {
		const delta = streamed.arguments.slice(holder.arguments.length);
		if (delta.length > 0) {
			holder.arguments = streamed.arguments;
			events.push(wrap({ type: "toolcall_delta", contentIndex: index, delta, partial }));
		}
		return;
	}
	if (typeof holder.arguments === "string" && typeof streamed.arguments !== "string") {
		// String -> parsed object: the block completed.
		holder.arguments = streamed.arguments;
		events.push(wrap({ type: "toolcall_end", contentIndex: index, toolCall: { ...block }, partial }));
		return;
	}
	holder.arguments = streamed.arguments;
}

function cloneAssistant(message: AssistantMessage): AssistantMessage {
	return { ...message, content: message.content.map((block) => ({ ...block })) };
}

/**
 * durable stores user input as a plain string (submissions.ts writes
 * `content: draft.content`); the stable ecosystem (extensions, stats, the
 * stock TUI paths that assume pi-ai's array form) expects text blocks.
 * Return a normalized copy, leaving array content untouched.
 */
export function normalizeUserMessage(message: Message): AgentMessage {
	if (message.role !== "user" || typeof message.content !== "string") return message as AgentMessage;
	return {
		...message,
		content: [{ type: "text", text: message.content }],
	} as unknown as AgentMessage;
}

function entryMessage(entry: EntryRecord): AgentMessage | undefined {
	const message = entry.model?.[0];
	return message === undefined ? undefined : (message as AgentMessage);
}
