// durable-tui: the activity panel — one viewport above the editor that shows
// whatever the agent is doing RIGHT NOW: live model thinking while it thinks,
// live tool output while a tool runs. The two never run at the same time, so
// a single widget alternates between them instead of two panels stacking.
//
// Geometry is FIXED while visible (user spec): exactly `rows` rows are always
// rendered — content shorter than the viewport is padded, so the editor never
// jumps around. Default height is 7 rows; `/activity [1|3|5|7|off]` changes
// it, persisted per machine.
//
// The panel stays up ACROSS phase boundaries (thinking → tool → thinking);
// it hides 1s after the agent actually starts streaming its user-facing
// reply (text_* message updates), with agent_settled as the safety net.
//
// Colors are the theme's OWN tokens — thinkingText (dim+italic, exactly what
// transcript thinking uses), toolTitle (bold) for the tool header, toolOutput
// for streamed lines, success/error/warning for outcomes. theme.bg() calls
// are kept for the day widget rows carry backgrounds — today the widget
// pipeline drops bg codes (verified: think-panel's band is too).
//
// While the panel owns live tool display, the transcript stops duplicating
// it: registerToolRenderer rerenders every tool with an empty shell while it
// streams (isPartial) and a one-line ✓/✗/⚡ audit when it completes, so
// history keeps a trail but the chat never shows the block twice.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Container, Text, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { Theme, ThemeBg } from "../../modes/interactive/theme/theme.ts";

const WIDGET_KEY = "durable-tui:activity";
const THINK_PREFIX = "🧠 ";
const TOOL_PREFIX = "🔧 ";
const MAX_RETAINED_CHARS = 4000;
const HIDE_AFTER_MS = 1000;
// default viewport height for BOTH modes (user spec: 7 rows)
const DEFAULT_ROWS = 7;
const ALLOWED_ROWS = [1, 3, 5, 7] as const;
const CONFIG_PATH = () => join(getAgentDir(), "durable-tui-activity.json");

type Mode = "idle" | "thinking" | "tool" | "done";
type DoneFrom = "think" | "tool";

let tui: TUI | undefined;
let mode: Mode = "idle";
let doneFrom: DoneFrom = "tool";
let enabled = true;
let rows = DEFAULT_ROWS;
let thinkText = ""; // current thinking block tail (streamed via message_update)
let toolLabel = ""; // "bash · sleep 8 && echo ok"
let toolOutput = ""; // accumulated partial output tail
let toolStartMs = 0;
let doneMark = "✓";
let doneFgKey: "success" | "error" | "warning" = "success";
let doneSuffix = "";
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let elapsedTicker: ReturnType<typeof setInterval> | undefined;

function requestRender(): void {
	tui?.requestRender();
}

function clearHideTimer(): void {
	if (hideTimer !== undefined) {
		clearTimeout(hideTimer);
		hideTimer = undefined;
	}
}

function stopTicker(): void {
	if (elapsedTicker !== undefined) {
		clearInterval(elapsedTicker);
		elapsedTicker = undefined;
	}
}

/** Hide 1s from now; any new phase cancels it. */
function scheduleHide(): void {
	clearHideTimer();
	hideTimer = setTimeout(() => {
		hideTimer = undefined;
		reset();
	}, HIDE_AFTER_MS);
	hideTimer.unref?.();
}

function reset(): void {
	clearHideTimer();
	stopTicker();
	mode = "idle";
	thinkText = "";
	toolLabel = "";
	toolOutput = "";
	doneSuffix = "";
	requestRender();
}

async function loadConfig(): Promise<void> {
	try {
		const parsed = JSON.parse(await readFile(CONFIG_PATH(), "utf8")) as { rows?: unknown; enabled?: unknown };
		if (parsed.enabled === false) enabled = false;
		if (typeof parsed.rows === "number" && (ALLOWED_ROWS as readonly number[]).includes(parsed.rows)) {
			rows = parsed.rows;
		}
	} catch {
		// no config yet — defaults apply
	}
}

async function saveConfig(): Promise<void> {
	await writeFile(
		CONFIG_PATH(),
		`${JSON.stringify({ rows, enabled, savedAt: new Date().toISOString() }, null, "\t")}\n`,
		"utf8",
	).catch(() => {});
}

function bandBgKey(): ThemeBg {
	if (mode === "thinking" || (mode === "done" && doneFrom === "think")) return "customMessageBg";
	if (mode === "done") return "toolSuccessBg";
	return "toolPendingBg";
}

/**
 * EXACTLY `rows` lines, always — short content is padded so the panel never
 * changes height while visible. Newest content fills the bottom; row 0
 * carries the prefix/header.
 */
function bandRows(theme: Theme, width: number): string[] {
	if (mode === "idle" || !enabled) return [];
	const row = (s: string) => theme.bg(bandBgKey(), truncateToWidth(s, width, "…", true));
	const out: string[] = [];

	const showingTool = mode === "tool" || (mode === "done" && doneFrom === "tool");
	const body = showingTool ? toolOutput : thinkText;
	const tail = body.length > MAX_RETAINED_CHARS ? body.slice(-MAX_RETAINED_CHARS) : body;
	const wrapped = tail.trim() === "" ? [] : wrapTextWithAnsi(tail, Math.max(1, width));
	const latest = wrapped.at(-1) ?? "";

	if (mode === "thinking" || (mode === "done" && doneFrom === "think")) {
		// thinking: newest-first window with the prefix on the first VISIBLE row;
		// a 1-row viewport shows just the newest line
		const window = wrapped.slice(-rows);
		const think = (s: string) => theme.italic(theme.fg("thinkingText", s));
		out.push(
			row(
				wrapped.length === 0
					? think(THINK_PREFIX.trim())
					: think(THINK_PREFIX + (rows === 1 ? latest : window[0]!)),
			),
		);
		for (let i = 1; i < window.length; i++) out.push(row(think(window[i]!)));
	} else {
		let header: string;
		if (mode === "tool") {
			const elapsed = toolStartMs > 0 ? Math.max(0, Math.round((Date.now() - toolStartMs) / 1000)) : 0;
			header = theme.fg("toolTitle", theme.bold(`${TOOL_PREFIX}${toolLabel}`)) + theme.fg("muted", ` [${elapsed}s]`);
			if (rows === 1 && latest !== "") header += theme.fg("toolOutput", ` ${latest}`);
		} else {
			header = theme.fg(doneFgKey, theme.bold(`${doneMark} ${toolLabel}${doneSuffix}`));
			if (rows === 1 && latest !== "") header += theme.fg("toolOutput", ` ${latest}`);
		}
		out.push(row(header));
		for (const line of wrapped.slice(-(rows - 1))) out.push(row(theme.fg("toolOutput", line)));
	}

	while (out.length < rows) out.push(" ");
	return out.slice(0, rows);
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

/** Outcome classification shared by the panel and the transcript audit line. */
function outcomeOf(
	text: string,
	isErrorFlag: boolean,
): { mark: string; fgKey: "success" | "error" | "warning"; suffix: string } {
	const interrupted = /interrupt/i.test(text);
	const aborted = /was aborted/i.test(text);
	const errored = isErrorFlag || /\[error\]/.test(text);
	if (interrupted || aborted) {
		return { mark: "⚡", fgKey: "warning", suffix: interrupted ? " · interrupted" : " · was aborted" };
	}
	return { mark: errored ? "✗" : "✓", fgKey: errored ? "error" : "success", suffix: "" };
}

export default function activityPanelExtension(pi: ExtensionAPI): void {
	// The panel owns LIVE tool display; the transcript keeps only a compact
	// completed-result audit line instead of the full duplicated block.
	pi.registerToolRenderer((toolName, _next) => ({
		renderShell: "self" as const,
		renderCall: () => new Container(),
		renderResult: (result, options, theme, context) => {
			if (options.isPartial) return new Container();
			// State comes from the content, not just isError: the durable
			// harness reports aborts/failures as "[error] Tool X was aborted"
			// text with isError left undefined.
			const outcome = outcomeOf(resultText(result), result.isError === true);
			const summary = summarizeArgs(context.args);
			return new Text(theme.fg(outcome.fgKey, `${outcome.mark} ${toolName}${summary}${outcome.suffix}`), 0, 0);
		},
	}));

	pi.on("session_start", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		void loadConfig();
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
		if (typeof type !== "string") return;
		if (type.startsWith("thinking_")) {
			if (type === "thinking_end") {
				// phase over but the panel STAYS UP (a tool may follow);
				// it hides only when the user-facing reply begins
				if (mode === "thinking") {
					mode = "done";
					doneFrom = "think";
					requestRender();
				}
				return;
			}
			const content = (event.message as { content?: unknown } | null)?.content;
			if (!Array.isArray(content)) return;
			thinkText = (content as Array<{ type?: string; thinking?: string }>)
				.filter((part) => part.type === "thinking")
				.map((part) => part.thinking ?? "")
				.join("\n")
				.slice(-MAX_RETAINED_CHARS);
			clearHideTimer();
			mode = "thinking";
			requestRender();
			return;
		}
		if (type.startsWith("text_")) {
			// the agent is now streaming its reply to the user — retire the
			// panel 1s in; a later phase start cancels this
			if (mode !== "idle") scheduleHide();
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx?.mode !== "tui") return;
		clearHideTimer();
		thinkText = "";
		toolLabel = `${String(event.toolName)}${summarizeArgs(event.args)}`.slice(0, 120);
		toolOutput = "";
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
		const text = resultText(event.result);
		const outcome = outcomeOf(text, event.isError === true);
		toolOutput = text.slice(-MAX_RETAINED_CHARS);
		toolStartMs = endMs - duration; // freeze the shown elapsed at the actual duration
		doneMark = outcome.mark;
		doneFgKey = outcome.fgKey;
		doneSuffix = `${outcome.suffix} · ${Math.round(duration / 1000)}s`;
		doneFrom = "tool";
		mode = "done";
		requestRender();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		// safety net — normally the text_* path already retired the panel
		if (mode !== "idle") scheduleHide();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		tui = undefined;
		reset();
	});

	pi.registerCommand("activity", {
		description: "活动面板（think+tool 视口）：/activity [1|3|5|7|off|status]（持久化）",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim().toLowerCase();
			if (raw === "" || raw === "status") {
				ctx.ui.notify(`活动面板: ${enabled ? `${rows} 行` : "off"}。用法 /activity [1|3|5|7|off]`, "info");
				return;
			}
			if (raw === "off") {
				enabled = false;
				reset();
			} else if ((ALLOWED_ROWS as readonly unknown[]).includes(Number(raw)) && Number.isInteger(Number(raw))) {
				enabled = true;
				rows = Number(raw);
				requestRender();
			} else {
				ctx.ui.notify(`未知参数 "${raw}"。用法 /activity [1|3|5|7|off]`, "warning");
				return;
			}
			await saveConfig();
			ctx.ui.notify(`活动面板: ${enabled ? `${rows} 行` : "off"}`, "info");
		},
	});
}
