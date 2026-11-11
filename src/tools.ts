/**
 * Tool registration.
 *
 * Each of Pi's built-in tools is replaced with a variant that checks for a machine at call time:
 * - a machine is active          -> the tool runs inside it
 * - `--boxd` is set, no machine  -> the call fails (it never runs on your computer)
 * - `--boxd` is off              -> the extension is dormant and Pi's local tool runs
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { ActiveMachine } from "./machine.ts";
import { createBashOps, createEditOps, createLsOps, createReadOps, createWriteOps } from "./ops.ts";
import { previewUrl } from "./preview.ts";
import { type FindParams, type GrepParams, runRemoteFind, runRemoteGrep } from "./search.ts";

const UNAVAILABLE = "The boxd machine is not available, so the tool was NOT run on your computer. Restart Pi with --boxd.";

/** Register every tool. `getActive` returns the session's machine, or null when running locally. */
export function registerTools(pi: ExtensionAPI, getActive: () => ActiveMachine | null): void {
	const localCwd = process.cwd();
	const localBash = createBashToolDefinition(localCwd);
	const localRead = createReadToolDefinition(localCwd);
	const localWrite = createWriteToolDefinition(localCwd);
	const localEdit = createEditToolDefinition(localCwd);
	const localLs = createLsToolDefinition(localCwd);
	const localFind = createFindToolDefinition(localCwd);
	const localGrep = createGrepToolDefinition(localCwd);

	function requireMachine(): ActiveMachine | null {
		const active = getActive();
		if (active) return active;
		if (pi.getFlag("boxd") === true) throw new Error(UNAVAILABLE);
		return null;
	}

	function machineTool<TParams extends TSchema, TDetails, TState>(
		local: ToolDefinition<TParams, TDetails, TState>,
		makeRemote: (machine: ActiveMachine) => ToolDefinition<TParams, TDetails, TState>,
	): ToolDefinition<TParams, TDetails, TState> {
		return {
			...local,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const machine = requireMachine();
				if (!machine) return local.execute(toolCallId, params, signal, onUpdate, ctx);
				// Pi resolves tool paths against `ctx.cwd || cwd`, and ctx.cwd is the host directory.
				// Hand the tool a context whose cwd is the machine's; Object.create keeps ctx's getters live.
				const machineCtx: typeof ctx = Object.create(ctx, { cwd: { value: machine.cwd } });
				return makeRemote(machine).execute(toolCallId, params, signal, onUpdate, machineCtx);
			},
		};
	}

	pi.registerTool(machineTool(localBash, (m) => createBashToolDefinition(m.cwd, { operations: createBashOps(m) })));
	pi.registerTool(machineTool(localRead, (m) => createReadToolDefinition(m.cwd, { operations: createReadOps(m) })));
	pi.registerTool(machineTool(localWrite, (m) => createWriteToolDefinition(m.cwd, { operations: createWriteOps(m) })));
	pi.registerTool(machineTool(localEdit, (m) => createEditToolDefinition(m.cwd, { operations: createEditOps(m) })));
	pi.registerTool(machineTool(localLs, (m) => createLsToolDefinition(m.cwd, { operations: createLsOps(m) })));

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const machine = requireMachine();
			if (!machine) return localFind.execute(id, params, signal, onUpdate, ctx);
			if (signal?.aborted) throw new Error("aborted");
			return runRemoteFind(machine, params as FindParams);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(id, params, signal, onUpdate, ctx) {
			const machine = requireMachine();
			if (!machine) return localGrep.execute(id, params, signal, onUpdate, ctx);
			if (signal?.aborted) throw new Error("aborted");
			return runRemoteGrep(machine, params as GrepParams);
		},
	});

	pi.registerTool({
		name: "preview_url",
		label: "Preview URL",
		description:
			"Get a public HTTPS URL for a port served inside the boxd machine. Use it after starting a server " +
			"(for example a dev server on port 3000) to give the user a link.",
		promptSnippet: "Get a public HTTPS URL for a port served in the boxd machine",
		parameters: Type.Object({
			port: Type.Integer({ minimum: 1, maximum: 65535, description: "The port the server listens on inside the machine" }),
		}),
		async execute(_id, { port }) {
			const machine = requireMachine();
			if (!machine) return { content: [{ type: "text", text: "No boxd machine is active." }], details: undefined };
			const url = await previewUrl(machine, port);
			const text =
				`Preview URL for port ${port}: ${url}\n` +
				"Anyone with the link can open it. The server must listen on 0.0.0.0 or localhost inside the machine. " +
				"The first link on a machine can take up to a minute before HTTPS answers.";
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	// User `!` commands. Pi runs them in the host cwd, so pin them to the machine's working directory.
	pi.on("user_bash", () => {
		const active = getActive();
		if (active) return { operations: createBashOps(active, active.cwd) };
		if (pi.getFlag("boxd") === true) {
			return { result: { output: UNAVAILABLE, exitCode: 1, cancelled: false, truncated: false } };
		}
		return;
	});
}
