// Offline smoke test: load the extension the way Pi does (through jiti) against a stub ExtensionAPI and
// check it registers its flags, tools, command and events. No API key, no network.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = createRequire(hostEntry)("jiti");
const jiti = createJiti(import.meta.url);

const flags = [];
const tools = [];
const events = [];
const commands = [];
const stubPi = {
	registerFlag: (name) => flags.push(name),
	registerTool: (tool) => tools.push(tool.name),
	registerCommand: (name) => commands.push(name),
	on: (event) => events.push(event),
	getFlag: () => undefined,
};

const mod = await jiti.import(path.join(root, "index.ts"));
const factory = mod.default ?? mod;
if (typeof factory !== "function") throw new Error("the extension's default export is not a function");
await factory(stubPi);

function expect(label, actual, wanted) {
	const missing = wanted.filter((w) => !actual.includes(w));
	if (missing.length) throw new Error(`${label}: missing ${JSON.stringify(missing)} (got ${JSON.stringify(actual)})`);
	console.log(`ok ${label}: ${wanted.join(", ")}`);
}

expect("flags", flags, ["boxd", "boxd-repo", "boxd-branch", "boxd-no-repo", "boxd-snapshot", "boxd-size", "boxd-region", "boxd-org"]);
expect("tools", tools, ["bash", "read", "write", "edit", "ls", "find", "grep", "preview_url"]);
expect("events", events, ["user_bash", "session_start", "before_agent_start", "session_shutdown"]);
expect("commands", commands, ["boxd"]);
console.log("\nsmoke test passed: the extension loads and registers cleanly");
