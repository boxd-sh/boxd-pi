/** The boxd machine behind a Pi session: the client subset the extension uses, recovery and command execution. */

import { AuthenticationError, FilesystemError, type Machines, NotFoundError, PermissionDeniedError } from "@boxd-sh/sdk";
import { piSessionEnv, shortId } from "./util.ts";

/** The part of the boxd SDK's `machines` namespace this extension calls. Tests pass a fake. */
export type MachineClient = Pick<
	Machines,
	"get" | "create" | "fork" | "start" | "wake" | "hibernate" | "delete" | "waitUntilReady" | "exec" | "streamExec"
> & {
	fs: Pick<Machines["fs"], "read" | "readStream" | "write" | "stat" | "list" | "mkdir">;
	proxies: Pick<Machines["proxies"], "create" | "list">;
};

/** A machine bound to the current Pi session. Addressed by id everywhere. */
export interface ActiveMachine {
	client: MachineClient;
	id: string;
	name: string;
	/** Working directory inside the machine (the cloned repo, or ~/workspace). */
	cwd: string;
	/** The URL the extension cloned into `cwd`, if it cloned one. The only place `/boxd push` sends a token. */
	repoUrl?: string;
}

/** Thrown when the session's machine no longer exists. Tool calls fail; nothing runs on the host. */
export class MachineGoneError extends Error {
	readonly machineId: string;
	constructor(machineId: string) {
		super(
			`boxd machine ${shortId(machineId)} no longer exists. The tool was NOT run on your computer. ` +
				"Start Pi again with --boxd to get a new machine.",
		);
		this.name = "MachineGoneError";
		this.machineId = machineId;
	}
}

/** Statuses after which the machine needs `start` or `wake` before a call can succeed. */
const NEEDS_START = new Set(["stopped", "failed"]);
const NEEDS_WAKE = new Set(["hibernated", "suspended"]);

/** How long {@link ensureRunning} keeps trying, and its first pause between tries. */
export const ENSURE_RUNNING = { timeoutMs: 120_000, firstRetryMs: 1000 };

/**
 * Bring a machine to `running`: start a stopped one, wake a hibernated or paused one, then wait for exec.
 * A machine that is still going to sleep (Pi quit a moment ago) can refuse a wake at first, so a failed
 * start or wake is tried again with a growing pause until the timeout. A missing machine and a refused
 * key are not retried.
 */
export async function ensureRunning(client: MachineClient, id: string): Promise<void> {
	const until = Date.now() + ENSURE_RUNNING.timeoutMs;
	let pause = ENSURE_RUNNING.firstRetryMs;
	for (;;) {
		const machine = await client.get(id);
		if (machine.status === "running") return;
		try {
			if (NEEDS_START.has(machine.status)) await client.start(id);
			else if (NEEDS_WAKE.has(machine.status)) await client.wake(id);
			await client.waitUntilReady(id, { timeout: Math.max(until - Date.now(), 1000) });
			return;
		} catch (err) {
			const final = err instanceof NotFoundError || err instanceof AuthenticationError || err instanceof PermissionDeniedError;
			if (final || Date.now() + pause > until) throw err;
			await new Promise((resolve) => setTimeout(resolve, pause));
			pause = Math.min(pause * 2, 8000);
		}
	}
}

/**
 * Decide what a failed machine call means by looking at the machine, not the error text: a missing
 * machine becomes MachineGoneError, a stopped or sleeping one is brought back (the caller retries),
 * and a running one means the call itself failed, so `err` is rethrown.
 */
export async function recover(machine: ActiveMachine, err: unknown): Promise<void> {
	// A file error (ENOENT, EISDIR, ...) is an answer from a running machine, not an availability problem.
	if (err instanceof FilesystemError) throw err;
	let status: string;
	try {
		status = (await machine.client.get(machine.id)).status;
	} catch (getErr) {
		if (getErr instanceof NotFoundError) throw new MachineGoneError(machine.id);
		throw err;
	}
	if (status === "running") throw err;
	await ensureRunning(machine.client, machine.id);
}

/** Run a machine call; if the machine was stopped or asleep, bring it back and retry once. */
export async function withRecovery<T>(machine: ActiveMachine, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		await recover(machine, err);
		return await fn();
	}
}

/** Run a short helper command and collect its output (stdout and stderr kept apart). */
export async function runCommand(
	machine: ActiveMachine,
	command: string,
	opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const res = await withRecovery(machine, () =>
		machine.client.exec(machine.id, {
			command: ["bash", "-c", command],
			cwd: opts.cwd,
			env: opts.env,
			timeout: opts.timeoutMs,
		}),
	);
	return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
}

/**
 * Wrap a command so a process it puts in the background neither holds the call open nor dies with it.
 *
 * Problem: `python3 -m http.server &` keeps the exec's stdout open, and once the call ends its next
 * write hits a closed pipe and kills it. Solution: the command's combined output goes to a temp file
 * that `tail` streams back until the foreground subshell exits; background children keep writing to
 * the file. The subshell's exit code is the call's exit code.
 */
export function backgroundSafe(command: string): string {
	return [
		"__pi_out=$(mktemp)",
		`( ${command}`,
		') >"$__pi_out" 2>&1 </dev/null &',
		"__pi_pid=$!",
		'tail -c +1 -s 0.1 -f --pid=$__pi_pid "$__pi_out" 2>/dev/null',
		"wait $__pi_pid",
		"__pi_rc=$?",
		'rm -f "$__pi_out"',
		"exit $__pi_rc",
	].join("\n");
}

/** Options for {@link streamCommand}; the shape of Pi's BashOperations.exec options. */
export interface StreamOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	/** Seconds. */
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

/**
 * Run a command in the machine, streaming its output as it arrives. Abort and timeout close the call,
 * which ends the remote process group. Only Pi's PI_* session variables go with the command. A call
 * that fails before any output (a stopped machine) is retried once after recovery.
 */
export async function streamCommand(
	machine: ActiveMachine,
	command: string,
	cwd: string,
	opts: StreamOptions,
): Promise<{ exitCode: number | null }> {
	if (opts.signal?.aborted) throw new Error("aborted");
	const first = await streamOnce(machine, command, cwd, opts);
	if (first.ok) return { exitCode: first.exitCode };
	if (first.gotOutput || opts.signal?.aborted || first.timedOut) throw first.error;
	await recover(machine, first.error);
	const second = await streamOnce(machine, command, cwd, opts);
	if (second.ok) return { exitCode: second.exitCode };
	throw second.error;
}

type StreamAttempt = { ok: true; exitCode: number } | { ok: false; error: unknown; gotOutput: boolean; timedOut: boolean };

async function streamOnce(
	machine: ActiveMachine,
	command: string,
	cwd: string,
	{ onData, signal, timeout, env }: StreamOptions,
): Promise<StreamAttempt> {
	const stream = machine.client.streamExec(machine.id, {
		command: ["bash", "-c", backgroundSafe(command)],
		cwd,
		env: piSessionEnv(env),
		closeStdin: true,
	});
	let gotOutput = false;
	let timedOut = false;
	const onAbort = () => stream.close();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer =
		timeout !== undefined && timeout > 0
			? setTimeout(() => {
					timedOut = true;
					stream.close();
				}, timeout * 1000)
			: undefined;
	const pump = async (source: AsyncIterable<Uint8Array>) => {
		for await (const chunk of source) {
			gotOutput = true;
			onData(Buffer.from(chunk));
		}
	};
	const pumps = Promise.allSettled([pump(stream.stdout), pump(stream.stderr)]);
	try {
		const exitCode = await stream.wait();
		await pumps;
		return { ok: true, exitCode };
	} catch (err) {
		await pumps;
		let error = err;
		if (signal?.aborted) error = new Error("aborted");
		else if (timedOut) error = new Error(`timeout:${timeout}`);
		return { ok: false, error, gotOutput, timedOut };
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
