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
	_tryExecuteExtensionCommand(text: string): Promise<boolean>;
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
	/** Execute a registered extension command ("/name args"); true when handled. */
	tryExecuteExtensionCommand(text: string): Promise<boolean>;
	/** The live queue mirror arrays the base class de-queues from on user message_start. */
	readonly steeringMessages: string[];
	readonly followUpMessages: string[];
	/** Session entry id the pipeline assigned to a persisted message, if any. */
	sessionEntryIdOf(message: object): string | undefined;
	/** Dispatch one extension event (pi.on(...)) through the bound runner. */
	emitExtensionEvent(event: Parameters<AgentSession["extensionRunner"]["emit"]>[0]): Promise<unknown>;
	/**
	 * Invoke `callback` after every tool-registry refresh on the session.
	 * Extension tool registrations (`pi.registerTool`) funnel through
	 * `_refreshToolRegistry`; wrapping it catches those. Active-set-only
	 * changes (`setActiveTools`) do NOT pass here — callers must sync from
	 * their own setActiveTools paths too.
	 */
	onToolRegistryRefresh(callback: () => void): void;
	/**
	 * Extension commands and handlers drive the LLM through `pi.sendMessage`,
	 * which would light up the never-running in-process agent and race the
	 * durable engine on the same SessionManager. Replace those entry points
	 * with loud failures; returns false when the runtime shape changed.
	 */
	guardExtensionLlmCalls(): boolean;
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
		tryExecuteExtensionCommand: (text: string) => internals._tryExecuteExtensionCommand(text),
		get steeringMessages(): string[] {
			return internals._steeringMessages;
		},
		get followUpMessages(): string[] {
			return internals._followUpMessages;
		},
		sessionEntryIdOf: (message) => internals._entryIdsByMessage.get(message),
		emitExtensionEvent: (event) => session.extensionRunner.emit(event),
		onToolRegistryRefresh: (callback) => {
			const holder = session as unknown as Record<string, unknown>;
			if (Object.prototype.hasOwnProperty.call(holder, "_refreshToolRegistry")) {
				throw new Error("headless-session: onToolRegistryRefresh bound twice");
			}
			const prototype = Object.getPrototypeOf(session) as Record<string, unknown>;
			const original = prototype._refreshToolRegistry as (this: AgentSession, ...args: unknown[]) => void;
			if (typeof original !== "function") {
				throw new Error("headless-session: _refreshToolRegistry is not a prototype method (upstream change?)");
			}
			holder._refreshToolRegistry = function (this: AgentSession, ...args: unknown[]) {
				const result = original.apply(this, args);
				try {
					callback();
				} catch (error) {
					console.error("[durable-p1] tool-registry refresh callback failed:", error);
				}
				return result;
			};
		},
		guardExtensionLlmCalls: () => {
			const runner = session.extensionRunner as unknown as {
				runtime?: Record<string, unknown>;
			};
			const runtime = runner?.runtime;
			if (runtime === undefined || !("sendMessage" in runtime) || !("sendUserMessage" in runtime)) {
				return false;
			}
			const refuse =
				(method: string) =>
				(): never => {
					throw new Error(
						`durable-p1: pi.${method} is not supported here — the durable engine owns the conversation loop`,
					);
				};
			runtime.sendMessage = refuse("sendMessage");
			runtime.sendUserMessage = refuse("sendUserMessage");
			return true;
		},
	};
}
