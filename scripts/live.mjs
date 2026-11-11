// Live test against real boxd. Runs the extension's lifecycle and Pi's real tool definitions against
// machines it creates. Needs BOXD_E2E=1 and BOXD_API_KEY (BOXD_ORG and BOXD_REGION optional).
// Machine names start with BOXD_PI_NAME_PREFIX (default "pi-live-"). At the end it deletes every machine
// it created, by the ids it recorded.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.BOXD_E2E !== "1") {
	console.log("skipped: set BOXD_E2E=1 (and BOXD_API_KEY) to run the live test");
	process.exit(0);
}
process.env.BOXD_PI_NAME_PREFIX ||= "pi-live-";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = createRequire(hostEntry)("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const ext = await jiti.import(path.join(root, "index.ts"));
const { FakePi, fakeCtx } = await jiti.import(path.join(root, "test/fake.ts"));
const { createClient } = await jiti.import(path.join(root, "src/config.ts"));
const { createReadOps, createWriteOps } = await jiti.import(path.join(root, "src/ops.ts"));
const { NotFoundError } = await import("@boxd-sh/sdk");

const client = createClient({ apiKey: process.env.BOXD_API_KEY }, process.env.BOXD_REGION);
let pass = 0;
let fail = 0;
const created = [];

async function check(name, fn) {
	const t0 = performance.now();
	try {
		const detail = await fn();
		pass++;
		console.log(`PASS ${name} (${Math.round(performance.now() - t0)} ms)${detail ? `: ${detail}` : ""}`);
	} catch (err) {
		fail++;
		console.log(`FAIL ${name} (${Math.round(performance.now() - t0)} ms): ${err?.stack ?? err}`);
	}
}

/** Poll a machine's status until it reads `want` (state changes are asynchronous). */
async function settle(id, want, seconds = 60) {
	let status = "";
	for (let i = 0; i < seconds; i++) {
		status = (await client.get(id)).status;
		if (status === want) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return status;
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

/** A Pi stand-in with the extension loaded, the --boxd flag and the given extra flags. */
function loadPi(flags = {}) {
	const pi = new FakePi();
	pi.flags.set("boxd", true);
	for (const [k, v] of Object.entries(flags)) pi.flags.set(k, v);
	ext.default(pi);
	return pi;
}

function text(result) {
	return result.content.map((c) => c.text).join("");
}

async function bash(pi, ctx, command, extra = {}) {
	return pi.tools.get("bash").execute(randomUUID(), { command, ...extra }, extra.signal, undefined, ctx);
}

function machineOf(pi) {
	const entry = pi.entries.at(-1).data;
	return entry;
}

const runId = randomBytes(3).toString("hex");

// Credential checks first: they create nothing.
await check("wrong API key: a clear error, nothing created", async () => {
	const saved = process.env.BOXD_API_KEY;
	process.env.BOXD_API_KEY = "not-a-real-boxd-key";
	try {
		const piW = loadPi({ "boxd-no-repo": true });
		const ctxW = fakeCtx(piW, { sessionId: `${runId}-w` });
		await piW.fire("session_start", { reason: "startup" }, ctxW);
		const note = ctxW.notes.at(-1);
		assert(note.type === "error" && piW.entries.length === 0, JSON.stringify(note));
		return note.message;
	} finally {
		process.env.BOXD_API_KEY = saved;
	}
});

await check("missing API key: a clear error, nothing created", async () => {
	const saved = process.env.BOXD_API_KEY;
	delete process.env.BOXD_API_KEY;
	try {
		const piM = loadPi();
		const ctxM = fakeCtx(piM, { sessionId: `${runId}-m` });
		await piM.fire("session_start", { reason: "startup" }, ctxM);
		const note = ctxM.notes.at(-1);
		assert(note.type === "error" && /BOXD_API_KEY/.test(note.message), JSON.stringify(note));
		let msg = "";
		try {
			await bash(piM, ctxM, "echo hi");
		} catch (e) {
			msg = e.message;
		}
		assert(/NOT run on your computer/.test(msg), msg);
		return note.message;
	} finally {
		process.env.BOXD_API_KEY = saved;
	}
});

const sessionA = `${runId}-a`;
const piA = loadPi({ "boxd-no-repo": true });
const ctxA = fakeCtx(piA, { sessionId: sessionA });
let A;

await check("create + ready through session_start", async () => {
	await piA.fire("session_start", { reason: "startup" }, ctxA);
	assert(piA.entries.length > 0, ctxA.notes.at(-1)?.message ?? "no machine");
	A = machineOf(piA);
	created.push(A.machineId);
	const m = await client.get(A.machineId);
	assert(m.status === "running", `status ${m.status}`);
	assert(m.labels["created-by"] === "boxd-pi" && m.labels["pi-session"] === sessionA, JSON.stringify(m.labels));
	return `${m.name} id ${m.id}, ${ctxA.notes.at(-1).message}`;
});

if (!A) {
	console.log(`\nstopped: no machine to test against (${ctxA.notes.at(-1)?.message ?? "no message"})`);
	process.exit(1);
}

await check("isolated is on", async () => {
	const m = await client.get(A.machineId);
	assert(m.networking.isolated === true, JSON.stringify(m.networking));
	return "networking.isolated = true";
});

await check("bash: output and exit code", async () => {
	const ok = await bash(piA, ctxA, "echo hello; pwd; whoami");
	assert(text(ok).includes("hello\n/home/boxd/workspace\nboxd"), text(ok));
	const bad = await bash(piA, ctxA, "echo before; exit 42");
	assert(bad.isError && /before[\s\S]*exited with code 42/.test(text(bad)), text(bad));
	return "exit 42 reported";
});

await check("bash: stdout and stderr both reach Pi", async () => {
	const r = await bash(piA, ctxA, "echo to-out; echo to-err >&2");
	assert(/to-out/.test(text(r)) && /to-err/.test(text(r)), text(r));
});

await check("bash: only PI_* variables travel from the host", async () => {
	process.env.HOST_ONLY_SECRET = "must-not-leak";
	const r = await bash(piA, ctxA, 'echo "sid=$PI_SESSION_ID secret=${HOST_ONLY_SECRET:-unset}"');
	assert(text(r).includes(`sid=${sessionA} secret=unset`), text(r));
	return text(r).trim();
});

await check("bash: timeout ends the remote process", async () => {
	let msg = "";
	try {
		await bash(piA, ctxA, "sleep 30; echo never", { timeout: 2 });
	} catch (e) {
		msg = e.message;
	}
	assert(/timed out after 2 seconds/.test(msg), msg);
	const ps = await bash(piA, ctxA, "pgrep -x sleep || echo none");
	assert(text(ps).includes("none"), text(ps));
	return msg;
});

await check("bash: abort ends the remote process", async () => {
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 1000);
	let msg = "";
	try {
		await bash(piA, ctxA, "sleep 40", { signal: ac.signal });
	} catch (e) {
		msg = e.message;
	}
	assert(/aborted/.test(msg), msg);
	const ps = await bash(piA, ctxA, "pgrep -x sleep || echo none");
	assert(text(ps).includes("none"), text(ps));
	return msg;
});

await check("bash: output streams while the command runs", async () => {
	const seen = [];
	const t0 = performance.now();
	await piA.tools
		.get("bash")
		.execute(
			"s",
			{ command: "for i in 1 2 3; do echo tick $i; sleep 1; done" },
			undefined,
			(u) => seen.push([Math.round(performance.now() - t0), text(u)]),
			ctxA,
		);
	const firstTick = seen.find(([, t]) => t.includes("tick 1"));
	assert(firstTick && firstTick[0] < 1500, JSON.stringify(seen));
	return `first update at ${firstTick[0]} ms`;
});

let url;
await check("background server survives the call; preview_url serves it", async () => {
	const r = await bash(piA, ctxA, "python3 -m http.server 8080 & sleep 0.5; echo started");
	assert(text(r).includes("started"), text(r));
	const again = await bash(piA, ctxA, "sleep 1; curl -s -o /dev/null -w '%{http_code}' localhost:8080");
	assert(text(again).includes("200"), text(again));
	const p = await piA.tools.get("preview_url").execute("p", { port: 8080 });
	url = text(p).match(/https:\/\/\S+/)[0];
	// The first named route on a machine gets its HTTPS certificate within about a minute.
	let code = 0;
	let tries = 0;
	for (; tries < 90 && code !== 200; tries++) {
		try {
			code = (await fetch(url)).status;
		} catch {
			code = 0;
		}
		if (code !== 200) await new Promise((r) => setTimeout(r, 1000));
	}
	assert(code === 200, `GET ${url} -> ${code}`);
	return `${url} -> 200 after ${tries} tries`;
});

await check("write, read, edit, ls, find, grep tools", async () => {
	const t = (n) => piA.tools.get(n);
	await t("write").execute("w", { path: "src/app.py", content: "print('hello')\n" }, undefined, undefined, ctxA);
	const r = await t("read").execute("r", { path: "src/app.py" }, undefined, undefined, ctxA);
	assert(text(r).includes("print('hello')"), text(r));
	await t("edit").execute("e", { path: "src/app.py", edits: [{ oldText: "hello", newText: "boxd" }] }, undefined, undefined, ctxA);
	const run = await bash(piA, ctxA, "python3 src/app.py");
	assert(text(run).includes("boxd"), text(run));
	const ls = await t("ls").execute("l", { path: "src" }, undefined, undefined, ctxA);
	assert(text(ls).includes("app.py"), text(ls));
	const find = await t("find").execute("f", { pattern: "**/*.py" }, undefined, undefined, ctxA);
	assert(text(find).includes("src/app.py"), text(find));
	const grep = await t("grep").execute("g", { pattern: "print", ignoreCase: true }, undefined, undefined, ctxA);
	assert(/^src\/app.py:1:print\('boxd'\)/m.test(text(grep)), text(grep));
	return `edit applied, grep: ${text(grep).trim()}`;
});

await check("5 MiB upload and download round trip (sha256)", async () => {
	const machine = { client, id: A.machineId, name: A.machineName, cwd: A.cwd };
	const up = randomBytes(5 * 1024 * 1024)
		.toString("base64")
		.slice(0, 5 * 1024 * 1024);
	await createWriteOps(machine).writeFile("/home/boxd/workspace/up.txt", up);
	const remote = await bash(piA, ctxA, "sha256sum up.txt | cut -d' ' -f1; stat -c %s up.txt");
	const local = createHash("sha256").update(up).digest("hex");
	assert(text(remote).includes(local), `${text(remote)} vs ${local}`);
	await bash(piA, ctxA, "head -c 5242880 /dev/urandom > down.bin");
	const remoteDown = text(await bash(piA, ctxA, "sha256sum down.bin | cut -d' ' -f1"))
		.trim()
		.split("\n")[0];
	const buf = await createReadOps(machine).readFile("/home/boxd/workspace/down.bin");
	const localDown = createHash("sha256").update(buf).digest("hex");
	assert(buf.length === 5242880 && localDown === remoteDown, `${buf.length} ${localDown} ${remoteDown}`);
	return `up ${local.slice(0, 12)}…, down ${localDown.slice(0, 12)}… match`;
});

await check("user ! commands run in the machine's working directory", async () => {
	const [res] = await piA.fire("user_bash", { command: "pwd", cwd: "/host/project" }, ctxA);
	let out = "";
	const r = await res.operations.exec("pwd", "/host/project", { onData: (d) => (out += d) });
	assert(r.exitCode === 0 && out.trim() === "/home/boxd/workspace", out);
	return out.trim();
});

await check("/boxd status, url, push and hibernate", async () => {
	const run = (args) => piA.commands.get("boxd").handler(args, ctxA);
	await run("status");
	assert(/running/.test(ctxA.notes.at(-1).message), ctxA.notes.at(-1).message);
	await run("url 8080");
	assert(/https:\/\/p8080\./.test(ctxA.notes.at(-1).message), ctxA.notes.at(-1).message);
	await bash(
		piA,
		ctxA,
		"git init -q --bare /home/boxd/remote.git && git remote add origin /home/boxd/remote.git && git add -A && git commit -qm work",
	);
	await run("push pi/live");
	const pushed = await bash(piA, ctxA, "git --git-dir=/home/boxd/remote.git log --oneline -1 pi/live");
	assert(/work/.test(text(pushed)), text(pushed));
	await run("hibernate");
	const st = await settle(A.machineId, "hibernated");
	assert(st === "hibernated", st);
	const woke = await bash(piA, ctxA, "echo awake");
	assert(text(woke).includes("awake"), text(woke));
	return `pushed: ${text(pushed).trim()}; hibernated, then woke on the next call`;
});

let piB;
let ctxB;
let B;
await check("fork the session: the machine is copied with files and running processes", async () => {
	piB = loadPi();
	piB.entries.push(...piA.entries);
	ctxB = fakeCtx(piB, { sessionId: `${runId}-b` });
	const t0 = performance.now();
	await piB.fire("session_start", { reason: "fork" }, ctxB);
	const ms = Math.round(performance.now() - t0);
	B = machineOf(piB);
	assert(B.machineId !== A.machineId, "fork kept the parent id");
	created.push(B.machineId);
	const r = await bash(piB, ctxB, "cat src/app.py; curl -s -o /dev/null -w '%{http_code}' localhost:8080");
	assert(text(r).includes("print('boxd')") && text(r).includes("200"), text(r));
	const fm = await client.get(B.machineId);
	assert(fm.networking.isolated === true, "fork not isolated");
	return `${B.machineName} id ${B.machineId} in ${ms} ms; file present, server answers 200 in the fork`;
});

await check("after a fork the parent machine is hibernated", async () => {
	const status = await settle(A.machineId, "hibernated", 30);
	assert(status === "hibernated", status);
	return status;
});

await check("a tool call wakes a hibernated machine", async () => {
	const t0 = performance.now();
	const r = await bash(piA, ctxA, "cat src/app.py");
	assert(text(r).includes("print('boxd')"), text(r));
	return `woke and answered in ${Math.round(performance.now() - t0)} ms`;
});

await check("a tool call starts a stopped machine", async () => {
	await client.stop(B.machineId);
	const status = await settle(B.machineId, "stopped");
	const t0 = performance.now();
	const r = await bash(piB, ctxB, "cat src/app.py");
	assert(text(r).includes("print('boxd')"), text(r));
	return `was ${status}; started and answered in ${Math.round(performance.now() - t0)} ms`;
});

await check("quit hibernates a saved session's machine; resume reattaches the same machine", async () => {
	await piB.fire("session_shutdown", { reason: "quit" }, ctxB);
	const st = await settle(B.machineId, "hibernated");
	assert(st === "hibernated", st);
	const piB2 = loadPi();
	piB2.entries.push(...piB.entries);
	const ctxB2 = fakeCtx(piB2, { sessionId: `${runId}-b` });
	const t0 = performance.now();
	await piB2.fire("session_start", { reason: "resume" }, ctxB2);
	const ms = Math.round(performance.now() - t0);
	assert(machineOf(piB2).machineId === B.machineId, "different machine");
	const r = await bash(piB2, ctxB2, "cat src/app.py");
	assert(text(r).includes("print('boxd')"), text(r));
	await piB2.fire("session_shutdown", { reason: "quit" }, ctxB2);
	return `hibernated, then reattached ${B.machineName} in ${ms} ms`;
});

await check("in-memory session: quit deletes its machine; get(id) is not found; tools refuse", async () => {
	const piC = loadPi({ "boxd-no-repo": true });
	const ctxC = fakeCtx(piC, { sessionId: `${runId}-c`, persisted: false });
	await piC.fire("session_start", { reason: "startup" }, ctxC);
	const C = machineOf(piC);
	created.push(C.machineId);
	console.log(`  created ${C.machineName} id ${C.machineId}`);
	const machine = { client, id: C.machineId, name: C.machineName, cwd: C.cwd };
	await piC.fire("session_shutdown", { reason: "quit" }, ctxC);
	let gone = false;
	try {
		await client.get(C.machineId);
	} catch (e) {
		gone = e instanceof NotFoundError;
	}
	assert(gone, "machine still there");
	let err;
	try {
		await createReadOps(machine).readFile("/home/boxd/workspace/x");
	} catch (e) {
		err = e;
	}
	// By name: jiti gives this script its own copy of the module, so instanceof would compare two classes.
	assert(err?.name === "MachineGoneError", String(err));
	console.log(`  DELETED-BY-TEST ${C.machineId}`);
	return err.message;
});

await check("/boxd delete removes the session's machine, by id, after asking", async () => {
	const piD = loadPi({ "boxd-no-repo": true });
	// With a UI, /boxd delete asks (the fake answers yes); without one it needs --yes.
	const ctxD = fakeCtx(piD, { sessionId: `${runId}-d`, hasUI: true });
	await piD.fire("session_start", { reason: "startup" }, ctxD);
	const D = machineOf(piD);
	created.push(D.machineId);
	console.log(`  created ${D.machineName} id ${D.machineId}`);
	await piD.commands.get("boxd").handler("delete", { ...ctxD, hasUI: false });
	assert((await client.get(D.machineId)).status !== undefined, "deleted without --yes");
	assert(/needs --yes/.test(ctxD.notes.at(-1).message), ctxD.notes.at(-1).message);
	await piD.commands.get("boxd").handler("delete", ctxD);
	let gone = false;
	try {
		await client.get(D.machineId);
	} catch (e) {
		gone = e instanceof NotFoundError;
	}
	assert(gone, "machine still there");
	console.log(`  DELETED-BY-TEST ${D.machineId}`);
	let msg = "";
	try {
		await bash(piD, ctxD, "echo hi");
	} catch (e) {
		msg = e.message;
	}
	assert(/NOT run on your computer/.test(msg), msg);
	return ctxD.notes.at(-1).message;
});

await piA.fire("session_shutdown", { reason: "quit" }, ctxA);

// Clean up: delete what this run created and is still there, by id.
for (const id of created) {
	try {
		await client.delete(id);
		console.log(`  DELETED-BY-TEST ${id}`);
	} catch (e) {
		if (!(e instanceof NotFoundError)) {
			fail++;
			console.log(`FAIL delete ${id}: ${e?.message ?? e}`);
		}
	}
}
console.log(`\nmachines created: ${created.join(" ")}`);
console.log(`${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
