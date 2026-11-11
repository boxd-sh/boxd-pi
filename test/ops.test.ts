import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveMachine } from "../src/machine.ts";
import { createEditOps, createLsOps, createReadOps, createWriteOps, sniffImage } from "../src/ops.ts";
import { previewUrl } from "../src/preview.ts";
import { runRemoteFind, runRemoteGrep } from "../src/search.ts";
import { FakeBoxd } from "./fake.ts";

function setup() {
	const boxd = new FakeBoxd();
	boxd.add({ id: "m-1", name: "pi-s1" });
	const machine: ActiveMachine = { client: boxd.client(), id: "m-1", name: "pi-s1", cwd: "/home/boxd/workspace" };
	return { boxd, machine };
}

describe("file operations", () => {
	it("write then read round-trips through the machine filesystem", async () => {
		const { boxd, machine } = setup();
		await createWriteOps(machine).writeFile("/home/boxd/workspace/a.txt", "héllo\n");
		const buf = await createReadOps(machine).readFile("/home/boxd/workspace/a.txt");
		assert.equal(buf.toString("utf8"), "héllo\n");
		assert.equal(boxd.called("fs.write")[0].args[1], "/home/boxd/workspace/a.txt");
	});

	it("edit ops refuse a directory and a missing file", async () => {
		const { machine } = setup();
		const ops = createEditOps(machine);
		await assert.rejects(ops.access("/home/boxd"), /Is a directory/);
		await assert.rejects(ops.access("/nope"), /No such file/);
	});

	it("ls: exists is false for a missing path, readdir lists names sorted", async () => {
		const { boxd, machine } = setup();
		const m = boxd.machines.get("m-1")!;
		m.dirs.add("/d");
		m.files.set("/d/b", Buffer.from(""));
		m.files.set("/d/a", Buffer.from(""));
		const ls = createLsOps(machine);
		assert.equal(await ls.exists("/missing"), false);
		assert.equal(await ls.exists("/d"), true);
		assert.equal((await ls.stat("/d")).isDirectory(), true);
		assert.deepEqual(await ls.readdir("/d"), ["a", "b"]);
	});

	it("detects images by their first bytes, without running a command", async () => {
		const { boxd, machine } = setup();
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		boxd.machines.get("m-1")!.files.set("/i.png", png);
		assert.equal(await createReadOps(machine).detectImageMimeType!("/i.png"), "image/png");
		assert.equal(sniffImage(Buffer.from("plain text here")), null);
		assert.equal(boxd.called("exec").length, 0);
	});
});

describe("search in the machine", () => {
	it("find runs in the requested directory and strips ./", async () => {
		const { boxd, machine } = setup();
		boxd.execResults.push({ stdout: "./src/a.ts\nsrc/b.ts\n", stderr: "", exitCode: 0 });
		const res = await runRemoteFind(machine, { pattern: "src/*.ts", path: "pkg" });
		assert.equal(res.content[0].text, "src/a.ts\nsrc/b.ts");
		const params = boxd.called("exec")[0].args[1] as { cwd: string; command: string[] };
		assert.equal(params.cwd, "/home/boxd/workspace/pkg");
		assert.match(params.command[2], /-g '\*\*\/src\/\*\.ts'/);
	});

	it("grep quotes the pattern, says when nothing matched, and fails on a real error", async () => {
		const { boxd, machine } = setup();
		boxd.execResults.push({ stdout: "", stderr: "", exitCode: 0 });
		const res = await runRemoteGrep(machine, { pattern: "it's $HOME", literal: true });
		assert.match(res.content[0].text, /No matches found/);
		const cmd = (boxd.called("exec")[0].args[1] as { command: string[] }).command[2];
		assert.match(cmd, /'it'\\''s \$HOME'/);
		assert.match(cmd, /--fixed-strings/);
		boxd.execResults.push({ stdout: "./src/a.ts:3:x\n./src/b.ts:9:y\n", stderr: "", exitCode: 0 });
		const hits = await runRemoteGrep(machine, { pattern: "x|y" });
		assert.equal(hits.content[0].text, "src/a.ts:3:x\nsrc/b.ts:9:y");
		boxd.execResults.push({ stdout: "", stderr: "rg: bad regex", exitCode: 2 });
		await assert.rejects(runRemoteGrep(machine, { pattern: "(" }), /grep failed/);
	});
});

describe("preview URL", () => {
	it("creates the p<port> route once and returns its HTTPS URL", async () => {
		const { boxd, machine } = setup();
		assert.equal(await previewUrl(machine, 3000), "https://p3000.pi-s1.nyc.boxd.sh");
		assert.equal(await previewUrl(machine, 3000), "https://p3000.pi-s1.nyc.boxd.sh");
		assert.equal(boxd.called("proxies.create").length, 1);
	});
});
