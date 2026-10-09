// durable-tui: the "/extensions" command — pick which global settings packages load
// at startup. First boot loads none of them (clean base + builtin MCP); /ext
// toggles entries in a picker, persists the choice, appends newly selected
// paths to the live resource loader, and reloads — so additions apply without
// a restart. Removals only take effect on the next boot: reload re-resolves
// the loader's path list, it has no remove channel.
//
// jiti gives this extension its own module instances, so the facade and the
// boot-time "already applied" path set are shared through globalThis (objects
// cannot travel through process.env the way the session id does).

import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { loadSelection, readGlobalPackages, resolveSelection, saveSelection } from "./extension-picker.ts";

const DONE_ROW = "完成：保存并重载（新勾选立即生效）";
const CANCEL_ROW = "取消：不保存退出";

interface DurableTuiSeam {
	session: { addExtensionPaths(paths: string[]): void };
	appliedExtensionPaths: Set<string>;
}

export default function extensionsManagerExtension(pi: ExtensionAPI): void {
	pi.registerCommand("extensions", {
		description: "配置启动加载哪些全局扩展（持久化；勾选后重载生效）",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (ctx.mode !== "tui") return;
			const packages = await readGlobalPackages();
			if (packages.length === 0) {
				ctx.ui.notify("全局 settings.json 里没有可管理的本地扩展包", "info");
				return;
			}
			const selected = new Set((await loadSelection()) ?? []);

			let done = false;
			while (!done) {
				const rows = packages.map((p) => ({
					name: p.name,
					label: `${selected.has(p.name) ? "[x]" : "[ ]"} ${p.name}`,
				}));
				const picked = await ctx.ui.select("启动加载的扩展（回车切换勾选，Esc 退出）", [
					...rows.map((r) => r.label),
					DONE_ROW,
					CANCEL_ROW,
				]);
				if (picked === undefined || picked === CANCEL_ROW) return;
				if (picked === DONE_ROW) {
					done = true;
					break;
				}
				const row = rows.find((r) => r.label === picked);
				if (row === undefined) return;
				if (selected.has(row.name)) selected.delete(row.name);
				else selected.add(row.name);
			}

			const names = packages.filter((p) => selected.has(p.name)).map((p) => p.name);
			await saveSelection(names);
			const seam = (globalThis as { __durableTui?: DurableTuiSeam }).__durableTui;
			const resolved = resolveSelection(names, packages);
			if (seam === undefined) {
				ctx.ui.notify(`已保存 ${names.length} 个扩展，重启 pi-durable-tui 后生效`, "info");
				return;
			}
			const removed = [...seam.appliedExtensionPaths].filter((p) => !resolved.some((r) => r.path === p)).length;
			const delta = resolved.map((r) => r.path).filter((p) => !seam.appliedExtensionPaths.has(p));
			if (delta.length > 0) seam.session.addExtensionPaths(delta);
			const suffix =
				delta.length > 0 ? "新勾选的重载中…" : removed > 0 ? `；取消勾选的 ${removed} 个重启后不再加载` : "";
			ctx.ui.notify(`已保存 ${names.length} 个扩展${suffix}`, "info");
			if (delta.length === 0) return;
			// ctx is stale after reload() resolves — touch nothing afterwards.
			try {
				await ctx.reload();
			} catch (error) {
				console.error("[durable-tui] reload after /extensions failed:", error);
			}
		},
	});
}
