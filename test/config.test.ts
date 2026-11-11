import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { machineSettings, parseSize, resolveCredentials } from "../src/config.ts";
import { githubAuthEnv } from "../src/git.ts";
import { isGithubHttps, machineName, normalizeRepoUrl, piSessionEnv, repoName, shellQuote } from "../src/util.ts";
import { FakePi, fakeCtx } from "./fake.ts";

describe("config", () => {
	it("parses the four boxd sizes and refuses anything else", () => {
		assert.deepEqual(parseSize("4x16"), { vcpu: 4, memory: "16G" });
		assert.equal(parseSize(undefined), undefined);
		assert.throws(() => parseSize("3x12"), /Unknown machine size "3x12"/);
	});

	it("reads org and region from flags first, then the environment", () => {
		const pi = new FakePi();
		pi.flags.set("boxd-region", "fra");
		const s = machineSettings(pi as never, { BOXD_ORG: "acme", BOXD_REGION: "nyc" });
		assert.equal(s.org, "acme");
		assert.equal(s.region, "fra");
		assert.equal(s.namePrefix, "pi-");
		assert.equal(machineSettings(pi as never, { BOXD_PI_NAME_PREFIX: "t-pi-" }).namePrefix, "t-pi-");
	});

	it("takes BOXD_API_KEY, then BOXD_TOKEN, and gives up without a UI", async () => {
		const ctx = fakeCtx(new FakePi()) as never;
		assert.deepEqual(await resolveCredentials(ctx, { BOXD_API_KEY: " k ", BOXD_TOKEN: "t" }), { apiKey: "k" });
		assert.deepEqual(await resolveCredentials(ctx, { BOXD_TOKEN: "t" }), { token: "t" });
		assert.equal(await resolveCredentials(ctx, {}), undefined);
	});
});

describe("git helpers", () => {
	it("sends a GitHub token to github.com over HTTPS only", () => {
		const env = githubAuthEnv("https://github.com/acme/api.git", "tok");
		assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
		assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
		assert.deepEqual(githubAuthEnv("https://gitlab.com/acme/api.git", "tok"), {});
		assert.deepEqual(githubAuthEnv("https://github.com.evil.example/acme/api.git", "tok"), {});
		assert.deepEqual(githubAuthEnv("https://github.com/acme/api.git", undefined), {});
	});

	it("turns GitHub SSH remotes into HTTPS (the machine has no SSH keys)", () => {
		assert.equal(normalizeRepoUrl("git@github.com:acme/api.git"), "https://github.com/acme/api.git");
		assert.equal(normalizeRepoUrl("github.com/acme/api"), "https://github.com/acme/api");
		assert.equal(repoName("https://github.com/acme/api.git"), "api");
		assert.equal(isGithubHttps("http://github.com/a/b"), false);
	});
});

describe("util", () => {
	it("quotes shell arguments", () => {
		assert.equal(shellQuote("a'b"), `'a'\\''b'`);
	});
	it("makes machine names DNS-safe and at most 63 characters", () => {
		const n = machineName("pi-", "019A2B3C-AAAA-BBBB-CCCC-DDDDDDDDDDDD-extra-long-suffix-for-test");
		assert.ok(n.length <= 63);
		assert.match(n, /^[a-z0-9-]+$/);
		assert.ok(!n.endsWith("-"));
	});
	it("keeps only PI_* variables", () => {
		assert.deepEqual(piSessionEnv({ PI_MODEL: "x", PATH: "/bin", pi_lower: "y" }), { PI_MODEL: "x" });
	});
});
