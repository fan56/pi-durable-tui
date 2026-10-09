// durable-tui (wayfinder tickets 006 route B + 009): the production facade that
// runs the STABLE interactive-mode TUI on the durable Harness. A real
// AgentSession (in-memory SessionManager, real services, engine never runs) is
// driven externally: turn-surface calls (prompt/steer/followUp/abort/compact/
// model mutation) reroute to the durable root Conversation, and durable
// watchEvents batches flow through the session's own pipeline via the
// headless contract (headless-session.ts), so persistence, extension dispatch,
// and the AgentSessionEvent fan-out all run production code.
//
// Host-surface gaps closed here (ticket 009 resolution 6):
//   1. transcript rebuild from durable entries (transcript-rebuild.ts)
//   2. real CompactionResult (summary + entry placement)
//   3. session identity/naming/listing (session-meta.ts sidecars)
//   4. queue-by-text: pendingMessageCount/getSteeringMessages/clearQueue
//   5. agent_settled / queue_update / thinking_level_changed /
//      session_info_changed events
//   6. tool-loadout visibility backed by the durable registry

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord, ModelRef, Submission, ToolRegistration } from "@earendil-works/pi-durable";
import { Harness, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
	AgentSession,
	ModelCycleResult,
	ModelMutationOptions,
	PromptOptions,
	QueuedInputDisposition,
} from "../../core/agent-session.ts";
import { prepareCompaction } from "../../core/compaction/compaction.ts";
import type { CompactionResult } from "../../core/compaction/compaction.ts";
import type { ToolDefinition, ToolInfo } from "../../core/extensions/types.ts";
import type { AgentSessionServices } from "../../core/agent-session-services.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../core/agent-session-services.ts";
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
import { bindHeadlessInternals, type HeadlessSessionContract } from "./headless-session.ts";
import { selectTuiSession, selectTuiSessionById } from "./session-location.ts";
import {
	getCurrentTuiSessionId,
	readMeta,
	setCurrentTuiSessionId,
	updateMeta,
	writeInitialMeta,
} from "./session-meta.ts";
import { createStableToolBridge } from "./tool-bridge.ts";
import { rebuildTranscript } from "./transcript-rebuild.ts";

export interface DurableTuiSessionOptions {
	/** Working directory for the agent and session lookup. */
	cwd: string;
	/** Attach the newest existing session for cwd instead of creating one. */
	continueSession: boolean;
	/** Attach one specific session by its directory id (overrides continueSession). */
	sessionId?: string;
	/** Explicit provider/model override (mirrors stable --provider/--model). */
	model?: { provider?: string; model: string };
	/** Skip loading user/project extensions entirely (stable --no-extensions). */
	noExtensions?: boolean;
	/** Extra extension paths to load (stable -e), on top of the defaults. */
	extraExtensions?: string[];
}

export interface DurableTuiSession {
	session: AgentSession;
	services: AgentSessionServices;
	/** From createAgentSessionFromServices; the runtime factory must return it. */
	extensionsResult: unknown;
	modelFallbackMessage: string | undefined;
	/** Durable directory id (`selectTuiSession*` location id) — resume with --session. */
	locationId: string;
	/** A factory that throws: /new, /resume, /fork, and import stay out of v0.1 scope. */
	throwingRuntimeFactory: () => Promise<never>;
	close(): Promise<void>;
}

/** One queued input plus the submission handle that can withdraw it. */
interface QueuedInput {
	text: string;
	submission: Submission | undefined;
}

export async function createDurableTuiSession(options: DurableTuiSessionOptions): Promise<DurableTuiSession> {
	const context = BACKGROUND_CONTEXT;
	const location =
		options.sessionId === undefined
			? await selectTuiSession(options.cwd, options.continueSession)
			: await selectTuiSessionById(options.cwd, options.sessionId);
	let closed = false;
	let target: AgentSession | undefined;
	let harnessClose: (() => Promise<void>) | undefined;
	let envsCleanup: (() => Promise<void>) | undefined;
	try {
		// The TUI-facing half: real services (settings, models, extensions,
		// themes) and a real AgentSession whose in-process agent never runs.
		const services = await createAgentSessionServices({
			cwd: location.cwd,
			...(options.noExtensions === undefined && options.extraExtensions === undefined
				? {}
				: {
						resourceLoaderOptions: {
							...(options.noExtensions ? { noExtensions: true } : {}),
							...(options.extraExtensions === undefined || options.extraExtensions.length === 0
								? {}
								: { additionalExtensionPaths: options.extraExtensions }),
						},
					}),
		});

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
				onReport: (error) => console.error("[durable-tui] harness:", error),
			},
			context,
		);
		harnessClose = () => harness.close(context);
		const root: Conversation = await harness.root(context, {
			agent: {
				cwd: location.cwd,
			},
		});

		// Initial model: the conversation's own pi.agent doc wins on resume
		// (model choices survive restarts), else settings/CLI defaults.
		const initial =
			options.model === undefined
				? await findInitialAgentModel(services.settingsManager, services.modelRuntime)
				: await findInitialAgentModel(services.settingsManager, services.modelRuntime, options.model);
		if (location.created) {
			// A fresh conversation needs its pi.agent model seeded; a resumed
			// one keeps what it had (configure would clobber the user's pick).
			await root.configure(
				{
					...(initial.model === undefined ? {} : { model: initial.model }),
					...(initial.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
				},
				context,
			);
		}
		const resolvedAgent = await root.agent(context);
		const modelRef: ModelRef | undefined = resolvedAgent.model ?? initial.model;
		const model =
			modelRef === undefined
				? undefined
				: services.modelRuntime.getModel(modelRef.provider, modelRef.modelId);
		const thinkingLevel = (resolvedAgent.thinkingLevel ?? initial.thinkingLevel) as
			| ThinkingLevel
			| undefined;

		// Transcript rebuild: on resume the in-memory SessionManager starts from
		// the durable active entries so the TUI renders history and stats/usage
		// read the real transcript.
		const durableIdToSessionId = new Map<string, string>();
		const rebuilt = location.created
			? undefined
			: rebuildTranscript(String(root.id), location.cwd, (await root.context(context)).entries);
		const sessionManager: SessionManager = location.created
			? // One identity everywhere: the stable manager's session id IS the
				// durable conversation id, so extensions can recognize the current
				// session via ctx.sessionManager.getSessionId() against the sidecar.
				SessionManager.inMemory(location.cwd, { id: String(root.id) })
			: SessionManager.inMemory(location.cwd, {}, rebuilt!.fileEntries);
		if (rebuilt !== undefined) {
			for (const [durableId, sessionId] of rebuilt.idMap) durableIdToSessionId.set(durableId, sessionId);
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model,
			thinkingLevel,
		});
		target = created.session;
		const session = target;
		const internals: HeadlessSessionContract = bindHeadlessInternals(target);
		setCurrentTuiSessionId(location.id);
		await writeInitialMeta(location);
		// The title latch must be durable, not per-facade-instance: switching
		// back to an old session and prompting must not overwrite its title.
		let titleRecorded = (await readMeta(location.directory))?.title !== undefined;
		// Extension-driven pi.sendMessage would race the durable engine on the
		// same SessionManager; refuse it loudly instead (oldfox review #3).
		if (!internals.guardExtensionLlmCalls()) {
			console.error("[durable-tui] could not guard pi.sendMessage (upstream runner shape changed?)");
		}

		// v0.2 tool bridge: mirror every ACTIVE bridged stable tool (the
		// built-in MCP extension's tools are the target case) into the durable
		// registry, and forward durable tool calls as stable tool_call events.
		const toolBridge = createStableToolBridge({ session, registry, cwd: location.cwd });
		internals.onToolRegistryRefresh(() => toolBridge.sync());
		/** Re-sync the mirror; the active-set key gates redundant reinstalls. */
		let lastSyncedActiveKey = "";
		const reconcileToolBridge = (): void => {
			const key = session.getActiveToolNames().join("\n");
			if (key === lastSyncedActiveKey) return;
			lastSyncedActiveKey = key;
			toolBridge.sync();
		};

		// Facade state shared by the overrides and the event ingest path.
		let running = false;
		let compacting = false;
		let abortRequested = false;
		let runStarts = 0;
		// Manual compaction: the compact() override materializes the result
		// itself; the ingest path must not double-append.
		let manualCompaction = false;
		let manualCompactionEntry: EntryRecord | undefined;
		const pendingQueuedInputs: QueuedInput[] = [];
		// Tool-loadout cache for the sync tool surface (ticket 009 gap 6).
		const toolRegistrations = new Map<string, ToolRegistration>();
		let activeToolNames: string[] = [];
		const refreshToolCache = (tools: readonly ToolRegistration[]) => {
			toolRegistrations.clear();
			for (const tool of tools) toolRegistrations.set(tool.name, tool);
			activeToolNames = [...toolRegistrations.keys()];
		};
		refreshToolCache(resolvedAgent.tools);
		const refreshToolCacheFromRegistry = async () => {
			try {
				refreshToolCache((await root.agent(context)).tools);
			} catch (error) {
				console.error("[durable-tui] tool cache refresh failed:", error);
			}
		};
		registry.subscribe(() => void refreshToolCacheFromRegistry());
		// Initial sync AFTER subscribing: the install publication must reach
		// the visibility cache, or mirrored tools stay invisible until the
		// next registry change (oldfox review #7).
		reconcileToolBridge();
		void refreshToolCacheFromRegistry();

		const adapter = new DurableEventAdapter();
		let chain: Promise<void> = Promise.resolve();
		const stream = await watchEvents(harness, root.id, context);

		/** Materialize a durable compaction entry into the session transcript. */
		const materializeCompaction = (entry: EntryRecord, tokensBefore: number): CompactionResult => {
			const message = entry.model?.[0];
			const wrapped = message !== undefined && message.role === "user" ? contentText(message) : "";
			const summaryStart = wrapped.indexOf("<summary>");
			const summaryEnd = wrapped.lastIndexOf("</summary>");
			const summary =
				summaryStart !== -1 && summaryEnd > summaryStart
					? wrapped.slice(summaryStart + "<summary>".length, summaryEnd).trim()
					: wrapped.trim();
			const firstKept =
				entry.head === undefined
					? null
					: (durableIdToSessionId.get(String(entry.head)) ?? null);
			const entryId = sessionManager.appendCompaction(summary, firstKept, tokensBefore);
			durableIdToSessionId.set(String(entry.id), entryId);
			return { summary, firstKeptEntryId: firstKept ?? "", tokensBefore };
		};

		stream.start((events, deliveryContext) => {
			// Batches must be handled strictly in order; ingest awaits extension
			// listeners, so a shared promise chain keeps them sequential.
			const run = chain.then(async () => {
				if (closed) return;
				if (events.some((event) => event.type === "run_start")) {
					running = true;
					runStarts++;
					// Cheap reconciliation: a silently-drifted stable tool set
					// (e.g. setActiveTools without a registry refresh) would
					// otherwise freeze the mirror (oldfox review #4).
					reconcileToolBridge();
				}
				// Structural events the AgentEvent translation does not carry.
				for (const event of events) {
					if (event.type === "entry_appended" && event.entry.kind === "pi.compaction") {
						if (manualCompaction) {
							manualCompactionEntry = event.entry;
						} else {
							// Auto/background compaction during a run: mirror the
							// summary into the transcript and deliver the result.
							const result = materializeCompaction(event.entry, 0);
							const reason =
								(event.entry.data as { reason?: "manual" | "threshold" | "overflow" } | undefined)
									?.reason ?? "threshold";
							internals.emitSessionEvent({
								type: "compaction_end",
								reason,
								result,
								aborted: false,
								willRetry: false,
							});
						}
					}
				}
				const translated = adapter.translate(events);
				for (const event of translated) {
					await internals.ingestAgentEvent(event);
					if (event.type === "message_end") {
						// Keep durable entry ids resolvable to session entry ids
						// (compaction heads reference them).
						const durable = events.find(
							(candidate) =>
								candidate.type === "message_end" && candidate.entry.model?.[0] === event.message,
						);
						if (durable !== undefined) {
							const sessionId = internals.sessionEntryIdOf(event.message);
							if (sessionId !== undefined) {
								durableIdToSessionId.set(
									String((durable as { type: "message_end"; entry: EntryRecord }).entry.id),
									sessionId,
								);
							}
						}
					}
				}
				if (translated.some((event) => event.type === "agent_end")) {
					running = false;
					await internals.emitExtensionEvent({ type: "agent_settled", aborted: abortRequested });
					internals.emitSessionEvent({ type: "agent_settled", aborted: abortRequested });
					abortRequested = false;
				}
				// Retry and compaction progress are AgentSessionEvent-only: the
				// session layer owns them, so emit them straight to the listeners.
				const retrySettings = services.settingsManager.getRetrySettings();
				for (const event of events) {
					if (event.type === "auto_retry_start") {
						internals.emitSessionEvent({
							type: "auto_retry_start",
							attempt: event.attempt,
							maxAttempts: retrySettings.maxRetries,
							delayMs: Math.max(0, event.at - Date.now()),
							errorMessage: event.errorMessage,
						});
					} else if (event.type === "auto_retry_end") {
						internals.emitSessionEvent({
							type: "auto_retry_end",
							success: true,
							attempt: event.attempt,
						});
					} else if (event.type === "compaction_start") {
						if (!manualCompaction) {
							internals.emitSessionEvent({ type: "compaction_start", reason: event.reason });
						}
				} else if (event.type === "agent_changed") {
					// Keep the tool cache honest when the selection changes.
					void refreshToolCacheFromRegistry();
				}
				}
				void deliveryContext;
			});
			chain = run.catch((error) => console.error("[durable-tui] event ingestion failed:", error));
			return chain;
		});

		const recordTitle = (text: string): void => {
			if (titleRecorded) return;
			titleRecorded = true;
			void updateMeta(location.directory, { title: text.slice(0, 120) });
		};

		/** Queueing a registered extension command is an error, as in base. */
		const rejectQueuedExtensionCommand = async (text: string): Promise<void> => {
			if (!text.startsWith("/")) return;
			const spaceIndex = text.indexOf(" ");
			const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
			if (session.extensionRunner.getCommand(commandName) !== undefined) {
				throw new Error(`Cannot queue extension command /${commandName} while the agent is working`);
			}
		};

		const queueInput = async (text: string, behavior: "steer" | "followUp"): Promise<void> => {
			// The parent's queue display: durable delivers the input as a user
			// entry, whose message_start de-queues it again in the pipeline.
			(
				behavior === "followUp" ? internals.followUpMessages : internals.steeringMessages
			).push(text);
			internals.emitQueueUpdate();
			const submission = await root.submit(
				{ type: "input", content: text, whenBusy: behavior },
				context,
			);
			pendingQueuedInputs.push({ text, submission });
			recordTitle(text);
			await submission.wait(context);
		};
		const submitIdle = async (text: string): Promise<void> => {
			running = true;
			abortRequested = false;
			const before = runStarts;
			recordTitle(text);
			const submission = await root.submit({ type: "input", content: text, whenBusy: "steer" }, context);
			await submission.wait(context);
			// If no run ever started (input dropped before a run began), clear
			// the busy flag here; otherwise the agent_end translation clears it.
			if (runStarts === before) {
				await sleep(200);
				if (runStarts === before) running = false;
			}
		};

		const overrides: Record<string, unknown> = {
			prompt: async (text: string, promptOptions?: PromptOptions): Promise<void> => {
				if (promptOptions?.images !== undefined && promptOptions.images.length > 0) {
					throw new Error("durable-tui: images are not supported yet (upstream tools/read limitation)");
				}
				// Extension commands ("/name args") execute immediately, exactly
				// like the base prompt path (e.g. /mcp from the MCP manager).
				// `expandPromptTemplates: false` disables the dispatch, as in base.
				if (text.startsWith("/") && promptOptions?.expandPromptTemplates !== false) {
					const handled = await internals.tryExecuteExtensionCommand(text);
					if (handled) return;
				}
				if (compacting) {
					throw new Error(
						"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
					);
				}
				// Host-synthesized input events (ticket 009 resolution 5): run
				// extension input handlers exactly like the base prompt path.
				const handled = await internals.runInputHandlers(
					text,
					promptOptions?.source ?? "interactive",
					promptOptions?.streamingBehavior,
				);
				if (handled === undefined) return;
				if (running) {
					if (promptOptions?.streamingBehavior === undefined) {
						throw new Error(
							"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
						);
					}
					await queueInput(handled.text, promptOptions.streamingBehavior);
					return;
				}
				await submitIdle(handled.text);
			},
			steer: async (text: string): Promise<QueuedInputDisposition> => {
				await rejectQueuedExtensionCommand(text);
				const handled = await internals.runInputHandlers(text, "interactive", "steer");
				if (handled === undefined) return "handled";
				if (running) await queueInput(handled.text, "steer");
				else await submitIdle(handled.text);
				return "queued";
			},
			followUp: async (text: string): Promise<QueuedInputDisposition> => {
				await rejectQueuedExtensionCommand(text);
				const handled = await internals.runInputHandlers(text, "interactive", "followUp");
				if (handled === undefined) return "handled";
				if (running) await queueInput(handled.text, "followUp");
				else await submitIdle(handled.text);
				return "queued";
			},
			abort: async (): Promise<void> => {
				if (!running && !compacting) return;
				abortRequested = true;
				await root.abort(context);
			},
			abortCompaction: (): void => {
				// root.abort stops a conversation's work, manual compaction
				// included (R1 §3.1 #6: no compaction-only API upstream yet).
				void root.abort(context);
			},
			compact: async (customInstructions?: string): Promise<CompactionResult> => {
				if (running) await (overrides.abort as () => Promise<void>)();
				compacting = true;
				manualCompaction = true;
				manualCompactionEntry = undefined;
				// Mirror the base ordering: compaction_start fires before any
				// guard, and every failure surfaces as a compaction_end event —
				// the TUI's /compact handler swallows thrown errors by design.
				internals.emitSessionEvent({ type: "compaction_start", reason: "manual" });
				try {
					const modelNow = session.model;
					if (modelNow === undefined) throw new Error("No model selected");
					const settings = services.settingsManager.getCompactionSettings(modelNow);
					const pathEntries = sessionManager.getBranch();
					const preparation = prepareCompaction(pathEntries, settings);
					if (!preparation) {
						const lastEntry = pathEntries[pathEntries.length - 1];
						if (lastEntry?.type === "compaction") throw new Error("Already compacted");
						throw new Error("Nothing to compact (session too small)");
					}
					const tokensBefore = session.getContextUsage()?.tokens ?? 0;
					const taskId = await root.compact(customInstructions, context);
					const receipt = await harness.waitForTask(taskId, context);
					const outcome = receipt.state.outcome;
					if (outcome.status === "aborted") throw new Error("Compaction cancelled");
					if (outcome.status !== "completed") {
						throw new Error(`durable-tui: compaction ${outcome.status}`);
					}
					// The summary entry arrives through the ingest stream (write
					// submission placement); fall back to a newest-first scan.
					let entry: EntryRecord | undefined = manualCompactionEntry;
					for (let attempt = 0; entry === undefined && attempt < 20; attempt++) {
						await sleep(100);
						entry = manualCompactionEntry;
					}
					if (entry === undefined) {
						const page = await root.entries({ order: "descending" }, 16, undefined, context);
						entry = page.items.find((candidate) => candidate.kind === "pi.compaction");
					}
					if (entry === undefined) throw new Error("durable-tui: compaction summary entry not found");
					const result = materializeCompaction(entry, tokensBefore);
					internals.emitSessionEvent({
						type: "compaction_end",
						reason: "manual",
						result,
						aborted: false,
						willRetry: false,
					});
					return result;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					internals.emitSessionEvent({
						type: "compaction_end",
						reason: "manual",
						result: undefined,
						aborted: message === "Compaction cancelled",
						willRetry: false,
						errorMessage: message,
					});
					throw error;
				} finally {
					compacting = false;
					manualCompaction = false;
					manualCompactionEntry = undefined;
				}
			},
			setModel: async (model: Model<never>, mutationOptions?: ModelMutationOptions): Promise<void> => {
				await session.setModel(model, mutationOptions);
				const thinking = (session.thinkingLevel ?? "off") as ModelThinkingLevel;
				const ref: ModelRef = { provider: model.provider, modelId: model.id };
				await root.configure(
					{ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) },
					context,
				);
			},
			setThinkingLevel: (level: ThinkingLevel, mutationOptions?: ModelMutationOptions): void => {
				session.setThinkingLevel(level, mutationOptions);
				void root.configure({ thinkingLevel: level as ModelThinkingLevel }, context).catch(() => {});
			},
			cycleThinkingLevel: (mutationOptions?: ModelMutationOptions): ThinkingLevel | undefined => {
				const level = session.cycleThinkingLevel(mutationOptions);
				if (level !== undefined) {
					void root
						.configure({ thinkingLevel: level as ModelThinkingLevel }, context)
						.catch(() => {});
				}
				return level;
			},
			cycleModel: async (
				direction?: "forward" | "backward",
				mutationOptions?: ModelMutationOptions,
			): Promise<ModelCycleResult | undefined> => {
				const result = await session.cycleModel(direction, mutationOptions);
				if (result !== undefined && result.model !== undefined) {
					const ref: ModelRef = { provider: result.model.provider, modelId: result.model.id };
					await root.configure(
						{
							model: ref,
							thinkingLevel: clampThinkingLevel(
								result.model,
								(session.thinkingLevel ?? "off") as ModelThinkingLevel,
							),
						},
						context,
					);
				}
				return result;
			},
			setSessionName: (name: string): void => {
				session.setSessionName(name);
				void updateMeta(location.directory, { name });
			},
			clearQueue: (): { steering: string[]; followUp: string[] } => {
				// Withdraw the durable inbox copies before clearing the mirror.
				for (const queued of pendingQueuedInputs.splice(0)) {
					void queued.submission?.abort(context).catch(() => {});
				}
				return session.clearQueue();
			},
			getActiveToolNames: (): string[] => [...activeToolNames],
			getCallableToolNames: (): string[] => [...activeToolNames],
			getAllTools: (): ToolInfo[] =>
				[...toolRegistrations.values()].map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})) as ToolInfo[],
			getToolDefinition: (name: string): ToolDefinition | undefined =>
				toolRegistrations.get(name) as unknown as ToolDefinition | undefined,
			setActiveToolsByName: (names: readonly string[]): void => {
				const snapshot = registry.snapshot();
				const all = snapshot.tools().map((pair) => pair.tool);
				const removals = all.filter((tool) => !names.includes(tool.name));
				if (removals.length === 0) return;
				void root
					.configure({ tools: { remove: removals } }, context)
					.then(() => {
						refreshToolCacheFromRegistry();
						// Active-set changes bypass _refreshToolRegistry; keep the
						// mirror honest (oldfox review C2).
						reconcileToolBridge();
					})
					.catch((error) => console.error("[durable-tui] setActiveToolsByName failed:", error));
			},
			waitForIdle: async (): Promise<void> => {
				while (running || compacting) await sleep(100);
			},
			// /extensions append-only loading: /reload re-resolves this exact array
			// (the loader has no public mutator and no remove channel), so
			// pushing here is the only way a running boot can gain packages.
			addExtensionPaths: (paths: string[]): void => {
				const loader = services.resourceLoader as unknown as { additionalExtensionPaths?: string[] };
				if (!Array.isArray(loader.additionalExtensionPaths)) {
					throw new Error(
						"durable-tui: resource loader no longer exposes additionalExtensionPaths (upstream change?)",
					);
				}
				loader.additionalExtensionPaths.push(...paths);
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
				return typeof value === "function"
					? (value as (...args: unknown[]) => unknown).bind(t)
					: value;
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
					console.error("[durable-tui] close step failed:", error);
				}
			}
		}

		// Recovered work from an interrupted turn continues now.
		harness.resume();
		const throwingRuntimeFactory = async (): Promise<never> => {
			throw new Error(
				"durable-tui: /new, /resume, /fork, and import are planned for v0.4 (session management)",
			);
		};
		return {
			session: proxy,
			services,
			extensionsResult: created.extensionsResult,
			modelFallbackMessage: initial.fallbackMessage,
			locationId: location.id,
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

function contentText(message: { content?: unknown }): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text",
		)
		.map((block) => block.text)
		.join("\n");
}
