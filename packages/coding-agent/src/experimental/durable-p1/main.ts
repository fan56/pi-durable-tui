#!/usr/bin/env node
// durable-p1 spike entry: boot the STABLE interactive-mode TUI on the durable
// Harness through the AgentSession facade. Wayfinder ticket 006, route B.

import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { InteractiveMode } from "../../modes/interactive/interactive-mode.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "../../modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../../modes/interactive/theme/theme-json.ts";
import { createDurableP1Session } from "./durable-agent-session.ts";

const p1 = await createDurableP1Session(process.argv.includes("--continue"));
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
