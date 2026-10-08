// durable-p1 spike (wayfinder ticket 006, route B): the stable interactive-mode
// TUI running on the durable Harness. This facade wraps a REAL AgentSession
// (built with an in-memory SessionManager, real services, and the pi default
// model, but an engine that never runs) in a Proxy that reroutes the turn
// surface — prompt/steer/followUp/abort/compact/model mutation — to the durable
// root Conversation, and feeds durable watchEvents through the parent's own
// `_handleAgentEvent` so persistence-to-memory, extension dispatch, and the
// AgentSessionEvent fan-out to the TUI all run the production code path.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Conversation, ModelRef } from "@earendil-works/pi-durable";
import { Harness, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
	AgentSession,
	AgentSessionEvent,
	ModelMutationOptions,
	PromptOptions,
	QueuedInputDisposition,
} from "../../core/agent-session.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../core/agent-session-services.ts";
import type { CompactionResult } from "../../core/compaction/compaction.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { sleep } from "../../utils/sleep.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	ExecutionEnvs,
	findInitialAgentModel,
} from "../durable/harness-setup.ts";
import { Subagent } from "../durable/subagent.ts";
import { DurableEventAdapter } from "./event-adapter.ts";
import { selectP1Session } from "./session-location.ts";

/** Private AgentSession members the facade drives directly. */
type SessionInternals = {
	_handleAgentEvent: (event: AgentEvent) => Promise<void>;
	_emit: (event: AgentSessionEvent) => void;
	_steeringMessages: string[];
	_followUpMessages: string[];
	_emitQueueUpdate: () => void;
};

export interface DurableP1Session {
	session: AgentSession;
	services: AgentSessionServices;
	modelFallbackMessage: string | undefined;
	/** A factory that throws: /new, /resume, /fork, and import are out of scope. */
	throwingRuntimeFactory: () => Promise<never>;
	close(): Promise<void>;
}

export async function createDurableP1Session(continueSession: boolean): Promise<DurableP1Session> {
	const context = BACKGROUND_CONTEXT;
	const location = await selectP1Session(process.cwd(), continueSession);
	let closed = false;
	let target: AgentSession | undefined;
	let harnessClose: (() => Promise<void>) | undefined;
	let envsCleanup: (() => Promise<void>) | undefined;
	try {
		// The TUI-facing half: real services (settings, models, extensions, themes)
		// and a real AgentSession whose in-process agent is never prompted.
		const services = await createAgentSessionServices({ cwd: location.cwd });
		const initial = await findInitialAgentModel(services.settingsManager, services.modelRuntime);
		const model =
			initial.model === undefined
				? undefined
				: services.modelRuntime.getModel(initial.model.provider, initial.model.modelId);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(location.cwd),
			model,
			thinkingLevel: initial.thinkingLevel as ThinkingLevel | undefined,
		});
		target = created.session;
		const internals = target as unknown as SessionInternals;

		// The engine half: the durable Harness with pi's coding tools and prompt.
		const envs = new ExecutionEnvs(location.cwd);
		envsCleanup = () => envs.cleanup(context);
		configureHarnessHttp(services.settingsManager);
		const registry = createCodingRegistry(services.settingsManager, location.cwd);
		registry.install(Subagent);
		const harness: Harness = await Harness.open(
			await openNodeSqliteStorage(location.database),
			{
				models: services.modelRuntime,
				registry,
				settings: createHarnessSettings(services.settingsManager),
				env: envs.env,
				onReport: (error) => console.error("[durable-p1] harness:", error),
			},
			context,
		);
		harnessClose = () => harness.close(context);
		const root: Conversation = await harness.root(context, {
			agent: {
				cwd: location.cwd,
				...(initial.model === undefined ? {} : { model: initial.model }),
				...(initial.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
			},
		});

		// Facade state the overrides below share with the event ingest path.
		let running = false;
		let compacting = false;
		let abortRequested = false;
		let runStarts = 0;
		const adapter = new DurableEventAdapter();
		let chain: Promise<void> = Promise.resolve();
		const stream = await watchEvents(harness, root.id, context);
		stream.start((events, deliveryContext) => {
			// Batches must be handled strictly in order; _handleAgentEvent awaits
			// extension listeners, so a shared promise chain keeps them sequential.
			const run = chain.then(async () => {
				if (closed) return;
				if (events.some((event) => event.type === "run_start")) {
					running = true;
					runStarts++;
				}
				const translated = adapter.translate(events);
				for (const event of translated) await internals._handleAgentEvent(event);
				if (translated.some((event) => event.type === "agent_end")) {
					running = false;
					internals._emit({ type: "agent_settled", aborted: abortRequested });
					abortRequested = false;
				}
				// Retry and compaction events are AgentSessionEvent-only: the session
				// layer owns them, so emit them straight to the listeners.
				const retrySettings = services.settingsManager.getRetrySettings();
				for (const event of events) {
					if (event.type === "auto_retry_start") {
						internals._emit({
							type: "auto_retry_start",
							attempt: event.attempt,
							maxAttempts: retrySettings.maxRetries,
							delayMs: Math.max(0, event.at - Date.now()),
							errorMessage: event.errorMessage,
						});
					} else if (event.type === "auto_retry_end") {
						internals._emit({ type: "auto_retry_end", success: true, attempt: event.attempt });
					} else if (event.type === "compaction_start") {
						internals._emit({ type: "compaction_start", reason: event.reason });
					} else if (event.type === "compaction_end") {
						// A real result would make the TUI rebuild from a session-manager
						// compaction entry this facade never writes; keep it resultless.
						internals._emit({
							type: "compaction_end",
							reason: event.reason,
							result: undefined,
							aborted: false,
							willRetry: false,
						});
					}
				}
				void deliveryContext;
			});
			chain = run.catch((error) => console.error("[durable-p1] event ingestion failed:", error));
			return chain;
		});

		const queueInput = async (text: string, behavior: "steer" | "followUp"): Promise<void> => {
			// The parent's queue display: durable delivers the input as a user entry,
			// whose message_start de-queues it again in _handleAgentEvent.
			(behavior === "followUp" ? internals._followUpMessages : internals._steeringMessages).push(text);
			internals._emitQueueUpdate();
			const submission = await root.submit({ type: "input", content: text, whenBusy: behavior }, context);
			await submission.wait(context);
		};
		const submitIdle = async (text: string): Promise<void> => {
			running = true;
			abortRequested = false;
			const before = runStarts;
			const submission = await root.submit({ type: "input", content: text, whenBusy: "steer" }, context);
			await submission.wait(context);
			// If no run ever started (input dropped before a run began), clear the busy
			// flag here; otherwise the agent_end translation clears it.
			if (runStarts === before) {
				await sleep(200);
				if (runStarts === before) running = false;
			}
		};

		const session = target;
		const overrides: Record<string, unknown> = {
			prompt: async (text: string, options?: PromptOptions): Promise<void> => {
				if (options?.images !== undefined && options.images.length > 0) {
					throw new Error("durable-p1: images are not supported in this spike");
				}
				if (compacting) {
					throw new Error(
						"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
					);
				}
				if (running) {
					if (options?.streamingBehavior === undefined) {
						throw new Error(
							"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
						);
					}
					await queueInput(text, options.streamingBehavior);
					return;
				}
				await submitIdle(text);
			},
			steer: async (text: string): Promise<QueuedInputDisposition> => {
				if (running) await queueInput(text, "steer");
				else await submitIdle(text);
				return "queued";
			},
			followUp: async (text: string): Promise<QueuedInputDisposition> => {
				if (running) await queueInput(text, "followUp");
				else await submitIdle(text);
				return "queued";
			},
			abort: async (): Promise<void> => {
				if (!running && !compacting) return;
				abortRequested = true;
				await root.abort(context);
			},
			abortCompaction: (): void => {
				// root.abort stops a conversation's work, manual compaction included.
				void root.abort(context);
			},
			compact: async (customInstructions?: string): Promise<CompactionResult> => {
				compacting = true;
				try {
					const taskId = await root.compact(customInstructions, context);
					const receipt = await harness.waitForTask(taskId, context);
					const outcome = receipt.state.outcome;
					if (outcome.status === "aborted") throw new Error("Compaction cancelled");
					if (outcome.status !== "completed") {
						throw new Error(`durable-p1: compaction ${outcome.status}`);
					}
					return {
						summary: "(durable compaction summary; chat re-render not wired in this spike)",
						firstKeptEntryId: "",
						tokensBefore: 0,
					};
				} finally {
					compacting = false;
				}
			},
			setModel: async (model: Model<never>, options?: ModelMutationOptions): Promise<void> => {
				await session.setModel(model, options);
				const thinking = (session.thinkingLevel ?? "off") as ModelThinkingLevel;
				const ref: ModelRef = { provider: model.provider, modelId: model.id };
				await root.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
			},
			setThinkingLevel: (level: ThinkingLevel, options?: ModelMutationOptions): void => {
				session.setThinkingLevel(level, options);
				void root.configure({ thinkingLevel: level as ModelThinkingLevel }, context).catch(() => {});
			},
			cycleThinkingLevel: (options?: ModelMutationOptions): ThinkingLevel | undefined => {
				const level = session.cycleThinkingLevel(options);
				if (level !== undefined) {
					void root.configure({ thinkingLevel: level as ModelThinkingLevel }, context).catch(() => {});
				}
				return level;
			},
			waitForIdle: async (): Promise<void> => {
				while (running || compacting) await sleep(100);
			},
			dispose: (): void => {
				session.dispose();
				void closeDurable();
			},
		};
		const proxy = new Proxy(session, {
			get: (t, prop) => {
				if (prop === "isStreaming") return running;
				if (prop === "isIdle") return !running && !compacting && t.isIdle;
				if (prop === "isCompacting") return compacting || t.isCompacting;
				if (prop in overrides) return overrides[prop as string];
				const value = Reflect.get(t, prop, t);
				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
			},
		}) as unknown as AgentSession;

		async function closeDurable(): Promise<void> {
			if (closed) return;
			closed = true;
			for (const step of [
				() => stream.stop(),
				() => harness.close(context),
				() => envs.cleanup(context),
				() => location.release(),
			]) {
				try {
					await step();
				} catch (error) {
					console.error("[durable-p1] close step failed:", error);
				}
			}
		}

		// Recovered work from an interrupted turn continues now.
		harness.resume();
		const throwingRuntimeFactory = async (): Promise<never> => {
			throw new Error("durable-p1: /new, /resume, /fork, and import are not supported in this spike");
		};
		return {
			session: proxy,
			services,
			modelFallbackMessage: initial.fallbackMessage,
			throwingRuntimeFactory,
			close: closeDurable,
		};
	} catch (error) {
		// Best-effort teardown: a later step may have failed after the harness opened.
		if (!closed) {
			closed = true;
			await target?.dispose();
			await envsCleanup?.().catch(() => {});
			await harnessClose?.().catch(() => {});
			await location.release().catch(() => {});
		}
		throw error;
	}
}
