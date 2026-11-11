import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { MachineFileNotFoundError, NotFoundError } from "@boxd-sh/sdk";
import {
	type ActiveMachine,
	backgroundSafe,
	ENSURE_RUNNING,
	ensureRunning,
	MachineGoneError,
	streamCommand,
	withRecovery,
} from "../src/machine.ts";
import { FakeBoxd } from "./fake.ts";

function setup(status = "running") {
	const boxd = new FakeBoxd();
	boxd.add({ id: "m-1", name: "pi-s1", status });
	const machine: ActiveMachine = { client: boxd.client(), id: "m-1", name: "pi-s1", cwd: "/home/boxd/workspace" };
	return { boxd, machine };
}

describe("backgroundSafe", () => {
	it("returns when the foreground exits, keeps its exit code and output", () => {
		const started = Date.now();
		const res = spawnSync("bash", ["-c", backgroundSafe("echo out; echo err >&2; (sleep 3; echo late) & exit 7")], {
			encoding: "utf8",
		});
		assert.equal(res.status, 7);
		assert.match(res.stdout, /out\nerr\n/);
		assert.doesNotMatch(res.stdout, /late/);
		assert.ok(Date.now() - started < 2500, "a background child must not hold the call open");
	});

	it("keeps an `exit` inside the command from skipping the replay", () => {
		const res = spawnSync("bash", ["-c", backgroundSafe("printf 'no newline'; exit 0")], { encoding: "utf8" });
		assert.equal(res.status, 0);
		assert.equal(res.stdout, "no newline");
	});
});

describe("streamCommand", () => {
	it("streams stdout and stderr and returns the exit code", async () => {
		const { boxd, machine } = setup();
		boxd.streamScripts.push({ chunks: ["a\n", "b\n"], stderr: ["e\n"], exitCode: 3 });
		const out: string[] = [];
		const res = await streamCommand(machine, "x", "/home/boxd/workspace", { onData: (d) => out.push(d.toString()) });
		assert.equal(res.exitCode, 3);
		assert.deepEqual(out.sort(), ["a\n", "b\n", "e\n"]);
	});

	it("sends only PI_* variables from the host environment", async () => {
		const { boxd, machine } = setup();
		await streamCommand(machine, "env", "/w", {
			onData: () => {},
			env: { PI_SESSION_ID: "s1", PI_MODEL: "m", HOME: "/Users/me", AWS_SECRET_ACCESS_KEY: "nope" },
		});
		const params = boxd.called("streamExec")[0].args[1] as { env: Record<string, string>; cwd: string; closeStdin: boolean };
		assert.deepEqual(params.env, { PI_SESSION_ID: "s1", PI_MODEL: "m" });
		assert.equal(params.cwd, "/w");
		assert.equal(params.closeStdin, true);
	});

	it("closes the call on abort and reports `aborted`", async () => {
		const { boxd, machine } = setup();
		boxd.streamScripts.push({ hang: true });
		const ac = new AbortController();
		const p = streamCommand(machine, "sleep 60", "/w", { onData: () => {}, signal: ac.signal });
		setTimeout(() => ac.abort(), 20);
		await assert.rejects(p, /^Error: aborted$/);
		assert.equal(boxd.closed, 1);
	});

	it("closes the call on timeout and reports Pi's `timeout:<s>` form", async () => {
		const { boxd, machine } = setup();
		boxd.streamScripts.push({ hang: true });
		await assert.rejects(streamCommand(machine, "sleep 60", "/w", { onData: () => {}, timeout: 0.05 }), /^Error: timeout:0.05$/);
		assert.equal(boxd.closed, 1);
	});

	it("starts a stopped machine and runs the command once more", async () => {
		const { boxd, machine } = setup("stopped");
		boxd.streamScripts.push({ chunks: ["ok\n"], exitCode: 0 });
		let out = "";
		const res = await streamCommand(machine, "echo ok", "/w", { onData: (d) => (out += d) });
		assert.equal(res.exitCode, 0);
		assert.equal(out, "ok\n");
		assert.equal(boxd.called("start").length, 1);
		assert.equal(boxd.called("streamExec").length, 2);
	});

	it("fails with MachineGoneError when the machine was deleted, and runs nothing locally", async () => {
		const { boxd, machine } = setup();
		boxd.machines.delete("m-1");
		await assert.rejects(streamCommand(machine, "echo", "/w", { onData: () => {} }), MachineGoneError);
	});
});

describe("ensureRunning", () => {
	it("tries a refused wake again until it works", async () => {
		const { boxd } = setup("hibernated");
		boxd.wakeFailures = 2;
		const saved = ENSURE_RUNNING.firstRetryMs;
		ENSURE_RUNNING.firstRetryMs = 1;
		try {
			await ensureRunning(boxd.client(), "m-1");
		} finally {
			ENSURE_RUNNING.firstRetryMs = saved;
		}
		assert.equal(boxd.called("wake").length, 3);
		assert.equal(boxd.machines.get("m-1")?.status, "running");
	});

	it("gives up with the last error at the timeout", async () => {
		const { boxd } = setup("hibernated");
		boxd.wakeFailures = 1000;
		const saved = { ...ENSURE_RUNNING };
		Object.assign(ENSURE_RUNNING, { timeoutMs: 30, firstRetryMs: 5 });
		try {
			await assert.rejects(ensureRunning(boxd.client(), "m-1"), /not ready to wake yet/);
		} finally {
			Object.assign(ENSURE_RUNNING, saved);
		}
	});

	it("does not retry a machine that is gone", async () => {
		const { boxd } = setup("hibernated");
		boxd.machines.delete("m-1");
		await assert.rejects(ensureRunning(boxd.client(), "m-1"), NotFoundError);
	});
});

describe("withRecovery", () => {
	it("wakes a hibernated machine and retries", async () => {
		const { boxd, machine } = setup("hibernated");
		let n = 0;
		const res = await withRecovery(machine, async () => {
			if (n++ === 0) throw new Error("unavailable");
			return "ok";
		});
		assert.equal(res, "ok");
		assert.equal(boxd.called("wake").length, 1);
	});

	it("rethrows a file error without looking up the machine", async () => {
		const { boxd, machine } = setup();
		await assert.rejects(
			withRecovery(machine, async () => {
				throw new MachineFileNotFoundError("nope", 5, "/x");
			}),
			MachineFileNotFoundError,
		);
		assert.equal(boxd.called("get").length, 0);
	});

	it("rethrows the call's own error when the machine is running", async () => {
		const { machine } = setup();
		await assert.rejects(
			withRecovery(machine, async () => {
				throw new Error("real failure");
			}),
			/real failure/,
		);
	});
});
