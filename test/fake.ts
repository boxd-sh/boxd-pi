// A fake boxd machines client and a fake Pi extension API for unit tests. No network.

import { ConflictError, MachineFileNotFoundError, NotFoundError } from "@boxd-sh/sdk";
import type { MachineClient } from "../src/machine.ts";

export interface FakeMachine {
	id: string;
	name: string;
	status: string;
	labels: Record<string, string>;
	isolated: boolean;
	files: Map<string, Buffer>;
	dirs: Set<string>;
	proxies: { name: string; port: number }[];
}

export interface StreamScript {
	chunks?: string[];
	stderr?: string[];
	exitCode?: number;
	/** Throw from wait() instead of exiting (before any chunk is sent). */
	fail?: Error;
	/** Never exit until closed. */
	hang?: boolean;
}

/** Records every call so tests can assert what the extension asked boxd to do. */
export class FakeBoxd {
	machines = new Map<string, FakeMachine>();
	calls: { method: string; args: unknown[] }[] = [];
	execResults: { stdout: string; stderr: string; exitCode: number }[] = [];
	streamScripts: StreamScript[] = [];
	closed = 0;
	/** How many wake() calls fail before one succeeds. */
	wakeFailures = 0;
	/** When set, waitUntilReady() throws it: a machine that never becomes ready. */
	readyError: Error | undefined;
	/** When set, create() waits for it before returning: a start that is still running. */
	createGate: Promise<void> | undefined;
	private seq = 0;
	/** Region this fake serves; `elsewhere` is what a not-found reports about other regions. */
	region: string;
	elsewhere: { region: string; name: string; orgId: string | null; id: string }[] = [];

	constructor(region = "nyc") {
		this.region = region;
	}

	add(partial: Partial<FakeMachine> & { id: string }): FakeMachine {
		const m: FakeMachine = {
			name: partial.id,
			status: "running",
			labels: {},
			isolated: true,
			files: new Map(),
			dirs: new Set(["/home/boxd"]),
			proxies: [],
			...partial,
		};
		this.machines.set(m.id, m);
		return m;
	}

	private find(idOrName: string): FakeMachine {
		const m = this.machines.get(idOrName) ?? [...this.machines.values()].find((x) => x.name === idOrName);
		if (!m) {
			const err = new NotFoundError(`machine ${idOrName} not found`);
			// Like boxd: other regions are reported for a name, not for an id.
			err.elsewhere = this.elsewhere.filter((e) => e.name === idOrName);
			throw err;
		}
		return m;
	}

	private log(method: string, ...args: unknown[]) {
		this.calls.push({ method, args });
	}

	called(method: string) {
		return this.calls.filter((c) => c.method === method);
	}

	client(): MachineClient {
		const self = this;
		const view = (m: FakeMachine) =>
			({
				id: m.id,
				name: m.name,
				status: m.status,
				region: self.region,
				labels: m.labels,
				resources: { vcpu: 2 },
				access: { url: `https://${m.name}.nyc.boxd.sh`, domain: "nyc.boxd.sh" },
			}) as never;
		const client = {
			async get(id: string) {
				self.log("get", id);
				return view(self.find(id));
			},
			async create(params: { name: string; labels: Record<string, string>; isolated?: boolean }) {
				self.log("create", params);
				if ([...self.machines.values()].some((m) => m.name === params.name)) throw new ConflictError("name taken");
				if (self.createGate) await self.createGate;
				const m = self.add({
					id: `${self.region}-${++self.seq}`,
					name: params.name,
					labels: params.labels,
					isolated: params.isolated === true,
					status: "pending",
				});
				return view(m);
			},
			async fork(id: string, params: { name: string; labels: Record<string, string>; isolated?: boolean }) {
				self.log("fork", id, params);
				const src = self.find(id);
				const m = self.add({
					id: `${self.region}-${++self.seq}`,
					name: params.name,
					labels: { ...src.labels, ...params.labels },
					isolated: src.isolated || params.isolated === true,
					files: new Map(src.files),
				});
				return view(m);
			},
			async start(id: string) {
				self.log("start", id);
				self.find(id).status = "running";
			},
			async wake(id: string) {
				self.log("wake", id);
				const m = self.find(id);
				if (self.wakeFailures > 0) {
					self.wakeFailures--;
					throw new ConflictError("not ready to wake yet");
				}
				m.status = "running";
			},
			async hibernate(id: string) {
				self.log("hibernate", id);
				self.find(id).status = "hibernated";
			},
			async delete(id: string) {
				self.log("delete", id);
				self.find(id);
				self.machines.delete(id);
			},
			async waitUntilReady(id: string) {
				self.log("waitUntilReady", id);
				if (self.readyError) throw self.readyError;
				const m = self.find(id);
				if (m.status === "pending") m.status = "running";
				return view(m);
			},
			async exec(id: string, params: unknown) {
				self.log("exec", id, params);
				const m = self.find(id);
				if (m.status === "stopped") throw new ConflictError("machine is stopped");
				return { success: true, ...(self.execResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 }) };
			},
			streamExec(id: string, params: unknown) {
				self.log("streamExec", id, params);
				const m = self.machines.get(id);
				const script: StreamScript = !m
					? { fail: new NotFoundError("gone") }
					: m.status === "stopped"
						? { fail: new ConflictError("machine is stopped") }
						: (self.streamScripts.shift() ?? { exitCode: 0 });
				return fakeStream(script, () => self.closed++);
			},
			fs: {
				async read(id: string, path: string, opts?: { length?: number }) {
					self.log("fs.read", id, path);
					const data = self.find(id).files.get(path);
					if (!data) throw new MachineFileNotFoundError(`${path}: No such file or directory`, 5, path);
					return new Uint8Array(opts?.length ? data.subarray(0, opts.length) : data);
				},
				async *readStream(id: string, path: string) {
					const data = self.find(id).files.get(path);
					if (!data) throw new MachineFileNotFoundError(`${path}: No such file or directory`, 5, path);
					yield new Uint8Array(data);
				},
				async write(id: string, path: string, data: string) {
					self.log("fs.write", id, path);
					self.find(id).files.set(path, Buffer.from(data));
					return {} as never;
				},
				async stat(id: string, path: string) {
					self.log("fs.stat", id, path);
					const m = self.find(id);
					if (m.dirs.has(path)) return { isDir: true } as never;
					if (m.files.has(path)) return { isDir: false } as never;
					throw new MachineFileNotFoundError(`${path}: No such file or directory`, 5, path);
				},
				async list(id: string, path: string) {
					const m = self.find(id);
					const prefix = path.endsWith("/") ? path : `${path}/`;
					return [...m.files.keys()].filter((f) => f.startsWith(prefix)).map((f) => ({ name: f.slice(prefix.length) })) as never;
				},
				async mkdir(id: string, path: string) {
					self.find(id).dirs.add(path);
				},
			},
			proxies: {
				async create(id: string, name: string, port: number) {
					self.log("proxies.create", id, name, port);
					self.find(id).proxies.push({ name, port });
					return { name, port };
				},
				async list(id: string) {
					const m = self.find(id);
					return m.proxies.map((p) => ({ ...p, machineId: m.id, machineName: m.name, domain: `${p.name}.${m.name}.nyc.boxd.sh` })) as never;
				},
			},
		};
		return client as unknown as MachineClient;
	}
}

function fakeStream(script: StreamScript, onClose: () => void) {
	let closeFn: (() => void) | undefined;
	const closedPromise = new Promise<void>((resolve) => {
		closeFn = resolve;
	});
	let closed = false;
	async function* gen(parts: string[] | undefined) {
		for (const p of parts ?? []) yield new TextEncoder().encode(p);
	}
	return {
		stdout: script.fail || script.hang ? gen([]) : gen(script.chunks),
		stderr: script.fail || script.hang ? gen([]) : gen(script.stderr),
		close() {
			if (closed) return;
			closed = true;
			onClose();
			closeFn?.();
		},
		async wait() {
			if (script.fail) throw script.fail;
			if (script.hang) {
				await closedPromise;
				throw new Error("Cancelled on client");
			}
			return script.exitCode ?? 0;
		},
	};
}

/** A stand-in for Pi's ExtensionAPI that records registrations and lets tests fire events. */
export class FakePi {
	flags = new Map<string, boolean | string>();
	registeredFlags: string[] = [];
	tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	entries: { type: string; customType: string; data: unknown }[] = [];
	execResults = new Map<string, { code: number; stdout: string; stderr: string }>();

	registerFlag(name: string) {
		this.registeredFlags.push(name);
	}
	getFlag(name: string) {
		return this.flags.get(name);
	}
	registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
		this.tools.set(tool.name, tool);
	}
	registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
		this.commands.set(name, options);
	}
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}
	appendEntry(customType: string, data: unknown) {
		this.entries.push({ type: "custom", customType, data });
	}
	async exec(cmd: string, args: string[]) {
		return this.execResults.get([cmd, ...args].join(" ")) ?? { code: 1, stdout: "", stderr: "not found" };
	}
	async fire(event: string, payload: unknown, ctx: unknown) {
		const out = [];
		for (const h of this.handlers.get(event) ?? []) out.push(await h(payload, ctx));
		return out;
	}
}

/** A Pi context with a session manager whose entries come from `pi.entries`. */
export function fakeCtx(pi: FakePi, opts: { sessionId?: string; persisted?: boolean; hasUI?: boolean } = {}) {
	const notes: { message: string; type?: string }[] = [];
	const status = new Map<string, string | undefined>();
	return {
		notes,
		status,
		hasUI: opts.hasUI ?? false,
		cwd: "/host/project",
		ui: {
			notify: (message: string, type?: string) => notes.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => status.set(key, text),
			theme: { fg: (_c: string, t: string) => t },
			input: async () => undefined,
			confirm: async () => true,
		},
		sessionManager: {
			getSessionId: () => opts.sessionId ?? "11111111-2222-3333-4444-555555555555",
			getSessionFile: () => (opts.persisted === false ? undefined : "/host/.pi/session.jsonl"),
			getEntries: () => pi.entries,
			getCwd: () => "/host/project",
		},
	};
}
