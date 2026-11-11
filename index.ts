/**
 * @boxd-sh/pi: run Pi's tools inside a boxd machine.
 *
 * The agent runs on your computer. With `--boxd`, bash, read, write, edit, ls, find and grep run in a
 * boxd machine instead: one machine per Pi session, kept with the session and reattached when you
 * resume it, hibernated when you quit, and copied (disk, memory and running processes) when you fork
 * the session. In-memory sessions (`--no-session`) delete their machine on exit.
 *
 * Blueprint: examples/extensions/ssh.ts from @earendil-works/pi-coding-agent.
 */

import { ConflictError, NotFoundError } from "@boxd-sh/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClient, type MachineSettings, machineSettings, registerFlags, resolveCredentials, stringFlag } from "./src/config.ts";
import { cloneRepo, configureIdentity, detectLocalRepo, githubToken, initWorkspace, pushBranch } from "./src/git.ts";
import { type ActiveMachine, ensureRunning, type MachineClient } from "./src/machine.ts";
import { previewUrl } from "./src/preview.ts";
import { registerTools } from "./src/tools.ts";
import { errorMessage, joinPath, machineName, normalizeRepoUrl, repoName, shortId } from "./src/util.ts";

/** Session entry type that records the machine bound to a session. */
export const SESSION_ENTRY = "boxd-machine";

/** Labels on every machine this extension creates. */
export const CREATED_BY = "boxd-pi";

/** What a session records so it can find its machine again. */
export interface SessionEntryData {
	machineId: string;
	machineName: string;
	cwd: string;
	/** Region the machine lives in; reattach and fork go there whatever BOXD_REGION says now. */
	region?: string;
}

const HOME = "/home/boxd";

/** Build the extension. Tests pass their own client factory; Pi loads the default export. */
export function boxdExtension(makeClient: typeof createClient = createClient): (pi: ExtensionAPI) => void {
	return (pi) => setup(pi, makeClient);
}

export default boxdExtension();

function setup(pi: ExtensionAPI, makeClient: typeof createClient): void {
	registerFlags(pi);

	let active: ActiveMachine | null = null;

	registerTools(pi, () => active);

	pi.registerCommand("boxd", {
		description: "boxd machine: status | url <port> | hibernate | push [branch] | delete [--yes]",
		handler: async (args, ctx) => {
			if (!active) {
				notify(ctx, "No boxd machine is active. Start Pi with --boxd.", "warning");
				return;
			}
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const machine = active;
			try {
				if (sub === "status") {
					const m = await machine.client.get(machine.id);
					notify(
						ctx,
						[
							`boxd ${m.name} (${shortId(m.id)}) · ${m.status} · ${m.resources.vcpu} vCPU`,
							`cwd: ${machine.cwd}`,
							`url: ${m.access.url}`,
						].join("\n"),
						"info",
					);
				} else if (sub === "url") {
					const port = Number(rest[0]);
					if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Usage: /boxd url <port>");
					notify(ctx, `Port ${port}: ${await previewUrl(machine, port)}`, "info");
				} else if (sub === "hibernate") {
					await machine.client.hibernate(machine.id);
					setStatus(ctx, `☁ boxd · ${machine.name} · hibernated (wakes on the next tool call)`);
					notify(ctx, "Machine hibernated. The next tool call wakes it.", "info");
				} else if (sub === "push") {
					const branch = rest[0] ?? `pi/${shortId(ctx.sessionManager.getSessionId())}`;
					const out = await pushBranch(machine, branch, await githubToken(pi));
					notify(ctx, `Pushed HEAD to ${branch}\n${out}`, "info");
				} else if (sub === "delete") {
					const yes = rest.includes("--yes") || rest.includes("-y");
					if (!yes && !ctx.hasUI) {
						notify(ctx, "boxd: /boxd delete needs --yes when Pi has no UI.", "warning");
						return;
					}
					const ok = yes || (await ctx.ui.confirm("Delete machine", `Delete ${machine.name}? Its disk and processes are gone for good.`));
					if (!ok) return;
					await machine.client.delete(machine.id);
					active = null;
					setStatus(ctx, undefined);
					notify(ctx, `Deleted ${machine.name}. Tools stay off until you restart Pi with --boxd.`, "info");
				} else {
					notify(ctx, "Usage: /boxd [status | url <port> | hibernate | push [branch] | delete [--yes]]", "warning");
				}
			} catch (err) {
				notify(ctx, `boxd: ${errorMessage(err)}`, "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (pi.getFlag("boxd") !== true || active) return;

		let settings: MachineSettings;
		let creds: { apiKey?: string; token?: string } | undefined;
		try {
			settings = machineSettings(pi);
			creds = await resolveCredentials(ctx);
		} catch (err) {
			notify(ctx, `boxd: ${errorMessage(err)}`, "error");
			return;
		}
		if (!creds) {
			notify(ctx, "boxd: no API key. Set BOXD_API_KEY. Tools will not run until you do.", "error");
			return;
		}
		const clientFor = (region: string | undefined) => makeClient(creds, region);

		const sessionId = ctx.sessionManager.getSessionId();
		const name = machineName(settings.namePrefix, sessionId);
		const labels = { "created-by": CREATED_BY, "pi-session": sessionId };
		const previous = latestEntry(ctx);
		const startedAt = Date.now();
		const record = (m: ActiveMachine, region: string | undefined) =>
			pi.appendEntry<SessionEntryData>(SESSION_ENTRY, { machineId: m.id, machineName: m.name, cwd: m.cwd, region });
		let created: { client: MachineClient; id: string } | undefined;

		try {
			const found = previous ? await locate(clientFor, previous, settings.region) : undefined;
			// `/fork` says so in the event; `pi --fork <file>` starts the copy as a normal startup. Either
			// way the recorded machine belongs to another session, and this session gets its own copy.
			const isFork = event.reason === "fork" || (found?.session !== undefined && found.session !== sessionId);
			if (previous && found && isFork) {
				setStatus(ctx, "☁ boxd · forking machine…");
				const forked = await forkMachine(found.client, previous, name, labels);
				active = forked.machine;
				record(forked.machine, found.region);
				// The parent session is no longer open here, so its machine can sleep.
				void found.client.hibernate(previous.machineId).catch(() => undefined);
				done(ctx, forked.machine, "Forked machine", startedAt);
				return;
			}
			if (previous && found) {
				setStatus(ctx, "☁ boxd · waking machine…");
				await ensureRunning(found.client, previous.machineId);
				active = { client: found.client, id: previous.machineId, name: previous.machineName, cwd: previous.cwd };
				if (found.region !== previous.region) record(active, found.region);
				done(ctx, active, "Reattached machine", startedAt);
				return;
			}

			setStatus(ctx, "☁ boxd · creating machine…");
			const client = clientFor(settings.region);
			const made = await createMachine(client, settings, name, labels, sessionId);
			created = { client, id: made.id };
			const machine: ActiveMachine = { client, id: made.id, name, cwd: joinPath(HOME, "workspace") };
			await configureIdentity(machine);
			machine.cwd = await prepareWorkspace(pi, ctx, machine);
			active = machine;
			record(machine, made.region);
			done(ctx, machine, "Machine ready", startedAt);
		} catch (err) {
			active = null;
			// A machine this call created but could not set up has no session entry pointing at it: remove it.
			if (created) await created.client.delete(created.id).catch(() => undefined);
			setStatus(ctx, undefined);
			notify(ctx, `boxd: could not start a machine: ${errorMessage(err)}`, "error");
		}
	});

	// Point the model at the machine's working directory and say where its commands run.
	pi.on("before_agent_start", (event) => {
		if (!active) return;
		const options = event.systemPromptOptions;
		options.cwd = active.cwd;
		options.sections = {
			...options.sections,
			boxd:
				`Your tools run inside the boxd machine ${active.name}: Ubuntu 24.04, user boxd with passwordless sudo, ` +
				"Docker, Node.js, Python and Go installed. The working directory is a git repository; commit your work " +
				"with git when you finish a unit of it. Processes you start in the background keep running between " +
				"commands. Use preview_url to give the user a link to a server you start.",
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!active) return;
		const machine = active;
		active = null;
		setStatus(ctx, undefined);
		// A reload reattaches right away, and a fork copies this machine first: keep it running.
		if (event.reason === "reload" || event.reason === "fork") return;
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		try {
			if (persisted) await machine.client.hibernate(machine.id);
			else await machine.client.delete(machine.id);
		} catch {
			// Best effort: an idle machine also hibernates by itself.
		}
	});
}

/** The newest machine record in this session (for a fork, the parent's). */
export function latestEntry(ctx: Pick<ExtensionContext, "sessionManager">): SessionEntryData | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: string; customType?: string; data?: unknown };
		if (e.type === "custom" && e.customType === SESSION_ENTRY) return e.data as SessionEntryData;
	}
	return undefined;
}

/**
 * Find a recorded machine: in its recorded region, or in the region boxd reports for its name (same id).
 * Returns undefined only when it is gone, so a new machine never shadows one that still exists.
 */
async function locate(
	clientFor: (region: string | undefined) => MachineClient,
	entry: SessionEntryData,
	fallbackRegion: string | undefined,
): Promise<Located | undefined> {
	const region = entry.region ?? fallbackRegion;
	const client = clientFor(region);
	try {
		const m = await client.get(entry.machineId);
		return { client, region: m.region ?? region, session: m.labels["pi-session"] };
	} catch (err) {
		if (!(err instanceof NotFoundError)) throw err;
	}
	// Not in this region. boxd says where a machine is when asked by name; accept it only if the id matches.
	try {
		const m = await client.get(entry.machineName);
		return m.id === entry.machineId ? { client, region: m.region ?? region, session: m.labels["pi-session"] } : undefined;
	} catch (err) {
		if (!(err instanceof NotFoundError)) throw err;
		const other = err.elsewhere.find((e) => e.id === entry.machineId);
		if (!other) return undefined;
		const there = clientFor(other.region);
		const m = await there.get(entry.machineId);
		return { client: there, region: other.region, session: m.labels["pi-session"] };
	}
}

/** A recorded machine that still exists: its client, region, and the session it belongs to. */
interface Located {
	client: MachineClient;
	region: string | undefined;
	session: string | undefined;
}

/** Fork the parent session's machine: a live copy of its disk, memory and running processes. */
async function forkMachine(
	client: MachineClient,
	parent: SessionEntryData,
	name: string,
	labels: Record<string, string>,
): Promise<{ machine: ActiveMachine }> {
	await ensureRunning(client, parent.machineId);
	const fork = await client.fork(parent.machineId, { name, labels, isolated: true });
	await client.waitUntilReady(fork.id, { timeout: 120_000 });
	return { machine: { client, id: fork.id, name: fork.name, cwd: parent.cwd } };
}

/**
 * Create the session's machine: isolated, labelled with the session id. If a machine with this name
 * already exists for the same session (an earlier start that stopped half way), use it.
 */
async function createMachine(
	client: MachineClient,
	settings: MachineSettings,
	name: string,
	labels: Record<string, string>,
	sessionId: string,
): Promise<{ id: string; region: string | undefined }> {
	const config = settings.size ? { vcpu: settings.size.vcpu, memory: settings.size.memory } : undefined;
	try {
		const machine = settings.snapshot
			? await client.create({ name, org: settings.org, labels, config, fromSnapshot: settings.snapshot, isolated: true })
			: await client.create({ name, org: settings.org, labels, config, isolated: true });
		const ready = await client.waitUntilReady(machine.id, { timeout: 120_000 });
		return { id: machine.id, region: ready.region ?? machine.region ?? settings.region };
	} catch (err) {
		if (!(err instanceof ConflictError)) throw err;
		const existing = await client.get(name);
		if (existing.labels["pi-session"] !== sessionId) throw err;
		await ensureRunning(client, existing.id);
		return { id: existing.id, region: existing.region ?? settings.region };
	}
}

/** Clone the repo (flag, or the one Pi was started in) or make an empty workspace. Returns the cwd. */
async function prepareWorkspace(pi: ExtensionAPI, ctx: ExtensionContext, machine: ActiveMachine): Promise<string> {
	let repo = stringFlag(pi, "boxd-repo");
	let branch = stringFlag(pi, "boxd-branch");
	if (!repo && pi.getFlag("boxd-no-repo") !== true) {
		const local = await detectLocalRepo(pi, ctx.sessionManager.getCwd());
		if (local) {
			repo = local.url;
			branch = branch ?? local.branch;
		}
	}
	if (!repo) {
		const dir = joinPath(HOME, "workspace");
		await initWorkspace(machine, dir);
		return dir;
	}
	const url = normalizeRepoUrl(repo);
	const dir = joinPath(HOME, repoName(url));
	setStatus(ctx, `☁ boxd · cloning ${repoName(url)}…`);
	await cloneRepo(machine, url, dir, branch, await githubToken(pi));
	return dir;
}

function done(ctx: ExtensionContext, machine: ActiveMachine, what: string, startedAt: number): void {
	const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
	notify(ctx, `${what} · ${machine.name} · ${secs}s`, "info");
	setStatus(ctx, `☁ boxd · ${machine.name} · ${machine.cwd}`);
}

/** Show a message; without a UI (`pi -p`, JSON mode) also write it to stderr so failures are not silent. */
function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	ctx.ui.notify(message, type);
	if (!ctx.hasUI) process.stderr.write(`[boxd-pi] ${message}\n`);
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	ctx.ui.setStatus("boxd", text === undefined ? undefined : ctx.ui.theme.fg("accent", text));
}
