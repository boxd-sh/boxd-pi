import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boxdExtension, IN_MEMORY_DELETE_AFTER, SESSION_ENTRY, type SessionEntryData } from "../index.ts";
import { FakeBoxd, FakePi, fakeCtx } from "./fake.ts";

function load(boxd: FakeBoxd, flags: Record<string, boolean | string> = { boxd: true }) {
	const pi = new FakePi();
	for (const [k, v] of Object.entries(flags)) pi.flags.set(k, v);
	boxdExtension(() => boxd.client())(pi as never);
	return pi;
}

function withKey<T>(fn: () => Promise<T>): Promise<T> {
	const prev = process.env.BOXD_API_KEY;
	process.env.BOXD_API_KEY = "test-key";
	return fn().finally(() => {
		if (prev === undefined) delete process.env.BOXD_API_KEY;
		else process.env.BOXD_API_KEY = prev;
	});
}

describe("extension registration", () => {
	it("registers the flags, every built-in tool, preview_url and /boxd", () => {
		const pi = load(new FakeBoxd(), {});
		assert.deepEqual([...pi.tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "preview_url", "read", "write"]);
		assert.ok(pi.registeredFlags.includes("boxd"));
		assert.ok(pi.commands.has("boxd"));
		for (const e of ["session_start", "session_shutdown", "before_agent_start", "user_bash"]) assert.ok(pi.handlers.has(e), e);
	});

	it("with --boxd and no machine, a tool call fails and never runs on the host", async () => {
		const pi = load(new FakeBoxd());
		await assert.rejects(
			pi.tools.get("bash")!.execute("id", { command: "touch /tmp/should-not-exist" }, undefined, undefined, fakeCtx(pi)),
			/NOT run on your computer/,
		);
		const [res] = (await pi.fire("user_bash", { command: "ls" }, fakeCtx(pi))) as { result: { exitCode: number } }[];
		assert.equal(res.result.exitCode, 1);
	});
});

describe("session lifecycle", () => {
	it("creates one isolated, labelled machine per session and records it in the session", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			const pi = load(boxd, { boxd: true, "boxd-no-repo": true });
			const ctx = fakeCtx(pi);
			await pi.fire("session_start", { reason: "startup" }, ctx);
			const [create] = boxd.called("create");
			const params = create.args[0] as { name: string; isolated: boolean; labels: Record<string, string> };
			assert.equal(params.isolated, true);
			assert.equal(params.name, "pi-11111111-2222-3333-4444-555555555555");
			assert.deepEqual(params.labels, { "created-by": "boxd-pi", "pi-session": "11111111-2222-3333-4444-555555555555" });
			const entry = pi.entries.at(-1)!;
			assert.equal(entry.customType, SESSION_ENTRY);
			assert.equal((entry.data as SessionEntryData).cwd, "/home/boxd/workspace");
			assert.equal((entry.data as SessionEntryData).region, "nyc");
			assert.equal(boxd.machines.size, 1);
		}));

	it("reattaches the recorded machine on resume, waking it instead of creating another", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			boxd.add({ id: "m-old", name: "pi-old", status: "hibernated" });
			const pi = load(boxd);
			pi.appendEntry(SESSION_ENTRY, { machineId: "m-old", machineName: "pi-old", cwd: "/home/boxd/api" });
			await pi.fire("session_start", { reason: "resume" }, fakeCtx(pi));
			assert.equal(boxd.called("create").length, 0);
			assert.equal(boxd.called("wake").length, 1);
			const prompt = { systemPromptOptions: { cwd: "/host/project", sections: {} as Record<string, string> } };
			await pi.fire("before_agent_start", prompt, fakeCtx(pi));
			assert.equal(prompt.systemPromptOptions.cwd, "/home/boxd/api");
			assert.match(prompt.systemPromptOptions.sections.boxd, /pi-old/);
		}));

	it("creates a new machine when the recorded one is gone", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			const pi = load(boxd, { boxd: true, "boxd-no-repo": true });
			pi.appendEntry(SESSION_ENTRY, { machineId: "m-deleted", machineName: "pi-x", cwd: "/home/boxd/workspace" });
			await pi.fire("session_start", { reason: "resume" }, fakeCtx(pi));
			assert.equal(boxd.called("create").length, 1);
		}));

	it("forks the parent's machine for a forked session, then hibernates the parent", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			boxd.add({ id: "m-parent", name: "pi-parent" });
			const pi = load(boxd);
			pi.appendEntry(SESSION_ENTRY, { machineId: "m-parent", machineName: "pi-parent", cwd: "/home/boxd/api" });
			await pi.fire("session_start", { reason: "fork" }, fakeCtx(pi, { sessionId: "child-session" }));
			const [fork] = boxd.called("fork");
			assert.equal(fork.args[0], "m-parent");
			assert.equal((fork.args[1] as { isolated: boolean }).isolated, true);
			assert.equal((pi.entries.at(-1)!.data as SessionEntryData).cwd, "/home/boxd/api");
			await new Promise((r) => setImmediate(r));
			assert.deepEqual(
				boxd.called("hibernate").map((c) => c.args[0]),
				["m-parent"],
			);
		}));

	it("forks when the recorded machine belongs to another session (pi --fork starts as a normal startup)", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			boxd.add({ id: "m-parent", name: "pi-parent", labels: { "pi-session": "parent-session" } });
			const pi = load(boxd);
			pi.appendEntry(SESSION_ENTRY, { machineId: "m-parent", machineName: "pi-parent", cwd: "/home/boxd/api", region: "nyc" });
			await pi.fire("session_start", { reason: "startup" }, fakeCtx(pi, { sessionId: "child-session" }));
			assert.equal(boxd.called("fork").length, 1);
			assert.notEqual((pi.entries.at(-1)!.data as SessionEntryData).machineId, "m-parent");
			// Resuming the parent itself reattaches, it does not fork.
			const pi2 = load(boxd);
			pi2.appendEntry(SESSION_ENTRY, { machineId: "m-parent", machineName: "pi-parent", cwd: "/home/boxd/api", region: "nyc" });
			await pi2.fire("session_start", { reason: "startup" }, fakeCtx(pi2, { sessionId: "parent-session" }));
			assert.equal(boxd.called("fork").length, 1);
		}));

	it("hibernates on quit for a saved session, deletes for an in-memory one, and keeps it on reload", () =>
		withKey(async () => {
			for (const [persisted, reason, expect] of [
				[true, "quit", "hibernate"],
				[false, "quit", "delete"],
				[true, "reload", "none"],
				[false, "fork", "none"],
			] as const) {
				const boxd = new FakeBoxd();
				const pi = load(boxd, { boxd: true, "boxd-no-repo": true });
				const ctx = fakeCtx(pi, { persisted });
				await pi.fire("session_start", { reason: "startup" }, ctx);
				await pi.fire("session_shutdown", { reason }, ctx);
				assert.equal(boxd.called("hibernate").length, expect === "hibernate" ? 1 : 0, `${persisted} ${reason}`);
				assert.equal(boxd.called("delete").length, expect === "delete" ? 1 : 0, `${persisted} ${reason}`);
			}
		}));

	it("clones the repo Pi was started in, with a GitHub token only in that command's env", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			const pi = load(boxd);
			pi.execResults.set("git -C /host/project remote get-url origin", { code: 0, stdout: "git@github.com:acme/api.git\n", stderr: "" });
			pi.execResults.set("git -C /host/project rev-parse --abbrev-ref HEAD", { code: 0, stdout: "dev\n", stderr: "" });
			pi.execResults.set("gh auth token", { code: 0, stdout: "gho_test\n", stderr: "" });
			await pi.fire("session_start", { reason: "startup" }, fakeCtx(pi));
			const clone = boxd
				.called("exec")
				.map((c) => c.args[1] as { command: string[]; env?: Record<string, string> })
				.find((p) => p.command[2].includes(" clone "))!;
			assert.equal(
				clone.command[2],
				"git -c core.hooksPath=/dev/null clone --branch 'dev' -- 'https://github.com/acme/api.git' '/home/boxd/api'",
			);
			assert.ok(clone.env?.GIT_CONFIG_VALUE_0?.startsWith("AUTHORIZATION: basic "));
			assert.equal((pi.entries.at(-1)!.data as SessionEntryData).cwd, "/home/boxd/api");
			assert.equal((pi.entries.at(-1)!.data as SessionEntryData).repo, "https://github.com/acme/api.git");
		}));

	it("deletes a new machine that never becomes ready", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			boxd.readyError = new Error("timed out waiting for the machine");
			const pi = load(boxd, { boxd: true, "boxd-no-repo": true });
			const ctx = fakeCtx(pi);
			await pi.fire("session_start", { reason: "startup" }, ctx);
			assert.equal(boxd.called("create").length, 1);
			assert.deepEqual(
				boxd.called("delete").map((c) => c.args[0]),
				["nyc-1"],
			);
			assert.equal(boxd.machines.size, 0);
			assert.equal(pi.entries.length, 0);
			assert.match(ctx.notes.at(-1)!.message, /could not start a machine: timed out/);
		}));

	it("deletes a fork that never becomes ready, and leaves the parent's machine alone", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			boxd.add({ id: "m-parent", name: "pi-parent" });
			boxd.readyError = new Error("timed out waiting for the machine");
			const pi = load(boxd);
			pi.appendEntry(SESSION_ENTRY, { machineId: "m-parent", machineName: "pi-parent", cwd: "/home/boxd/api" });
			const ctx = fakeCtx(pi, { sessionId: "child-session" });
			await pi.fire("session_start", { reason: "fork" }, ctx);
			assert.equal(boxd.called("fork").length, 1);
			assert.deepEqual(
				boxd.called("delete").map((c) => c.args[0]),
				["nyc-1"],
			);
			assert.deepEqual([...boxd.machines.keys()], ["m-parent"]);
			assert.equal(pi.entries.length, 1);
			assert.match(ctx.notes.at(-1)!.message, /could not start a machine: timed out/);
		}));

	it("a quit while the machine is still starting waits for it, then deletes or hibernates it", () =>
		withKey(async () => {
			for (const [persisted, expect] of [
				[false, "delete"],
				[true, "hibernate"],
			] as const) {
				const boxd = new FakeBoxd();
				let release = () => {};
				boxd.createGate = new Promise<void>((resolve) => {
					release = resolve;
				});
				const pi = load(boxd, { boxd: true, "boxd-no-repo": true });
				const ctx = fakeCtx(pi, { persisted });
				const start = pi.fire("session_start", { reason: "startup" }, ctx);
				await new Promise((r) => setImmediate(r));
				const quit = pi.fire("session_shutdown", { reason: "quit" }, ctx);
				await new Promise((r) => setImmediate(r));
				assert.equal(boxd.called("delete").length + boxd.called("hibernate").length, 0, "nothing to put away yet");
				release();
				await Promise.all([start, quit]);
				assert.deepEqual(
					boxd.called(expect).map((c) => c.args[0]),
					["nyc-1"],
					`persisted=${persisted}`,
				);
				assert.equal(boxd.machines.get("nyc-1")?.status, persisted ? "hibernated" : undefined);
			}
		}));

	it("gives an in-memory session's machine a delete timer, and a saved session's machine none", () =>
		withKey(async () => {
			const timer = async (persisted: boolean, parent: boolean) => {
				const boxd = new FakeBoxd();
				const pi = load(boxd, { boxd: true, "boxd-no-repo": true });
				if (parent) {
					boxd.add({ id: "m-parent", name: "pi-parent" });
					pi.appendEntry(SESSION_ENTRY, { machineId: "m-parent", machineName: "pi-parent", cwd: "/home/boxd/api" });
				}
				await pi.fire("session_start", { reason: parent ? "fork" : "startup" }, fakeCtx(pi, { persisted, sessionId: "s-1" }));
				const call = parent ? boxd.called("fork")[0].args[1] : boxd.called("create")[0].args[0];
				return (call as { deleteAfter?: number }).deleteAfter;
			};
			assert.equal(await timer(false, false), IN_MEMORY_DELETE_AFTER);
			assert.equal(await timer(true, false), undefined);
			assert.equal(await timer(false, true), IN_MEMORY_DELETE_AFTER);
			// A fork would inherit its parent's timer: 0 clears it for a session that is kept.
			assert.equal(await timer(true, true), 0);
			assert.equal(IN_MEMORY_DELETE_AFTER, 86_400);
		}));

	it("deletes a machine it created when setup fails, and stays off", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			const pi = load(boxd, { boxd: true, "boxd-repo": "https://github.com/acme/private" });
			boxd.execResults.push({ stdout: "", stderr: "", exitCode: 0 }); // git identity
			boxd.execResults.push({ stdout: "", stderr: "fatal: repository not found", exitCode: 128 });
			const ctx = fakeCtx(pi);
			await pi.fire("session_start", { reason: "startup" }, ctx);
			assert.equal(boxd.machines.size, 0);
			assert.match(ctx.notes.at(-1)!.message, /repository not found/);
			assert.equal(pi.entries.length, 0);
		}));

	it("refuses an unknown size before creating anything", () =>
		withKey(async () => {
			const boxd = new FakeBoxd();
			const pi = load(boxd, { boxd: true, "boxd-size": "3x3" });
			const ctx = fakeCtx(pi);
			await pi.fire("session_start", { reason: "startup" }, ctx);
			assert.equal(boxd.called("create").length, 0);
			assert.match(ctx.notes.at(-1)!.message, /Unknown machine size/);
		}));

	it("records the machine's region and reattaches there, whatever BOXD_REGION says later", () =>
		withKey(async () => {
			const nyc = new FakeBoxd("nyc");
			const fra = new FakeBoxd("fra");
			nyc.add({ id: "m-nyc", name: "pi-a", status: "hibernated" });
			const asked: (string | undefined)[] = [];
			const pi = new FakePi();
			pi.flags.set("boxd", true);
			pi.flags.set("boxd-region", "fra");
			boxdExtension((_c, region) => {
				asked.push(region);
				return (region === "nyc" ? nyc : fra).client();
			})(pi as never);
			pi.appendEntry(SESSION_ENTRY, { machineId: "m-nyc", machineName: "pi-a", cwd: "/home/boxd/workspace", region: "nyc" });
			await pi.fire("session_start", { reason: "resume" }, fakeCtx(pi));
			assert.deepEqual(asked, ["nyc"]);
			assert.equal(fra.called("create").length + nyc.called("create").length, 0);
			assert.equal(nyc.called("wake").length, 1);
		}));

	it("follows a machine boxd reports in another region instead of creating a second one", () =>
		withKey(async () => {
			const nyc = new FakeBoxd("nyc");
			const fra = new FakeBoxd("fra");
			nyc.add({ id: "m-nyc", name: "pi-a" });
			fra.elsewhere = [{ region: "nyc", name: "pi-a", orgId: null, id: "m-nyc" }];
			const pi = new FakePi();
			pi.flags.set("boxd", true);
			pi.flags.set("boxd-region", "fra");
			boxdExtension((_c, region) => (region === "nyc" ? nyc : fra).client())(pi as never);
			// An entry from before regions were recorded.
			pi.appendEntry(SESSION_ENTRY, { machineId: "m-nyc", machineName: "pi-a", cwd: "/home/boxd/workspace" });
			const ctx = fakeCtx(pi);
			await pi.fire("session_start", { reason: "resume" }, ctx);
			assert.equal(fra.called("create").length + nyc.called("create").length, 0);
			assert.match(ctx.notes.at(-1)!.message, /Reattached machine/);
			assert.equal((pi.entries.at(-1)!.data as SessionEntryData).region, "nyc");
		}));

	it("does nothing without --boxd", async () => {
		const boxd = new FakeBoxd();
		const pi = load(boxd, {});
		await pi.fire("session_start", { reason: "startup" }, fakeCtx(pi));
		assert.equal(boxd.calls.length, 0);
	});
});

describe("/boxd delete", () => {
	async function started(hasUI: boolean, confirm = true) {
		const boxd = new FakeBoxd();
		const pi = load(boxd, { boxd: true, "boxd-no-repo": true });
		const ctx = fakeCtx(pi, { hasUI });
		ctx.ui.confirm = async () => confirm;
		await pi.fire("session_start", { reason: "startup" }, ctx);
		const run = (args: string) => pi.commands.get("boxd")!.handler(args, ctx as never);
		return { boxd, pi, ctx, run };
	}

	it("asks first when Pi has a UI, and keeps the machine on no", () =>
		withKey(async () => {
			const { boxd, run } = await started(true, false);
			await run("delete");
			assert.equal(boxd.called("delete").length, 0);
		}));

	it("without a UI, needs --yes and says so", () =>
		withKey(async () => {
			const { boxd, ctx, run } = await started(false);
			await run("delete");
			assert.equal(boxd.called("delete").length, 0);
			assert.match(ctx.notes.at(-1)!.message, /needs --yes/);
			await run("delete --yes");
			assert.equal(boxd.called("delete").length, 1);
			assert.match(ctx.notes.at(-1)!.message, /^Deleted /);
		}));

	it("after a delete, tools refuse instead of running on the host", () =>
		withKey(async () => {
			const { pi, ctx, run } = await started(false);
			await run("delete -y");
			await assert.rejects(
				pi.tools.get("bash")!.execute("id", { command: "echo hi" }, undefined, undefined, ctx as never),
				/NOT run on your computer/,
			);
		}));
});

describe("/boxd push", () => {
	type Exec = { command: string[]; env?: Record<string, string>; cwd?: string };
	const CLONED = "https://github.com/acme/api.git";

	/** A session whose machine was cloned from CLONED (or has an empty workspace), with a gh login on the host. */
	async function started(repo = true) {
		const boxd = new FakeBoxd();
		const pi = load(boxd, repo ? { boxd: true, "boxd-repo": CLONED } : { boxd: true, "boxd-no-repo": true });
		pi.execResults.set("gh auth token", { code: 0, stdout: "gho_test\n", stderr: "" });
		const ctx = fakeCtx(pi);
		await pi.fire("session_start", { reason: "startup" }, ctx);
		const before = boxd.called("exec").length;
		const push = async (origin: string) => {
			boxd.execResults.push({ stdout: `${origin}\n`, stderr: "", exitCode: 0 });
			await pi.commands.get("boxd")!.handler("push work", ctx as never);
			return boxd
				.called("exec")
				.slice(before)
				.map((c) => c.args[1] as Exec);
		};
		return { boxd, pi, ctx, push };
	}

	it("pushes to the URL that was cloned, with git hooks off and the token only in that command's env", () =>
		withKey(async () => {
			const { ctx, push } = await started();
			const [readOrigin, pushed, ...rest] = await push("https://github.com/acme/api");
			assert.equal(readOrigin.command[2], "git remote get-url --push origin");
			assert.equal(readOrigin.env, undefined);
			assert.equal(pushed.command[2], `git -c core.hooksPath=/dev/null push -- '${CLONED}' 'HEAD:refs/heads/work' 2>&1`);
			assert.ok(pushed.env?.GIT_CONFIG_VALUE_0?.startsWith("AUTHORIZATION: basic "));
			assert.equal(pushed.cwd, "/home/boxd/api");
			assert.equal(rest.length, 0);
			assert.match(ctx.notes.at(-1)!.message, /^Pushed HEAD to work/);
		}));

	it("refuses when origin is no longer the URL that was cloned, and sends no token", () =>
		withKey(async () => {
			for (const origin of ["https://github.com/someone-else/api.git", "https://example.com/acme/api.git", "/home/boxd/elsewhere.git"]) {
				const { ctx, push } = await started();
				const calls = await push(origin);
				assert.equal(calls.length, 1, "only the origin lookup ran");
				assert.equal(calls[0].env, undefined);
				const note = ctx.notes.at(-1)!;
				assert.equal(note.type, "error");
				assert.ok(note.message.includes(`origin in the machine is ${origin}, not ${CLONED}`), note.message);
				assert.match(note.message, /token was not sent/);
			}
		}));

	it("sends no token from a workspace the extension did not clone", () =>
		withKey(async () => {
			const { push } = await started(false);
			const calls = await push("https://github.com/acme/api.git");
			assert.equal(calls.length, 2);
			assert.match(calls[1].command[2], /^git -c core\.hooksPath=\/dev\/null push -- 'https:\/\/github\.com\/acme\/api\.git' /);
			for (const c of calls) assert.deepEqual(c.env ?? {}, {});
		}));

	it("a resumed session and a forked one keep the cloned URL", () =>
		withKey(async () => {
			for (const reason of ["resume", "fork"] as const) {
				const boxd = new FakeBoxd();
				boxd.add({ id: "m-old", name: "pi-old" });
				const pi = load(boxd);
				pi.execResults.set("gh auth token", { code: 0, stdout: "gho_test\n", stderr: "" });
				pi.appendEntry(SESSION_ENTRY, { machineId: "m-old", machineName: "pi-old", cwd: "/home/boxd/api", repo: CLONED });
				const ctx = fakeCtx(pi, { sessionId: reason === "fork" ? "child-session" : undefined });
				await pi.fire("session_start", { reason }, ctx);
				if (reason === "fork") assert.equal((pi.entries.at(-1)!.data as SessionEntryData).repo, CLONED);
				boxd.execResults.push({ stdout: "https://github.com/someone-else/api.git\n", stderr: "", exitCode: 0 });
				await pi.commands.get("boxd")!.handler("push work", ctx as never);
				assert.match(ctx.notes.at(-1)!.message, /token was not sent/, reason);
			}
		}));
});
