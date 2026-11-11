import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import activityPanelExtension from "../src/experimental/durable-tui/activity-panel.ts";

type Handler<E> = (event: E, ctx: ExtensionContext) => unknown;
type AnyHandler = Handler<never>;
type WidgetFactory = (tui: unknown, theme: unknown) => { render: (width: number) => string[] };

/** Fire a captured handler with an event literal (typed loosely on purpose:
 * the panel only reads a few fields off each event). */
function fire(handler: AnyHandler | undefined, event: unknown, ctx: ExtensionContext): unknown {
	return (handler as (event: unknown, ctx: ExtensionContext) => unknown)(event, ctx);
}

const THEME = {
	bg: (_key: string, s: string) => s,
	fg: (_key: string, s: string) => s,
	italic: (s: string) => s,
	bold: (s: string) => s,
};

/** Spin up the panel with a fake api whose getSettings() returns `settings`,
 * capture the widget factory and the hidden-thinking-label calls. */
function harness(settings: Record<string, unknown>) {
	const handlers = new Map<string, AnyHandler>();
	const getSettings = vi.fn(() => settings);
	const api = {
		on: (event: string, handler: Handler<never>) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerToolRenderer: vi.fn(),
		registerCommand: vi.fn(),
		getSettings,
	} as unknown as ExtensionAPI;
	activityPanelExtension(api);

	const hiddenLabels: (string | undefined)[] = [];
	let widget: WidgetFactory | undefined;
	const ctx = {
		mode: "tui",
		cwd: "/tmp/pi-durable-tui-activity-test/project",
		ui: {
			setWidget: (_key: string, factory: WidgetFactory) => {
				widget = factory;
			},
			setHiddenThinkingLabel: (label?: string) => {
				hiddenLabels.push(label);
			},
		},
	} as unknown as ExtensionContext;

	handlers.get("session_start")!({ type: "session_start" } as never, ctx);

	const render = (width: number): string[] => widget!(undefined, THEME).render(width);
	const update = (type: string, thinking: string) => {
		fire(
			handlers.get("message_update"),
			{
				assistantMessageEvent: { type },
				message: { content: [{ type: "thinking", thinking }] },
			},
			ctx,
		);
	};
	return { ctx, handlers, getSettings, hiddenLabels, render, update };
}

describe("durable-tui activity panel thinking yield", () => {
	beforeEach(() => {
		// keep the panel config (rows/enabled) away from the developer machine
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-activity-test-"));
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	test("hideThinkingBlock false: panel yields the viewport while thinking, keeps it for tools", () => {
		const { handlers, hiddenLabels, render, ctx } = harness({});

		// settings unset → effective hideThinkingBlock:false → transcript owns thinking
		expect(hiddenLabels).toContain("");
		expect(render(40)).toEqual([]); // idle

		const thinkStart = handlers.get("message_update");
		fire(
			thinkStart,
			{
				assistantMessageEvent: { type: "thinking_start" },
				message: { content: [{ type: "thinking", thinking: "deep thought" }] },
			},
			ctx,
		);

		// yield: zero rows during thinking (no 🧠 band next to the native block)
		expect(render(40)).toEqual([]);

		fire(
			handlers.get("tool_execution_start"),
			{ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } },
			ctx,
		);

		// tool phases keep the panel regardless of the setting
		const toolBand = render(40);
		expect(toolBand.length).toBe(7);
		expect(toolBand[0]).toContain("🔧 bash · ls");
	});

	test("hideThinkingBlock true: panel owns thinking with the 🧠 band at fixed height", () => {
		const { render, update } = harness({ hideThinkingBlock: true });

		update("thinking_start", "deep thought");

		const band = render(40);
		expect(band.length).toBe(7); // fixed geometry while visible
		expect(band[0]).toContain("🧠");
		expect(band[0]).toContain("deep thought");
		for (const rowText of band) expect(rowText.length).toBeGreaterThan(0);
	});

	test("the setting is re-read on phase entry, not per streamed chunk", () => {
		const { getSettings, render, update } = harness({ hideThinkingBlock: false });

		update("thinking_start", "chunk 1"); // phase entry → refresh
		const afterEntry = getSettings.mock.calls.length;
		expect(afterEntry).toBeGreaterThanOrEqual(1);

		update("thinking_delta", "chunk 2"); // same phase → no re-read
		update("thinking_delta", "chunk 3");
		expect(getSettings.mock.calls.length).toBe(afterEntry);
		expect(render(40)).toEqual([]); // still yielded
	});
});
