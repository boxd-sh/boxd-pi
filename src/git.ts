/**
 * Git inside the machine. The clone and push run in the machine; the host only supplies the repo URL
 * and, for github.com, a token from `gh auth token`. The token goes with that one command through git's
 * GIT_CONFIG_* variables and is not written to the machine's git config.
 *
 * The machine does get the token for that command: it is in the command's environment. The clone runs
 * before the agent has touched the machine. A push runs after, in a repo the agent controls, so
 * {@link pushBranch} skips git hooks and sends the token only when origin is still the URL that was
 * cloned. That narrows what can read the token; it does not make the machine unable to.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ActiveMachine, runCommand } from "./machine.ts";
import { isGithubHttps, sameRepoUrl, shellQuote } from "./util.ts";

/** Git with hooks off, for the commands that carry a token. */
const GIT_NO_HOOKS = "git -c core.hooksPath=/dev/null";

/** The origin URL and branch of the git checkout Pi was started in, if it is one. */
export async function detectLocalRepo(pi: ExtensionAPI, cwd: string): Promise<{ url: string; branch?: string } | undefined> {
	try {
		const remote = await pi.exec("git", ["-C", cwd, "remote", "get-url", "origin"]);
		const url = remote.code === 0 ? remote.stdout.trim() : "";
		if (!url) return undefined;
		const head = await pi.exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
		const branch = head.code === 0 ? head.stdout.trim() : "";
		return { url, branch: branch && branch !== "HEAD" ? branch : undefined };
	} catch {
		return undefined;
	}
}

/** A GitHub token from the host's `gh` login, or undefined. */
export async function githubToken(pi: ExtensionAPI): Promise<string | undefined> {
	try {
		const res = await pi.exec("gh", ["auth", "token"]);
		const token = res.code === 0 ? res.stdout.trim() : "";
		return token || undefined;
	} catch {
		return undefined;
	}
}

/** Environment that makes git send `token` to github.com for one command. Empty for other hosts. */
export function githubAuthEnv(url: string, token: string | undefined): Record<string, string> {
	if (!token || !isGithubHttps(url)) return {};
	const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}

/** Set a git identity in the machine so the agent's commits work. */
export async function configureIdentity(machine: ActiveMachine): Promise<void> {
	await runCommand(
		machine,
		'git config --global user.name >/dev/null || git config --global user.name "pi-agent"; ' +
			'git config --global user.email >/dev/null || git config --global user.email "pi-agent@users.noreply.github.com"',
	);
}

/** Clone `url` (optionally one branch) into `dir` in the machine. */
export async function cloneRepo(
	machine: ActiveMachine,
	url: string,
	dir: string,
	branch: string | undefined,
	token: string | undefined,
): Promise<void> {
	const branchArg = branch ? `--branch ${shellQuote(branch)} ` : "";
	const res = await runCommand(machine, `${GIT_NO_HOOKS} clone ${branchArg}-- ${shellQuote(url)} ${shellQuote(dir)}`, {
		env: githubAuthEnv(url, token),
		timeoutMs: 10 * 60_000,
	});
	if (res.exitCode !== 0) throw new Error(`git clone failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
}

/** Make an empty git repo at `dir`, with one empty commit so HEAD is valid. */
export async function initWorkspace(machine: ActiveMachine, dir: string): Promise<void> {
	const q = shellQuote(dir);
	const res = await runCommand(
		machine,
		`mkdir -p ${q} && cd ${q} && (test -d .git || (git init -q -b main && git commit -q --allow-empty -m "pi: init"))`,
	);
	if (res.exitCode !== 0) throw new Error(`could not create ${dir}: ${res.stderr.trim()}`);
}

/**
 * Push the machine's HEAD to `branch` on origin. Returns git's output.
 *
 * The push runs in the machine, so the machine has `token` while it runs. To keep that to the repo you
 * started with: hooks are off, the push goes to the URL that was read (not to whatever `origin` means a
 * moment later), and a token is sent only when origin is still `machine.repoUrl`, the URL the extension
 * cloned. If origin was changed the push is refused; a workspace that was not cloned pushes without a token.
 */
export async function pushBranch(machine: ActiveMachine, branch: string, token: string | undefined): Promise<string> {
	const origin = await runCommand(machine, "git remote get-url --push origin", { cwd: machine.cwd });
	const url = origin.stdout.trim();
	if (origin.exitCode !== 0 || !url) throw new Error("This workspace has no origin remote to push to.");
	if (machine.repoUrl && !sameRepoUrl(url, machine.repoUrl)) {
		throw new Error(
			`origin in the machine is ${url}, not ${machine.repoUrl} that this session cloned. ` +
				"Nothing was pushed and your GitHub token was not sent.",
		);
	}
	const target = machine.repoUrl ?? url;
	const res = await runCommand(machine, `${GIT_NO_HOOKS} push -- ${shellQuote(target)} ${shellQuote(`HEAD:refs/heads/${branch}`)} 2>&1`, {
		cwd: machine.cwd,
		env: machine.repoUrl ? githubAuthEnv(machine.repoUrl, token) : {},
		timeoutMs: 5 * 60_000,
	});
	if (res.exitCode !== 0) throw new Error(`git push failed: ${res.stdout.trim() || `exit ${res.exitCode}`}`);
	return res.stdout.trim();
}
