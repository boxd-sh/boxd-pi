/**
 * find and grep, run inside the machine.
 *
 * Pi's built-in find and grep spawn fd and ripgrep on the host, so swapping their operations does not
 * move the search. These run `rg` in the machine (it is on the boxd image), with POSIX `find`/`grep`
 * as the fallback for snapshots without it. Output is cut to the requested limit inside the machine
 * and to Pi's size limits on the host.
 */

import { DEFAULT_MAX_BYTES, truncateHead } from "@earendil-works/pi-coding-agent";
import { type ActiveMachine, runCommand } from "./machine.ts";
import { joinPath, shellQuote } from "./util.ts";

/** Mirrors Pi's find parameters. */
export interface FindParams {
	pattern: string;
	path?: string;
	limit?: number;
}

/** Mirrors Pi's grep parameters. */
export interface GrepParams {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
}

export interface SearchResult {
	content: { type: "text"; text: string }[];
	details: undefined;
}

/** Find files by glob inside the machine. Respects .gitignore like fd; skips .git and node_modules. */
export async function runRemoteFind(machine: ActiveMachine, params: FindParams): Promise<SearchResult> {
	const max = positiveInt(params.limit, 1000);
	const dir = resolveDir(machine.cwd, params.path);
	// Like Pi's find: a glob with a slash matches at any depth.
	let glob = params.pattern;
	if (glob.includes("/") && !glob.startsWith("/") && !glob.startsWith("**/") && glob !== "**") glob = `**/${glob}`;
	const basename = glob.split("/").pop() || glob;
	const script = [
		"set +e",
		"if command -v rg >/dev/null 2>&1; then",
		`  rg --files --hidden -g '!**/.git/**' -g '!**/node_modules/**' -g ${shellQuote(glob)} 2>/dev/null | head -n ${max}`,
		"  rc=${PIPESTATUS[0]}",
		'  case "$rc" in 0|1|141) exit 0 ;; esac',
		"else",
		`  find . -type f -name ${shellQuote(basename)} ! -path '*/.git/*' ! -path '*/node_modules/*' 2>/dev/null | head -n ${max}`,
		"  rc=${PIPESTATUS[0]}",
		'  case "$rc" in 0|141) exit 0 ;; esac',
		"fi",
		'exit "$rc"',
	].join("\n");
	const res = await runCommand(machine, script, { cwd: dir });
	if (res.exitCode !== 0) throw new Error(`find failed in ${dir} (exit ${res.exitCode}): ${res.stderr.trim()}`);
	const lines = res.stdout
		.split("\n")
		.map((l) => l.replace(/^\.\//, ""))
		.filter((l) => l.length > 0);
	return text(lines.length > 0 ? lines.join("\n") : "No files found matching pattern");
}

/** Search file contents inside the machine; `path:line: text` lines like Pi's grep. */
export async function runRemoteGrep(machine: ActiveMachine, params: GrepParams): Promise<SearchResult> {
	const max = positiveInt(params.limit, 100);
	const ctxLines = positiveInt(params.context, 0);
	const target = params.path ?? ".";
	const rg = ["rg", "--line-number", "--no-heading", "--color=never", "--hidden", "-g", "'!**/.git/**'"];
	const gp = ["grep", "-rnI", "--exclude-dir=.git", "--exclude-dir=node_modules"];
	if (params.ignoreCase) {
		rg.push("--ignore-case");
		gp.push("-i");
	}
	if (params.literal) {
		rg.push("--fixed-strings");
		gp.push("-F");
	}
	if (ctxLines > 0) {
		rg.push("--context", String(ctxLines));
		gp.push("-C", String(ctxLines));
	}
	if (params.glob) {
		rg.push("--glob", shellQuote(params.glob));
		gp.push(`--include=${shellQuote(params.glob.split("/").pop() || params.glob)}`);
	}
	rg.push("--", shellQuote(params.pattern), shellQuote(target));
	gp.push("--", shellQuote(params.pattern), shellQuote(target));
	const script = [
		"set +e",
		"if command -v rg >/dev/null 2>&1; then",
		`  ${rg.join(" ")} 2>/dev/null | head -n ${max}`,
		"else",
		`  ${gp.join(" ")} 2>/dev/null | head -n ${max}`,
		"fi",
		"rc=${PIPESTATUS[0]}",
		// 1 is "no match" and 141 is the search stopped by head: both fine.
		'case "$rc" in 0|1|141) exit 0 ;; esac',
		'exit "$rc"',
	].join("\n");
	const res = await runCommand(machine, script, { cwd: machine.cwd });
	if (res.exitCode !== 0) throw new Error(`grep failed in ${target} (exit ${res.exitCode}): ${res.stderr.trim()}`);
	const out = res.stdout.replace(/^\.\//gm, "").replace(/\s+$/, "");
	return text(out.length > 0 ? out : `No matches found for /${params.pattern}/ in ${target}`);
}

function text(body: string): SearchResult {
	const cut = truncateHead(body, { maxBytes: DEFAULT_MAX_BYTES });
	const suffix = cut.truncated ? `\n\n[Output truncated: ${cut.outputLines} of ${cut.totalLines} lines]` : "";
	return { content: [{ type: "text", text: cut.content + suffix }], details: undefined };
}

function resolveDir(cwd: string, path: string | undefined): string {
	if (!path || path === ".") return cwd;
	return path.startsWith("/") ? path : joinPath(cwd, path);
}

/** A model-supplied count as a whole number, or the default when it is missing or not finite. */
function positiveInt(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(fallback === 0 ? 0 : 1, Math.floor(value));
}
