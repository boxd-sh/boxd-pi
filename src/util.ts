/** Small helpers shared across the extension. */

/** Quote a string as one shell argument. Single quotes stop `$`, backticks and globs from expanding. */
export function shellQuote(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Join a base dir and a child segment with a single slash. */
export function joinPath(base: string, child: string): string {
	return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

/** Short form of a machine or session id for status lines. */
export function shortId(id: string): string {
	return id.slice(0, 8);
}

/** The message of an unknown thrown value. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Normalize a repo argument into a clonable URL. Accepts `github.com/a/b`, full URLs and `git@host:a/b`. */
export function normalizeRepoUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) throw new Error("Repository URL is empty.");
	const scp = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
	// An isolated machine has no SSH keys, so GitHub SSH remotes are cloned over HTTPS.
	if (scp) return `https://github.com/${scp[1]}/${scp[2]}.git`;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith("git@")) return trimmed;
	return `https://${trimmed}`;
}

/** Directory name for a repo URL: `github.com/acme/api.git` -> `api`. */
export function repoName(url: string): string {
	const cleaned = url
		.replace(/^git@[^:]+:/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	const parts = cleaned.split("/");
	return parts[parts.length - 1] || "repo";
}

/** True when the URL points at github.com over HTTPS (the only host a gh token is sent to). */
export function isGithubHttps(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "github.com";
	} catch {
		return false;
	}
}

/** True when two repo URLs name the same repo: equal apart from a trailing slash or `.git`. */
export function sameRepoUrl(a: string, b: string): boolean {
	const bare = (url: string) =>
		url
			.trim()
			.replace(/\/+$/, "")
			.replace(/\.git$/, "");
	return bare(a) === bare(b);
}

/** Keep only Pi's session variables (PI_*) from the host environment; nothing else leaves the host. */
export function piSessionEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!env) return out;
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("PI_") && /^[A-Z0-9_]+$/.test(key) && value !== undefined) out[key] = value;
	}
	return out;
}

/** Machine name for a Pi session: `<prefix><session id>`, cut to a DNS label. */
export function machineName(prefix: string, sessionId: string): string {
	return `${prefix}${sessionId}`
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, 63)
		.replace(/-+$/, "");
}
