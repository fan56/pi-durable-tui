#!/usr/bin/env node
// durable-p1 entry: boot the STABLE interactive-mode TUI on the durable
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
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
} from "../../core/agent-session-runtime.ts";
import { InteractiveMode } from "../../modes/interactive/interactive-mode.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "../../modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../../modes/interactive/theme/theme-json.ts";
import { createDurableP1Session } from "./durable-agent-session.ts";
import { loadSelection, readGlobalPackages, resolveSelection } from "./extension-picker.ts";
import { p1SessionsRoot } from "./session-location.ts";
import { listSessions } from "./session-meta.ts";
import { durableIdFromCarrierPath } from "./sessions-extension.ts";

type P1 = Awaited<ReturnType<typeof createDurableP1Session>>;
function toRuntimeResult(p1: P1): CreateAgentSessionRuntimeResult {
	return {
		session: p1.session,
		extensionsResult: p1.extensionsResult as CreateAgentSessionRuntimeResult["extensionsResult"],
		modelFallbackMessage: p1.modelFallbackMessage,
		services: p1.services,
		diagnostics: [],
	};
}

interface P1Args {
	continueSession: boolean;
	sessionId: string | undefined;
	provider: string | undefined;
	model: string | undefined;
	noExtensions: boolean;
	extraExtensions: string[];
	list: boolean;
}

function parseArgs(argv: readonly string[]): P1Args {
	const args: P1Args = {
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
				console.error(`durable-p1: ${arg} requires a value`);
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
					console.error(`durable-p1: unknown argument ${arg}`);
					process.exit(1);
				}
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const cwd = realpathSync(process.cwd());

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
			console.error(`durable-p1: saved extension "${dropped}" is not in global settings anymore — skipped`);
		}
		appliedExtensionPaths = resolved.map((r) => r.path);
		args.extraExtensions.push(...appliedExtensionPaths);
	}
}

if (args.list) {
	const sessions = await listSessions(p1SessionsRoot(cwd));
	if (sessions.length === 0) {
		console.log(`No durable-p1 sessions recorded for ${cwd}`);
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
const p1 = await createDurableP1Session({
	...sessionFlags,
	continueSession: args.continueSession,
	...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
});
// The /extensions command (jiti module) reaches back for append-only extension
// loading through this seam — objects cannot travel via process.env.
(globalThis as { __durableP1?: unknown }).__durableP1 = {
	session: p1.session,
	appliedExtensionPaths: new Set(appliedExtensionPaths),
};
setThemeJsonValidator(validateThemeJson);
initTheme(p1.services.settingsManager.getTheme(), true);
setCapabilityOverrides(p1.services.settingsManager.getTerminalCapabilityOverrides());
for (const diagnostic of p1.services.diagnostics) {
	if (diagnostic.type !== "info") console.error(`[durable-p1] ${diagnostic.type}: ${diagnostic.message}`);
}

// The real runtime factory: /new and the /sessions picker switch durable
// sessions through it (v0.4). The stock stable-session paths (/resume over
// JSONL, cross-store /fork and import) refuse with a clear error instead of
// silently creating an unrelated durable session.
const runtimeFactory: CreateAgentSessionRuntimeFactory = async (options) => {
	const reason = options.sessionStartEvent?.reason;
	if (reason === "resume") {
		const file = options.sessionManager.getSessionFile();
		const id = durableIdFromCarrierPath(file ?? "", options.cwd);
		if (id === undefined) {
			throw new Error(
				"durable-p1: switching to non-durable sessions is not supported here — use /sessions to pick a durable session",
			);
		}
		return toRuntimeResult(await createDurableP1Session({ ...sessionFlags, continueSession: false, sessionId: id }));
	}
	if (reason === "fork") {
		throw new Error("durable-p1: cross-store fork is not supported yet (planned)");
	}
	// "new": a fresh durable session directory.
	return toRuntimeResult(await createDurableP1Session({ ...sessionFlags, continueSession: false }));
};
const runtime = new AgentSessionRuntime(p1.session, p1.services, runtimeFactory);
try {
	const interactiveMode = new InteractiveMode(runtime, { modelFallbackMessage: p1.modelFallbackMessage });
	await interactiveMode.run();
} finally {
	await p1.close();
	stopThemeWatcher();
}
