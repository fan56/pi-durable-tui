// durable-tui: the activity panel — one viewport above the editor that shows
// whatever the agent is doing RIGHT NOW: live model thinking while it thinks,
// live tool output while a tool runs. The two never run at the same time, so
// a single widget alternates between them instead of two panels stacking.
//
// Both modes SCROLL: the viewport always renders the NEWEST wrapped lines
// (think-panel semantics — the prefix rides on the first visible line), so
// long streams keep the latest content on screen. Tool mode pins its status
// header (name + args + ticking elapsed) on row 0 and scrolls output beneath.
//
// Colors are the SAME tokens the native transcript uses — thinkingText for
// thinking, toolTitle/toolOutput for tools, success/error for outcomes — so
// the panel reads as part of the theme, not a parallel style of our own.
// theme.bg() calls are kept for the day widget rows carry backgrounds — today
// the widget pipeline drops bg codes (verified: think-panel's band is too).
//
// While the panel owns live tool display, the transcript stops duplicating
// it: registerToolRenderer rerenders every tool with an empty shell while it
// streams (isPartial) and a one-line ✓/✗ audit when it completes, so history
// keeps a trail but the chat never shows the block twice.
// Auto-hides: each phase dwells DWELL_MS after it truly ends (thinking_end,
// tool end) and then hides; a following phase cancels the dwell.
// agent_settled remains the safety-net reset.

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { Container, Text, truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { Theme, ThemeBg } from "../../modes/interactive/theme/theme.ts";

const WIDGET_KEY = "durable-tui:activity";
const THINK_PREFIX = "🧠 Thinking: ";
const TOOL_PREFIX = "🔧 ";
// default viewport height for BOTH modes (user spec: 7 rows)
const ROWS = 7;
const MAX_RETAINED_CHARS = 4000;
// per-phase dwell: keep the last lines visible 1s after the phase ends
// (thinking_end and tool end alike), then hide. New phases cancel the dwell.
const DWELL_MS = 1000;

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

function scheduleDwellHide(): void {
	clearSettleTimer();
	settleTimer = setTimeout(() => {
		settleTimer = undefined;
		reset();
	}, DWELL_MS);
	settleTimer.unref?.();
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

function bandBgKey(): ThemeBg {
	if (mode === "thinking") return "customMessageBg";
	if (mode === "settled") return toolError ? "toolErrorBg" : "toolSuccessBg";
	return "toolPendingBg";
}

/** Newest-first viewport: thinking scrolls its full height, tool pins a status header. */
function bandRows(theme: Theme, width: number): string[] {
	if (mode === "idle") return [];
	const row = (s: string) => theme.bg(bandBgKey(), truncateToWidth(s, width, "…", true));
	const body = mode === "thinking" ? thinkText : toolOutput;
	const tail = body.length > MAX_RETAINED_CHARS ? body.slice(-MAX_RETAINED_CHARS) : body;
	const wrapped = tail.trim() === "" ? [] : wrapTextWithAnsi(tail, Math.max(1, width));

	if (mode === "thinking") {
		const window = wrapped.slice(-ROWS);
		if (window.length === 0) return [];
		const think = (s: string) => theme.fg("thinkingText", s);
		const rows = [row(theme.italic(think(THINK_PREFIX + window[0]!)))];
		for (let i = 1; i < window.length; i++) rows.push(row(theme.italic(think(window[i]!))));
		return rows;
	}

	const elapsed = toolStartMs > 0 ? Math.max(0, Math.round((Date.now() - toolStartMs) / 1000)) : 0;
	let header: string;
	if (mode === "settled") {
		const mark = toolError ? "✗" : "✓";
		header = theme.fg("toolTitle", theme.bold(`${mark} ${toolLabel} · ${elapsed}s`));
	} else {
		header = theme.fg("toolTitle", theme.bold(`${TOOL_PREFIX}${toolLabel}`)) + theme.fg("muted", ` [${elapsed}s]`);
	}
	const rows = [row(header)];
	for (const line of wrapped.slice(-(ROWS - 1))) rows.push(row(theme.fg("toolOutput", line)));
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
	// The panel owns LIVE tool display; the transcript keeps only a compact
	// completed-result audit line instead of the full duplicated block.
	pi.registerToolRenderer((toolName, next) => ({
		renderShell: "self" as const,
		renderCall: () => new Container(),
		renderResult: (result, options, theme, context) => {
			if (options.isPartial) return new Container();
			// State comes from the content, not just isError: the durable
			// harness reports aborts/failures as "[error] Tool X was aborted"
			// text with isError left undefined.
			const text = resultText(result);
			const interrupted = /interrupt/i.test(text);
			const aborted = /was aborted/i.test(text);
			const errored = result.isError === true || /\[error\]/.test(text);
			const mark = interrupted || aborted ? "⚡" : errored ? "✗" : "✓";
			const fgKey = interrupted || aborted ? "warning" : errored ? "error" : "success";
			const suffix = interrupted ? " · interrupted" : aborted ? " · was aborted" : "";
			const summary = summarizeArgs(context.args);
			return new Text(theme.fg(fgKey, `${mark} ${toolName}${summary}${suffix}`), 0, 0);
		},
	}));

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
			// phase over: dwell on the last lines briefly, then hide; a
			// tool_start or later thinking_start cancels the dwell
			if (mode === "thinking") scheduleDwellHide();
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
		// partials are INCREMENTAL chunks, not cumulative snapshots (verified
		// live: a 40-line streamer delivered one line per update)
		const chunk = resultText(event.partialResult);
		if (chunk !== "") {
			toolOutput = toolOutput === "" ? chunk : `${toolOutput}\n${chunk}`;
			if (toolOutput.length > MAX_RETAINED_CHARS) toolOutput = toolOutput.slice(-MAX_RETAINED_CHARS);
		}
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
		scheduleDwellHide();
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
