// durable-tui: the activity panel — one viewport above the editor that shows
// whatever the agent is doing RIGHT NOW: live model thinking while it thinks,
// live tool output while a tool runs. The two never run at the same time, so
// a single widget alternates between them instead of two panels stacking.
//
//   row 0    "🧠 Thinking: " / "🔧 bash · sleep 8 && echo ok"  (+ elapsed)
//   row 1..N latest wrapped lines of thinking text / tool output
//
// Colors come from the ACTIVE THEME's semantic keys, so the panel adapts to
// any theme while staying distinct from normal chat: accent-colored icon
// prefix (🧠/🔧), theme "text" body, success/error fg on the settle flash.
// theme.bg() calls are kept for the day widget rows carry backgrounds —
// today the widget pipeline drops bg codes (verified: think-panel's band is
// equally bg-less), so distinction rides on the fg colors.
// Auto-hides: thinking_end hides thinking, tool end flashes ≤2s then hides,
// agent_settled is the safety-net reset.

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { Theme, ThemeBg } from "../../modes/interactive/theme/theme.ts";

const WIDGET_KEY = "durable-tui:activity";
const THINK_PREFIX = "🧠 Thinking: ";
const TOOL_PREFIX = "🔧 ";
const ROWS = 3;
const MAX_RETAINED_CHARS = 4000;
const SETTLE_FLASH_MS = 2000;

type Mode = "idle" | "thinking" | "tool" | "settled";

let tui: TUI | undefined;
let mode: Mode = "idle";
let thinkText = ""; // current thinking block tail (streamed via message_update)
let toolLabel = ""; // "bash · sleep 8 && echo ok"
let toolOutput = ""; // latest partial output tail
let toolStartMs = 0;
let toolError = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let elapsedTicker: ReturnType<typeof setInterval> | undefined;

function requestRender(): void {
	tui?.requestRender();
}

function clearSettleTimer(): void {
	if (settleTimer !== undefined) {
		clearTimeout(settleTimer);
		settleTimer = undefined;
	}
}

function stopTicker(): void {
	if (elapsedTicker !== undefined) {
		clearInterval(elapsedTicker);
		elapsedTicker = undefined;
	}
}

function reset(): void {
	clearSettleTimer();
	stopTicker();
	mode = "idle";
	thinkText = "";
	toolLabel = "";
	toolOutput = "";
	toolError = false;
	requestRender();
}

/** thinking and tool output share the viewport: latest wrapped lines, solid bg band. */
function bandRows(theme: Theme, width: number): string[] {
	let bgKey: ThemeBg;
	let header: string;
	let body: string;
	if (mode === "thinking") {
		bgKey = "customMessageBg";
		header = theme.fg("accent", THINK_PREFIX);
		body = thinkText;
	} else if (mode === "tool") {
		bgKey = "toolPendingBg";
		const elapsed = toolStartMs > 0 ? ` [${Math.max(0, Math.round((Date.now() - toolStartMs) / 1000))}s]` : "";
		header = theme.fg("accent", TOOL_PREFIX) + theme.fg("text", `${toolLabel}${elapsed}`);
		body = toolOutput;
	} else if (mode === "settled") {
		bgKey = toolError ? "toolErrorBg" : "toolSuccessBg";
		const secs = toolStartMs > 0 ? `${Math.max(0, Math.round((Date.now() - toolStartMs) / 1000))}s` : "";
		const mark = toolError ? "✗" : "✓";
		header = theme.fg("accent", TOOL_PREFIX) + theme.fg(toolError ? "error" : "success", `${mark} ${toolLabel} · ${secs}`);
		body = toolOutput;
	} else {
		return [];
	}

	const rows: string[] = [];
	const bg = (s: string) => theme.bg(bgKey, s);
	const row = (s: string) => bg(truncateToWidth(s, width, "…", true));
	rows.push(row(header + truncateToWidth(body.split("\n")[0] ?? "", width, "…", false)));
	// remaining body lines fill up to ROWS-1; newest content stays visible
	if (body.trim() !== "" || mode !== "thinking") {
		const tail = body.length > MAX_RETAINED_CHARS ? body.slice(-MAX_RETAINED_CHARS) : body;
		const wrapped = wrapTextWithAnsi(tail, Math.max(1, width));
		for (const line of wrapped.slice(-(ROWS - 1))) {
			rows.push(row(theme.fg("mdCodeBlock", line)));
		}
	}
	return rows.slice(0, ROWS);
}

/** One-line argument summary for the tool header. */
function summarizeArgs(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url"]) {
		if (typeof a[key] === "string" && (a[key] as string).length > 0) {
			return ` · ${a[key] as string}`;
		}
	}
	try {
		const json = JSON.stringify(args);
		return json !== undefined && json !== "{}" ? ` · ${json}` : "";
	} catch {
		return "";
	}
}

/** Pull readable text out of a tool partial/end result (content blocks or raw). */
function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result === null || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("\n");
}

export default function activityPanelExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		reset();
		ctx.ui.setWidget(WIDGET_KEY, (t, theme) => {
			tui = t;
			return {
				dispose() {
					if (tui === t) tui = undefined;
				},
				invalidate() {
					t.requestRender();
				},
				render(width: number): string[] {
					return bandRows(theme, width);
				},
			};
		});
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx?.mode !== "tui") return;
		const type = (event.assistantMessageEvent as { type?: unknown })?.type;
		if (typeof type !== "string" || !type.startsWith("thinking_")) return;
		if (type === "thinking_end") {
			// thinking pauses here; a tool_start or later thinking_start re-shows
			thinkText = "";
			if (mode === "thinking") reset();
			return;
		}
		const content = (event.message as { content?: unknown } | null)?.content;
		if (!Array.isArray(content)) return;
		thinkText = (content as Array<{ type?: string; thinking?: string }>)
			.filter((part) => part.type === "thinking")
			.map((part) => part.thinking ?? "")
			.join("\n")
			.slice(-MAX_RETAINED_CHARS);
		clearSettleTimer();
		stopTicker();
		mode = "thinking";
		requestRender();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx?.mode !== "tui") return;
		clearSettleTimer();
		thinkText = "";
		toolLabel = `${String(event.toolName)}${summarizeArgs(event.args)}`.slice(0, 120);
		toolOutput = "";
		toolError = false;
		toolStartMs = Date.now();
		mode = "tool";
		// keep the elapsed seconds ticking even when the tool streams nothing
		stopTicker();
		elapsedTicker = setInterval(requestRender, 1000);
		elapsedTicker.unref?.();
		requestRender();
	});

	pi.on("tool_execution_update", (event, ctx) => {
		if (ctx?.mode !== "tui" || mode !== "tool") return;
		toolOutput = resultText(event.partialResult).slice(-MAX_RETAINED_CHARS);
		requestRender();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx?.mode !== "tui") return;
		stopTicker();
		const endMs = Date.now();
		const duration = toolStartMs > 0 ? endMs - toolStartMs : 0;
		toolError = event.isError === true;
		toolOutput = resultText(event.result).slice(-MAX_RETAINED_CHARS);
		toolStartMs = endMs - duration; // freeze the shown elapsed at actual duration
		mode = "settled";
		requestRender();
		clearSettleTimer();
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			if (mode === "settled") reset();
		}, SETTLE_FLASH_MS);
		settleTimer.unref?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		reset();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		tui = undefined;
		reset();
	});
}
