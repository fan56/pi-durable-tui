// durable-p1: the "externally driven headless session" contract (wayfinder
// ticket 009, resolution 7). The facade runs a REAL AgentSession whose
// in-process agent never receives a prompt; instead, durable watchEvents
// batches are fed through the session's own event pipeline so persistence to
// the SessionManager, extension dispatch, and the AgentSessionEvent fan-out
// all run the production code path. Upstream keeps `_handleAgentEvent`,
// `_emit`, and friends private, and R4 forbids editing upstream files when a
// new-file alternative exists — so this module is the single, typed place
// that reaches across that boundary. If upstream ever publicizes the seams
// or ships a first-class headless session, delete this file and use theirs.

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { InputSource } from "../../core/extensions/types.ts";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";

/** Input-handler result: `undefined` means an extension consumed the input. */
export type HeadlessInputResult = { text: string; images: ImageContent[] | undefined } | undefined;

/**
 * The private AgentSession members the facade drives, behind public methods.
 * Field types mirror agent-session.ts; the structural cast lives only here.
 */
type SessionInternals = {
	_handleAgentEvent: (event: AgentEvent) => Promise<void>;
	_emit: (event: AgentSessionEvent) => void;
	_emitQueueUpdate: () => void;
	_steeringMessages: string[];
	_followUpMessages: string[];
	_runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<HeadlessInputResult>;
	_entryIdsByMessage: WeakMap<object, string>;
};

/** The public contract over a real session driven by external events. */
export interface HeadlessSessionContract {
	/** Run one agent event through the production pipeline (extensions, listeners, persistence). */
	ingestAgentEvent(event: AgentEvent): Promise<void>;
	/** Emit an AgentSessionEvent directly to subscribers (session-layer-only events). */
	emitSessionEvent(event: AgentSessionEvent): void;
	/** Re-emit the queue display state from the internal queue mirrors. */
	emitQueueUpdate(): void;
	/** Run extension `input` handlers; `undefined` means the input was consumed. */
	runInputHandlers(
		text: string,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<HeadlessInputResult>;
	/** The live queue mirror arrays the base class de-queues from on user message_start. */
	readonly steeringMessages: string[];
	readonly followUpMessages: string[];
	/** Session entry id the pipeline assigned to a persisted message, if any. */
	sessionEntryIdOf(message: object): string | undefined;
	/** Dispatch one extension event (pi.on(...)) through the bound runner. */
	emitExtensionEvent(event: Parameters<AgentSession["extensionRunner"]["emit"]>[0]): Promise<unknown>;
}

/** Bind the contract to a real AgentSession built with a non-running agent. */
export function bindHeadlessInternals(session: AgentSession): HeadlessSessionContract {
	const internals = session as unknown as SessionInternals;
	return {
		ingestAgentEvent: (event) => internals._handleAgentEvent(event),
		emitSessionEvent: (event) => internals._emit(event),
		emitQueueUpdate: () => internals._emitQueueUpdate(),
		runInputHandlers: (text, source, streamingBehavior) =>
			internals._runInputHandlers(text, undefined, source, streamingBehavior),
		get steeringMessages(): string[] {
			return internals._steeringMessages;
		},
		get followUpMessages(): string[] {
			return internals._followUpMessages;
		},
		sessionEntryIdOf: (message) => internals._entryIdsByMessage.get(message),
		emitExtensionEvent: (event) => session.extensionRunner.emit(event),
	};
}
