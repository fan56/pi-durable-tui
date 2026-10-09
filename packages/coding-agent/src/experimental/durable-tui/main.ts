#!/usr/bin/env node
// durable-tui entry: boot the STABLE interactive-mode TUI on the durable
// Harness through the AgentSession facade (wayfinder tickets 006/009).
//
// A deliberate subset of stable's flags:
//   --continue, -c          attach the newest durable session for this cwd
//   --provider P --model M  explicit initial model
//   --no-extensions, -ne    skip user/project extensions entirely
//   -e, --extension PATH    load one extra extension (repeatable)
//   --list                  print the sessions recorded for this cwd and exit
//   -h, --help              usage

import { realpathSync } from "node:fs";
import chalk from "chalk";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
} from "../../core/agent-session-runtime.ts";
import { InteractiveMode } from "../../modes/interactive/interactive-mode.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "../../modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../../modes/interactive/theme/theme-json.ts";
import { createDurableTuiSession } from "./durable-agent-session.ts";
import { loadSelection, readGlobalPackages, resolveSelection } from "./extension-picker.ts";
import { migrateLegacySessionsRoot, tuiSessionsRoot } from "./session-location.ts";
import { listSessions } from "./session-meta.ts";
import { durableIdFromCarrierPath } from "./sessions-extension.ts";

type TuiSession = Awaited<ReturnType<typeof createDurableTuiSession>>;
function toRuntimeResult(tui: TuiSession): CreateAgentSessionRuntimeResult {
	return {
		session: tui.session,
		extensionsResult: tui.extensionsResult as CreateAgentSessionRuntimeResult["extensionsResult"],
		modelFallbackMessage: tui.modelFallbackMessage,
		services: tui.services,
		diagnostics: [],
	};
}

interface TuiArgs {
	continueSession: boolean;
	sessionId: string | undefined;
	provider: string | undefined;
	model: string | undefined;
	noExtensions: boolean;
	extraExtensions: string[];
	list: boolean;
}

function parseArgs(argv: readonly string[]): TuiArgs {
	const args: TuiArgs = {
		continueSession: false,
		sessionId: undefined,
		provider: undefined,
		model: undefined,
		noExtensions: false,
		extraExtensions: [],
		list: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const value = () => {
			const next = argv[++i];
			if (next === undefined) {
				console.error(`durable-tui: ${arg} requires a value`);
				process.exit(1);
			}
			return next;
		};
		switch (arg) {
			case "--continue":
			case "-c":
				args.continueSession = true;
				break;
			case "--provider":
				args.provider = value();
				break;
			case "--model":
				args.model = value();
				break;
			case "--no-extensions":
			case "-ne":
				args.noExtensions = true;
				break;
			case "--extension":
			case "-e":
				args.extraExtensions.push(value());
				break;
			case "--session":
				args.sessionId = value();
				break;
			case "--list":
				args.list = true;
				break;
			case "--help":
			case "-h":
				process.stdout.write(
					"usage: main.ts [--continue|-c] [--session ID] [--provider P --model M] [--no-extensions|-ne] [-e PATH]... [--list]\n",
				);
				process.exit(0);
				break;
			default:
				if (arg.startsWith("--provider=")) args.provider = arg.slice("--provider=".length);
				else if (arg.startsWith("--model=")) args.model = arg.slice("--model=".length);
				else {
					console.error(`durable-tui: unknown argument ${arg}`);
					process.exit(1);
				}
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const cwd = realpathSync(process.cwd());
// Carry pre-rename sessions (durable-p1-sessions) over before anything reads
// the sessions root — --list, clean boots, and full-mode boots all attach.
migrateLegacySessionsRoot();

// --- startup extension selection ---------------------------------------------
// First boot: no selection file → none of the global packages load (clean
// base + builtin MCP). Once /extensions has saved a selection, clean-mode boots
// resolve its names against the global settings packages and append each as
// an extra extension. Full mode (--with-extensions, i.e. no -ne) loads
// everything and ignores the selection entirely.
let appliedExtensionPaths: string[] = [];
if (!args.list && args.noExtensions) {
	const globalPackages = await readGlobalPackages();
	const saved = await loadSelection();
	if (saved !== undefined && saved.length > 0) {
		const resolved = resolveSelection(saved, globalPackages);
		for (const dropped of saved.filter((n) => !resolved.some((r) => r.name === n))) {
			console.error(`durable-tui: saved extension "${dropped}" is not in global settings anymore — skipped`);
		}
		appliedExtensionPaths = resolved.map((r) => r.path);
		args.extraExtensions.push(...appliedExtensionPaths);
	}
}

if (args.list) {
	const sessions = await listSessions(tuiSessionsRoot(cwd));
	if (sessions.length === 0) {
		console.log(`No durable-tui sessions recorded for ${cwd}`);
	} else {
		for (const session of sessions) {
			const name = session.name === undefined ? "" : `  name: ${session.name}`;
			const title = session.title === undefined ? "" : `  ${session.title.slice(0, 60)}`;
			console.log(`${session.createdAt}  ${session.id}${name}${title}`);
		}
	}
	process.exit(0);
}

const sessionFlags = {
	cwd,
	...(args.model === undefined
		? {}
		: { model: { ...(args.provider ? { provider: args.provider } : {}), model: args.model } }),
	...(args.noExtensions ? { noExtensions: true } : {}),
	// The /sessions picker ships with the entry itself; explicit CLI paths
	// (and even --no-extensions) keep it loaded.
	extraExtensions: [
		...(args.extraExtensions.length > 0 ? args.extraExtensions : []),
		new URL("./sessions-extension.ts", import.meta.url).pathname,
		new URL("./extensions-manager.ts", import.meta.url).pathname,
	],
};
const tui = await createDurableTuiSession({
	...sessionFlags,
	continueSession: args.continueSession,
	...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
});
// The /extensions command (jiti module) reaches back for append-only extension
// loading through this seam — objects cannot travel via process.env.
(globalThis as { __durableTui?: unknown }).__durableTui = {
	session: tui.session,
	appliedExtensionPaths: new Set(appliedExtensionPaths),
};
setThemeJsonValidator(validateThemeJson);
initTheme(tui.services.settingsManager.getTheme(), true);
setCapabilityOverrides(tui.services.settingsManager.getTerminalCapabilityOverrides());
for (const diagnostic of tui.services.diagnostics) {
	if (diagnostic.type !== "info") console.error(`[durable-tui] ${diagnostic.type}: ${diagnostic.message}`);
}

// The real runtime factory: /new and the /sessions picker switch durable
// sessions through it (v0.4). The stock stable-session paths (/resume over
// JSONL, cross-store /fork and import) refuse with a clear error instead of
// silently creating an unrelated durable session.
// currentLocationId tracks the LIVE session across switches so the exit hint
// resumes what the user was last in, not the boot-time session.
let currentLocationId = tui.locationId;
// InteractiveMode's quit path ends in process.exit(0), so a finally block
// would never run. Node runs synchronous "exit" listeners on process.exit —
// that's our only reliable hook for the resume hint.
process.on("exit", () => {
	printResumeHint(currentLocationId);
});
const runtimeFactory: CreateAgentSessionRuntimeFactory = async (options) => {
	const reason = options.sessionStartEvent?.reason;
	if (reason === "resume") {
		const file = options.sessionManager.getSessionFile();
		const id = durableIdFromCarrierPath(file ?? "", options.cwd);
		if (id === undefined) {
			throw new Error(
				"durable-tui: switching to non-durable sessions is not supported here — use /sessions to pick a durable session",
			);
		}
		const next = await createDurableTuiSession({ ...sessionFlags, continueSession: false, sessionId: id });
		currentLocationId = next.locationId;
		return toRuntimeResult(next);
	}
	if (reason === "fork") {
		throw new Error("durable-tui: cross-store fork is not supported yet (planned)");
	}
	// "new": a fresh durable session directory.
	const next = await createDurableTuiSession({ ...sessionFlags, continueSession: false });
	currentLocationId = next.locationId;
	return toRuntimeResult(next);
};
const runtime = new AgentSessionRuntime(tui.session, tui.services, runtimeFactory);
try {
	const interactiveMode = new InteractiveMode(runtime, { modelFallbackMessage: tui.modelFallbackMessage });
	await interactiveMode.run();
} finally {
	await tui.close();
	stopThemeWatcher();
}

/** Mirror stable's exit line: the exact command that reattaches this session. */
function printResumeHint(locationId: string): void {
	if (!process.stdout.isTTY) return;
	// execArgv carries the preload flags (--import source-resolver.ts, tsx,
	// etc.) that argv strips — without them the reconstructed command would
	// resolve workspace imports against package dist and fail to boot.
	const command = [process.execPath, ...process.execArgv, ...process.argv.slice(1), "--session", locationId]
		.map(quoteArg)
		.join(" ");
	process.stdout.write(`${chalk.dim("To resume this session:")} ${command}\n`);
}

function quoteArg(value: string): string {
	if (!/[^a-zA-Z0-9_\-./~:@=]/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
