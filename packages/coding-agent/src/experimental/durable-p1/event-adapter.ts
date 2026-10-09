// durable-p1 spike: translates the durable agent event stream (packages/durable
// src/harness/events.ts, spec §9.4) into pi-agent-core AgentEvents that
// AgentSession._handleAgentEvent and the interactive TUI already understand.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Message } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import type { AgentEvent as DurableEvent, EntryRecord, JsonObject, MessageChange } from "@earendil-works/pi-durable";

type ContentBlock = AssistantMessage["content"][number];

/** Translate one batch of durable events; stateful across batches of a run. */
export class DurableEventAdapter {
	private partial: AssistantMessage | undefined;
	private readonly toolArgs = new Map<string, JsonObject>();
	private readonly toolOutput = new Map<string, string>();
	private runMessages: AgentMessage[] = [];
	private turnMessage: AgentMessage | undefined;
	private turnToolResults: ToolResultMessage[] = [];

	/** Reset per-run tracking. Call when a run starts. */
	startRun(): void {
		this.runMessages = [];
	}

	translate(batch: readonly DurableEvent[]): AgentEvent[] {
		const out: AgentEvent[] = [];
		for (const event of batch) out.push(...this.translateOne(event));
		return out;
	}

	private translateOne(event: DurableEvent): AgentEvent[] {
		const out: AgentEvent[] = [];
		switch (event.type) {
			case "snapshot":
			case "inbox_update":
			case "submission":
			case "agent_changed":
			case "usage_changed":
			case "task_failed":
			case "deferred_poll":
			case "entry_appended":
				// Structural durable state with no AgentSession counterpart in this spike.
				break;
			case "run_start":
				out.push({ type: "agent_start" });
				break;
			case "turn_start":
				this.turnMessage = undefined;
				this.turnToolResults = [];
				out.push({ type: "turn_start" });
				break;
			case "message_start":
				if (event.message.role === "assistant") {
					// Stream our own copy; message_update deltas apply to it.
					this.partial = cloneAssistant(event.message);
					out.push({ type: "message_start", message: this.partial });
				} else if (event.message.role === "system") {
					// Positional prompt entries (pi.system): stable never emits
					// system messages as agent events, and persisting them would
					// pollute branch stats and drift from the rebuild path.
					break;
				} else {
					out.push({ type: "message_start", message: normalizeUserMessage(event.message) });
				}
				break;
			case "message_update":
				if (this.partial !== undefined) {
					this.partial.usage = event.usage;
					for (const change of event.changes) {
						this.applyChange(this.partial, change);
						// Reconstruct the faithful assistantMessageEvent per change so
						// streaming consumers (think-panel, live-reasoning widgets)
						// see the same event shapes the stock agent emits.
						const assistantMessageEvent = changeToAssistantMessageEvent(change, this.partial);
						if (assistantMessageEvent !== undefined) {
							out.push({ type: "message_update", message: this.partial, assistantMessageEvent });
						}
					}
				}
				break;
			case "message_end": {
				const message = entryMessage(event.entry);
				if (message === undefined) break;
				if (message.role === "system") break; // see message_start
				if (message.role === "assistant") {
					// A streamed assistant already had its message_start from the partial;
					// durable's translate emits message_start itself for the rest.
					if (this.partial === undefined) out.push({ type: "message_start", message });
					this.partial = undefined;
					this.turnMessage = message;
				} else if (message.role === "toolResult") {
					this.turnToolResults.push(message);
				}
				const normalized =
					message.role === "user" ? normalizeUserMessage(message) : (message as AgentMessage);
				out.push({ type: "message_end", message: normalized });
				this.runMessages.push(normalized);
				break;
			}
			case "tool_execution_start":
				this.toolArgs.set(event.toolCallId, event.args);
				out.push({
					type: "tool_execution_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				break;
			case "tool_execution_update": {
				if (event.output === undefined) break;
				let buffer = this.toolOutput.get(event.toolCallId) ?? "";
				if ("set" in event.output) buffer = event.output.set;
				else buffer = buffer.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
				this.toolOutput.set(event.toolCallId, buffer);
				out.push({
					type: "tool_execution_update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: this.toolArgs.get(event.toolCallId) ?? {},
					partialResult: { content: [{ type: "text", text: buffer }] },
				});
				break;
			}
			case "tool_execution_end": {
				const message = event.entry === undefined ? undefined : entryMessage(event.entry);
				const result = message?.role === "toolResult" ? message : undefined;
				this.toolArgs.delete(event.toolCallId);
				this.toolOutput.delete(event.toolCallId);
				out.push({
					type: "tool_execution_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: { content: result?.content ?? [{ type: "text", text: "(no result entry)" }] },
					isError: result?.isError === true,
				});
				break;
			}
			case "turn_end":
				if (this.turnMessage !== undefined) {
					out.push({ type: "turn_end", message: this.turnMessage, toolResults: this.turnToolResults });
				}
				break;
			case "run_end":
				out.push({ type: "agent_end", messages: this.runMessages });
				break;
			// auto_retry_* and compaction_* are AgentSessionEvent-only (the session
			// layer emits them, not the agent); the facade emits them directly.
			case "auto_retry_start":
			case "auto_retry_end":
			case "compaction_start":
			case "compaction_end":
				break;
		}
		return out;
	}

	private applyChange(message: AssistantMessage, change: MessageChange): void {
		switch (change.type) {
			case "text_start":
			case "thinking_start":
			case "toolcall_start":
			case "block":
				message.content[change.contentIndex] = { ...change.block } as ContentBlock;
				break;
			case "text_delta": {
				const block = message.content[change.contentIndex];
				if (block?.type === "text") block.text += change.delta;
				break;
			}
			case "thinking_delta": {
				const block = message.content[change.contentIndex];
				if (block?.type === "thinking") block.thinking += change.delta;
				break;
			}
			case "toolcall_delta": {
				const block = message.content[change.contentIndex];
				if (block?.type === "toolCall") applyToolcallDelta(block, change.path, change.delta);
				break;
			}
			case "message":
				message.content = [...change.message.content];
				message.usage = change.message.usage;
				message.stopReason = change.message.stopReason;
				break;
		}
	}
}

/**
 * Map a durable MessageChange onto the pi-ai AssistantMessageEvent variant
 * the stock agent would have emitted for the same stream step. Returns
 * undefined for changes with no streaming-event counterpart ("block" replaces
 * a block wholesale; "message" is a whole-message sync).
 */
function changeToAssistantMessageEvent(
	change: MessageChange,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (change.type) {
		case "thinking_start":
			return { type: "thinking_start", contentIndex: change.contentIndex, partial };
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "text_start":
			return { type: "text_start", contentIndex: change.contentIndex, partial };
		case "text_delta":
			return { type: "text_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "toolcall_start":
			return { type: "toolcall_start", contentIndex: change.contentIndex, partial };
		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "block": {
			// A completed block replacing its slot = the matching *_end event.
			const block = change.block;
			if (block.type === "thinking") {
				return { type: "thinking_end", contentIndex: change.contentIndex, content: block.thinking, partial };
			}
			if (block.type === "text") {
				return { type: "text_end", contentIndex: change.contentIndex, content: block.text, partial };
			}
			if (block.type === "toolCall") {
				return { type: "toolcall_end", contentIndex: change.contentIndex, toolCall: block, partial };
			}
			return undefined;
		}
		case "message":
			return undefined;
	}
}

function cloneAssistant(message: Message): AssistantMessage {
	const assistant = message as AssistantMessage;
	return { ...assistant, content: assistant.content.map((block) => ({ ...block })) };
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

/** Append a streamed argument delta: onto the JSON string, or a field of a parsed object. */
function applyToolcallDelta(
	block: Extract<ContentBlock, { type: "toolCall" }>,
	path: readonly (string | number)[],
	delta: string,
): void {
	// While args stream they are a JSON string; the final parsed object replaces
	// the block later (tool_execution_start args, then message_end).
	const holder = block as unknown as { arguments: string | JsonObject };
	if (typeof holder.arguments === "string") {
		if (path.length === 0) holder.arguments += delta;
		return;
	}
	if (holder.arguments === null || typeof holder.arguments !== "object" || path.length === 0) return;
	let node: Record<string | number, unknown> = holder.arguments as Record<string | number, unknown>;
	for (let i = 0; i < path.length - 1; i++) {
		const next = node[path[i]];
		if (typeof next !== "object" || next === null) return;
		node = next as Record<string | number, unknown>;
	}
	const last = path[path.length - 1];
	node[last] = `${node[last] ?? ""}${delta}`;
}
