import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
} from "../src/core/extensions/types.ts";
import sessionGuardExtension, {
	FORK_UNSUPPORTED_NOTICE,
	NON_DURABLE_SWITCH_NOTICE,
} from "../src/experimental/durable-tui/session-guard.ts";
import { tuiSessionsRoot } from "../src/experimental/durable-tui/session-location.ts";

type Handler<E> = (event: E, ctx: ExtensionContext) => { cancel?: boolean } | undefined;

/** Capture the handlers the guard registers, without a real extension runner. */
function register() {
	const handlers = new Map<string, Handler<never>>();
	const api = {
		on: (event: string, handler: Handler<never>) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	} as unknown as ExtensionAPI;
	sessionGuardExtension(api);
	return handlers;
}

function context(cwd: string) {
	const notify = vi.fn();
	const ctx = { hasUI: true, cwd, ui: { notify } } as unknown as ExtensionContext;
	return { ctx, notify };
}

const CWD = "/tmp/pi-durable-tui-guard-test/project";
const CARRIER = join(tuiSessionsRoot(CWD), "1794385047177-09d86d9f-d724-4a65-9307-b397f4446936", "carrier.jsonl");

describe("durable-tui session guard", () => {
	test("refuses a fork before the runtime tears the live session down", () => {
		const handlers = register();
		const { ctx, notify } = context(CWD);
		const handler = handlers.get("session_before_fork") as Handler<SessionBeforeForkEvent>;

		expect(handler({ type: "session_before_fork", entryId: "e1", position: "before" }, ctx)).toEqual({
			cancel: true,
		});
		expect(notify).toHaveBeenCalledWith(FORK_UNSUPPORTED_NOTICE, "warning");
	});

	test("allows a switch through a durable carrier path", () => {
		const handlers = register();
		const { ctx, notify } = context(CWD);
		const handler = handlers.get("session_before_switch") as Handler<SessionBeforeSwitchEvent>;

		expect(
			handler({ type: "session_before_switch", reason: "resume", targetSessionFile: CARRIER }, ctx),
		).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	test("refuses a resume of a non-durable session file (upstream 1.5.2 Continue/Fork target)", () => {
		const handlers = register();
		const { ctx, notify } = context(CWD);
		const handler = handlers.get("session_before_switch") as Handler<SessionBeforeSwitchEvent>;

		expect(
			handler({ type: "session_before_switch", reason: "resume", targetSessionFile: "/tmp/old/orphan.jsonl" }, ctx),
		).toEqual({ cancel: true });
		expect(notify).toHaveBeenCalledWith(NON_DURABLE_SWITCH_NOTICE, "warning");
	});

	test("gets out of the way of new-session switches", () => {
		const handlers = register();
		const { ctx, notify } = context(CWD);
		const handler = handlers.get("session_before_switch") as Handler<SessionBeforeSwitchEvent>;

		expect(handler({ type: "session_before_switch", reason: "new" }, ctx)).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	test("does not mistake a carrier path from another project for a durable target", () => {
		const handlers = register();
		const { ctx, notify } = context(CWD);
		const handler = handlers.get("session_before_switch") as Handler<SessionBeforeSwitchEvent>;
		const otherCarrier = join(
			tuiSessionsRoot("/tmp/pi-durable-tui-guard-test/elsewhere"),
			"1794385047177-09d86d9f-d724-4a65-9307-b397f4446936",
			"carrier.jsonl",
		);

		expect(
			handler({ type: "session_before_switch", reason: "resume", targetSessionFile: otherCarrier }, ctx),
		).toEqual({ cancel: true });
		expect(notify).toHaveBeenCalledWith(NON_DURABLE_SWITCH_NOTICE, "warning");
	});
});
