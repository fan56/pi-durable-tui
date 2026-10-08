// durable-p1: the extension tool bridge (v0.2). Stable extensions register
// tools through `pi.registerTool`, which lands them in the AgentSession's own
// tool registry — invisible to the durable engine, whose requests offer tools
// from the durable Registry only. This bridge mirrors every ACTIVE bridged
// stable tool into a single durable extension ("pi-bridge-stable-tools") via
// same-name reinstall, adapting the execute signatures. That is what lets
// stable's built-in MCP integration (v1.1.0, src/extensions/mcp) run
// unmodified on the durable backend — the user's v0.2 direction: reuse stable
// MCP, support only pi-powerline-footer otherwise.
//
// Mirrored surface: tools from `builtin:mcp` (however it was loaded) and
// file-loaded extensions. Excluded: stable base tools (their durable
// counterparts live in CodingTools; a same-name mirror would shadow them
// because later installs win) and other builtin extensions (codemode,
// tool-search, llama.cpp need the full stable ExtensionToolContext, which the
// bridge does not provide).
//
// Also bridged: stable `tool_call` extension events, forwarded only for tools
// the stable side itself knows (durable's own read/bash/etc. never reach
// stable handlers). Fail-closed on handler errors — a throwing handler blocks
// the call on both hosts. Argument mutation by tool_call handlers propagates
// through the shared `arguments` reference today; durable clones before hook
// dispatch, this degrades silently (no known consumer mutates).

import { defineExtension, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentSession } from "../../core/agent-session.ts";
import { BUILTIN_PATH_PREFIX } from "../../core/source-info.ts";
import type { ExtensionToolContext, ToolDefinition, ToolCallEvent } from "../../core/extensions/types.ts";

const BRIDGE_EXTENSION_NAME = "pi-bridge-stable-tools";
/** Builtin extensions whose tools run fine on the minimal bridge context. */
const BRIDGED_BUILTIN_EXTENSIONS = new Set(["builtin:mcp"]);

export interface StableToolBridgeOptions {
	/** The facade's real AgentSession (tool source of truth on the stable side). */
	session: AgentSession;
	/** The durable registry the mirrored extension installs into. */
	registry: Registry;
	/** Working directory for the minimal extension tool context. */
	cwd: string;
}

export interface StableToolBridge {
	/** Re-read the stable tool set and reinstall the mirrored extension. */
	sync(): void;
	/** Stable-known tool names at the last sync (used to gate tool_call forwarding). */
	readonly knownToolNames: ReadonlySet<string>;
}

export function createStableToolBridge(options: StableToolBridgeOptions): StableToolBridge {
	const { session, registry, cwd } = options;
	let knownToolNames = new Set<string>();

	const buildToolContext = (): ExtensionToolContext =>
		({
			cwd,
			sessionManager: session.sessionManager,
			get model() {
				return session.model;
			},
			getContextUsage: () => session.getContextUsage(),
			abort: () => void session.abort(),
		}) as unknown as ExtensionToolContext;

	const toolHooks = {
		beforeTool: async (
			call: { id: string; name: string; arguments: Record<string, unknown> },
			_api: unknown,
			context: { abortSignal?: AbortSignal },
		): Promise<{ block?: string } | undefined> => {
			// Durable's own tools (read/bash/...) never reach stable handlers;
			// allowlist-style extensions would otherwise block everything.
			if (!knownToolNames.has(call.name)) return undefined;
			const signal = context.abortSignal;
			const aborted = new Promise<never>((_, reject) => {
				if (signal === undefined) return;
				if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
				else signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
			});
			// Fail-closed: a throwing handler blocks the call (both hosts treat
			// hook throws as block). The abort race keeps durable-side Esc from
			// hanging on handlers that wait on the (never-firing) stable signal.
			const result = (await Promise.race([
				session.extensionRunner.emitToolCall({
					type: "tool_call",
					toolCallId: call.id,
					toolName: call.name,
					input: call.arguments,
				} as ToolCallEvent),
				aborted,
			])) as { block?: boolean; reason?: string } | undefined;
			if (result?.block) return { block: result.reason ?? "blocked by extension" };
			return undefined;
		},
	};

	const bridge: Extension = defineExtension({
		name: BRIDGE_EXTENSION_NAME,
		tools: [],
		hooks: [{ task: "pi.tool", handlers: toolHooks }],
	});

	const adapt = (definition: ToolDefinition): ToolRegistration => ({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		// Extension tools have side effects we cannot classify; never replay.
		replay: "unsafe",
		...(definition.prepareArguments
			? { prepareArguments: (args: unknown) => definition.prepareArguments!(args) }
			: {}),
		async execute(args, api: ToolExecutionApi<JsonValue>, context): Promise<ToolExecutionResult<JsonValue>> {
			const onUpdate = (partial: { content?: { type: string; text?: string }[]; details?: unknown }) => {
				for (const block of partial.content ?? []) {
					if (block.type === "text" && block.text !== undefined) {
						// Late updates after the task settled throw synchronously;
						// stable tolerates them, so drop instead of exploding into
						// the extension's own callback.
						try {
							api.output(block.text);
						} catch {
							/* settled */
						}
					}
				}
				if (partial.details !== undefined) {
					void api
						.details(toJson(partial.details), context)
						.catch(() => undefined);
				}
			};
			try {
				const result = await definition.execute(
					api.callId,
					args as never,
					context.abortSignal,
					onUpdate as never,
					buildToolContext(),
				);
				return {
					content: result.content as ToolExecutionResult<JsonValue>["content"],
					...(result.isError === undefined || result.isError === false ? {} : { isError: true }),
					...(result.details === undefined ? {} : { details: toJson(result.details) }),
					...(result.usage === undefined ? {} : { usage: result.usage }),
					...(result.terminate === true ? { control: { terminate: true } as const } : {}),
				};
			} catch (error) {
				// Stable's contract is "never rejects for tool failures" — the
				// error comes back as an in-band result. Keep durable's task
				// COMPLETED instead of failed; only a real abort rethrows so the
				// durable abort path stays intact.
				if (context.abortSignal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Tool error: ${message}` }], isError: true };
			}
		},
	});

	const shouldBridge = (name: string, path: string): boolean => {
		// Stable base tools (read/bash/...) would collide with durable
		// CodingTools by name; later installs win, so never mirror them.
		if (path === `${BUILTIN_PATH_PREFIX}${name}`) return false;
		// Other builtin extensions need the full stable tool context.
		if (path.startsWith(BUILTIN_PATH_PREFIX) && !BRIDGED_BUILTIN_EXTENSIONS.has(path)) return false;
		return true;
	};

	return {
		get knownToolNames(): ReadonlySet<string> {
			return knownToolNames;
		},
		sync(): void {
			try {
				const infos = new Map(session.getAllTools().map((info) => [info.name, info]));
				const active = session.getActiveToolNames();
				// Never shadow a tool another durable extension already owns.
				const occupied = new Set(
					registry
						.snapshot()
						.tools()
						.filter((entry) => entry.extension.name !== BRIDGE_EXTENSION_NAME)
						.map((entry) => entry.tool.name),
				);
				const tools: ToolRegistration[] = [];
				knownToolNames = new Set();
				for (const name of active) {
					const info = infos.get(name);
					if (info === undefined) continue;
					knownToolNames.add(name);
					if (!shouldBridge(name, info.sourceInfo.path)) continue;
					if (occupied.has(name)) continue;
					const definition = session.getToolDefinition(name);
					if (definition === undefined) continue;
					tools.push(adapt(definition));
				}
				registry.install({
					...bridge,
					tools,
				});
			} catch (error) {
				console.error("[durable-p1] tool bridge sync failed:", error);
			}
		},
	};
}

/** Coerce an arbitrary stable tool details value into a JsonValue. */
function toJson(value: unknown): JsonValue {
	if (value === undefined) return null;
	try {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			return value;
		}
		const parsed: unknown = JSON.parse(JSON.stringify(value));
		return (parsed === undefined ? null : parsed) as JsonValue;
	} catch {
		return String(value);
	}
}
