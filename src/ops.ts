/**
 * Pi's pluggable tool operations, backed by a boxd machine.
 *
 * `bash`, `read`, `write`, `edit` and `ls` accept an `*Operations` object. These versions run against
 * the session's machine: bash through a streamed exec, the file tools through the machine filesystem
 * API. The tools are built with the machine's working directory as `cwd`, so the absolute paths Pi
 * hands to these operations are already machine paths.
 *
 * `grep` and `find` are not here: Pi runs ripgrep and fd on the host and only uses their operations for
 * small checks. They run inside the machine through `search.ts`.
 */

import { MachineFileNotFoundError } from "@boxd-sh/sdk";
import type { BashOperations, EditOperations, LsOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { type ActiveMachine, streamCommand, withRecovery } from "./machine.ts";

/** Bash operations. `cwdOverride` pins the directory for user `!` commands, which Pi runs in the host cwd. */
export function createBashOps(machine: ActiveMachine, cwdOverride?: string): BashOperations {
	return {
		exec: (command, cwd, options) => streamCommand(machine, command, cwdOverride ?? cwd, options),
	};
}

export function createReadOps(machine: ActiveMachine): ReadOperations {
	return {
		readFile: (path) => readFile(machine, path),
		access: (path) => access(machine, path),
		detectImageMimeType: async (path) => {
			try {
				const head = await withRecovery(machine, () => machine.client.fs.read(machine.id, path, { length: 16 }));
				return sniffImage(Buffer.from(head));
			} catch {
				return null;
			}
		},
		createReadStream: (path, { signal }) => readStream(machine, path, signal),
	};
}

export function createWriteOps(machine: ActiveMachine): WriteOperations {
	return {
		writeFile: (path, content) => writeFile(machine, path, content),
		mkdir: (dir) => withRecovery(machine, () => machine.client.fs.mkdir(machine.id, dir)),
	};
}

/** Pi's edit tool reads the file, applies its exact-match edits in process, and writes it back. */
export function createEditOps(machine: ActiveMachine): EditOperations {
	return {
		readFile: (path) => readFile(machine, path),
		writeFile: (path, content) => writeFile(machine, path, content),
		access: (path) => access(machine, path),
	};
}

export function createLsOps(machine: ActiveMachine): LsOperations {
	return {
		exists: async (path) => {
			try {
				await withRecovery(machine, () => machine.client.fs.stat(machine.id, path));
				return true;
			} catch (err) {
				if (err instanceof MachineFileNotFoundError) return false;
				throw err;
			}
		},
		stat: async (path) => {
			const entry = await withRecovery(machine, () => machine.client.fs.stat(machine.id, path));
			return { isDirectory: () => entry.isDir };
		},
		readdir: async (path) => {
			const entries = await withRecovery(machine, () => machine.client.fs.list(machine.id, path));
			return entries.map((e) => e.name).sort();
		},
	};
}

async function readFile(machine: ActiveMachine, path: string): Promise<Buffer> {
	return Buffer.from(await withRecovery(machine, () => machine.client.fs.read(machine.id, path)));
}

async function writeFile(machine: ActiveMachine, path: string, content: string): Promise<void> {
	await withRecovery(machine, () => machine.client.fs.write(machine.id, path, content));
}

async function access(machine: ActiveMachine, path: string): Promise<void> {
	const entry = await withRecovery(machine, () => machine.client.fs.stat(machine.id, path));
	if (entry.isDir) throw new Error(`Is a directory: ${path}`);
}

async function* readStream(machine: ActiveMachine, path: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
	// Waking a sleeping machine happens here, before the first chunk; a stream cut short later is an error.
	await withRecovery(machine, () => machine.client.fs.stat(machine.id, path));
	for await (const chunk of machine.client.fs.readStream(machine.id, path)) {
		if (signal?.aborted) return;
		yield chunk;
	}
}

/** The image types Pi's read tool can attach, recognised by their first bytes. */
export function sniffImage(head: Buffer): string | null {
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
	if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "image/gif";
	if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP")
		return "image/webp";
	return null;
}
