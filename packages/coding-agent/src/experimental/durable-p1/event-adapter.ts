// durable-p1 spike: translates the durable agent event stream (packages/durable
// src/harness/events.ts, spec §9.4) into pi-agent-core AgentEvents that
// AgentSession._handleAgentEvent and the interactive TUI already understand.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
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
				} else {
					out.push({ type: "message_start", message: event.message as AgentMessage });
				}
				break;
			case "message_update":
				if (this.partial !== undefined) {
					this.partial.usage = event.usage;
					for (const change of event.changes) this.applyChange(this.partial, change);
					out.push({
						type: "message_update",
						message: this.partial,
						assistantMessageEvent: { type: "start", partial: this.partial },
					});
				}
				break;
			case "message_end": {
				const message = entryMessage(event.entry);
				if (message === undefined) break;
				if (message.role === "assistant") {
					// A streamed assistant already had its message_start from the partial;
					// durable's translate emits message_start itself for the rest.
					if (this.partial === undefined) out.push({ type: "message_start", message });
					this.partial = undefined;
					this.turnMessage = message;
				} else if (message.role === "toolResult") {
					this.turnToolResults.push(message);
				}
				out.push({ type: "message_end", message });
				this.runMessages.push(message);
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

function cloneAssistant(message: Message): AssistantMessage {
	const assistant = message as AssistantMessage;
	return { ...assistant, content: assistant.content.map((block) => ({ ...block })) };
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
