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
import { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { InteractiveMode } from "../../modes/interactive/interactive-mode.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "../../modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../../modes/interactive/theme/theme-json.ts";
import { createDurableP1Session } from "./durable-agent-session.ts";
import { p1SessionsRoot } from "./session-location.ts";
import { listSessions } from "./session-meta.ts";

interface P1Args {
	continueSession: boolean;
	provider: string | undefined;
	model: string | undefined;
	noExtensions: boolean;
	extraExtensions: string[];
	list: boolean;
}

function parseArgs(argv: readonly string[]): P1Args {
	const args: P1Args = {
		continueSession: false,
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
			case "--list":
				args.list = true;
				break;
			case "--help":
			case "-h":
				process.stdout.write(
					"usage: main.ts [--continue|-c] [--provider P --model M] [--no-extensions|-ne] [-e PATH]... [--list]\n",
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

const p1 = await createDurableP1Session({
	cwd,
	continueSession: args.continueSession,
	...(args.model === undefined ? {} : { model: { ...(args.provider ? { provider: args.provider } : {}), model: args.model } }),
	...(args.noExtensions ? { noExtensions: true } : {}),
	...(args.extraExtensions.length > 0 ? { extraExtensions: args.extraExtensions } : {}),
});
setThemeJsonValidator(validateThemeJson);
initTheme(p1.services.settingsManager.getTheme(), true);
setCapabilityOverrides(p1.services.settingsManager.getTerminalCapabilityOverrides());
for (const diagnostic of p1.services.diagnostics) {
	if (diagnostic.type !== "info") console.error(`[durable-p1] ${diagnostic.type}: ${diagnostic.message}`);
}

const runtime = new AgentSessionRuntime(p1.session, p1.services, p1.throwingRuntimeFactory);
try {
	const interactiveMode = new InteractiveMode(runtime, { modelFallbackMessage: p1.modelFallbackMessage });
	await interactiveMode.run();
} finally {
	await p1.close();
	stopThemeWatcher();
}
