// Startup extension selection: which of the global settings packages a
// clean-mode (-ne) boot should load. The choice is persisted by the /ext
// command (see extensions-manager.ts) and applied silently on later boots.
// The durable sessions extension and the builtin MCP are not part of the
// choice — the launcher/main always wires those.

import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";

export interface PackageEntry {
	/** basename of the package directory, stable across reinstalls */
	name: string;
	/** absolute path, global-settings relative paths resolved */
	path: string;
}

export function extensionSelectionPath(): string {
	const override = process.env.PI_DURABLE_EXT_CONFIG;
	if (override !== undefined && override !== "") return override;
	return join(getAgentDir(), "durable-tui-extensions.json");
}

const LEGACY_EXTENSION_SELECTION_PATH = () => join(getAgentDir(), "durable-p1-extensions.json");

/** String package sources from the GLOBAL settings file, resolved + existing. */
export async function readGlobalPackages(): Promise<PackageEntry[]> {
	const settingsPath = join(getAgentDir(), "settings.json");
	let settings: unknown;
	try {
		settings = JSON.parse(await readFile(settingsPath, "utf8"));
	} catch {
		return [];
	}
	const sources = (settings as { packages?: unknown }).packages;
	if (!Array.isArray(sources)) return [];
	const agentDir = getAgentDir();
	const entries: PackageEntry[] = [];
	for (const source of sources) {
		// Object-form package sources (npm specs with filters) are not
		// selectable here: we only broker local directory packages, which is
		// what this setup uses.
		if (typeof source !== "string") continue;
		const path = isAbsolute(source) ? source : resolve(agentDir, source);
		if (!(await stat(path).then((s) => s.isDirectory()).catch(() => false))) continue;
		const name = basename(path);
		if (entries.some((e) => e.name === name)) continue;
		entries.push({ name, path });
	}
	return entries;
}

export async function loadSelection(): Promise<string[] | undefined> {
	// An explicit PI_DURABLE_EXT_CONFIG is authoritative isolation (e2e labs):
	// a missing file there means "no selection" — never fall through to the
	// global paths, or the developer's real selection leaks into every lab.
	const overridden = process.env.PI_DURABLE_EXT_CONFIG !== undefined && process.env.PI_DURABLE_EXT_CONFIG !== "";
	let raw = await readFile(extensionSelectionPath(), "utf8").catch(() => undefined);
	if (raw === undefined && !overridden) {
		// Pre-rename file → carry the choice over once, then read the new path.
		const legacy = await readFile(LEGACY_EXTENSION_SELECTION_PATH(), "utf8").catch(() => undefined);
		if (legacy !== undefined) {
			raw = legacy;
			await writeFile(extensionSelectionPath(), legacy).catch(() => {});
		}
	}
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as { selected?: unknown };
		return Array.isArray(parsed.selected) ? parsed.selected.filter((n): n is string => typeof n === "string") : undefined;
	} catch {
		return undefined;
	}
}

export async function saveSelection(names: readonly string[]): Promise<void> {
	await writeFile(
		extensionSelectionPath(),
		`${JSON.stringify({ selected: [...names], savedAt: new Date().toISOString() }, null, "\t")}\n`,
		"utf8",
	);
}

/** Resolve saved names against the CURRENT package list; drops stale names. */
export function resolveSelection(names: readonly string[], packages: readonly PackageEntry[]): {
	path: string;
	name: string;
}[] {
	const byName = new Map(packages.map((p) => [p.name, p]));
	const out: { path: string; name: string }[] = [];
	for (const name of names) {
		const entry = byName.get(name);
		if (entry !== undefined) out.push(entry);
	}
	return out;
}
