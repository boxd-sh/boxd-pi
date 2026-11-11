/** Settings for the extension: credentials, org, region, size, and the flags that carry them. */

import { Boxd } from "@boxd-sh/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MachineClient } from "./machine.ts";

/** Flags the extension registers. All but `boxd` are prefixed so they can't clash with other extensions. */
export const FLAGS = {
	boxd: { description: "Run Pi's tools inside a boxd machine", type: "boolean" },
	"boxd-repo": { description: "Git repo to clone into the machine (default: the repo you are in)", type: "string" },
	"boxd-branch": { description: "Branch to clone (default: your current branch)", type: "string" },
	"boxd-no-repo": { description: "Start in an empty ~/workspace instead of cloning a repo", type: "boolean" },
	"boxd-snapshot": { description: "Create the machine from this boxd snapshot", type: "string" },
	"boxd-size": { description: "Machine size: 1x4, 2x8, 4x16 or 8x32 (vCPU x GiB)", type: "string" },
	"boxd-region": { description: "Region to create the machine in, e.g. fra or nyc", type: "string" },
	"boxd-org": { description: "boxd org to create the machine in (default: BOXD_ORG, or the key's org)", type: "string" },
} as const;

/** Machine sizes boxd offers, as `<vcpu>x<GiB>`. */
const SIZES: Record<string, { vcpu: number; memory: string }> = {
	"1x4": { vcpu: 1, memory: "4G" },
	"2x8": { vcpu: 2, memory: "8G" },
	"4x16": { vcpu: 4, memory: "16G" },
	"8x32": { vcpu: 8, memory: "32G" },
};

/** What a new machine is created with. */
export interface MachineSettings {
	org?: string;
	region?: string;
	size?: { vcpu: number; memory: string };
	snapshot?: string;
	namePrefix: string;
}

/** Register every flag with Pi. */
export function registerFlags(pi: ExtensionAPI): void {
	for (const [name, options] of Object.entries(FLAGS)) pi.registerFlag(name, { ...options });
}

/** A string flag's value, or undefined when unset or empty. */
export function stringFlag(pi: ExtensionAPI, name: keyof typeof FLAGS): string | undefined {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Parse `--boxd-size`. Throws on a size boxd does not offer, so a typo never falls back silently. */
export function parseSize(value: string | undefined): { vcpu: number; memory: string } | undefined {
	if (value === undefined) return undefined;
	const size = SIZES[value.toLowerCase()];
	if (!size) throw new Error(`Unknown machine size "${value}". Use one of ${Object.keys(SIZES).join(", ")}.`);
	return size;
}

/** Read the flags and environment into machine settings. */
export function machineSettings(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): MachineSettings {
	return {
		org: stringFlag(pi, "boxd-org") ?? (env.BOXD_ORG?.trim() || undefined),
		region: stringFlag(pi, "boxd-region") ?? (env.BOXD_REGION?.trim() || undefined),
		size: parseSize(stringFlag(pi, "boxd-size")),
		snapshot: stringFlag(pi, "boxd-snapshot"),
		namePrefix: env.BOXD_PI_NAME_PREFIX?.trim() || "pi-",
	};
}

/**
 * Credentials, in order: `BOXD_API_KEY`, `BOXD_TOKEN`, then a one-time prompt when Pi has a UI.
 * A prompted key is kept in memory for this run only.
 */
export async function resolveCredentials(
	ctx: ExtensionContext,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ apiKey?: string; token?: string } | undefined> {
	const apiKey = env.BOXD_API_KEY?.trim();
	if (apiKey) return { apiKey };
	const token = env.BOXD_TOKEN?.trim();
	if (token) return { token };
	if (!ctx.hasUI) return undefined;
	const entered = await ctx.ui.input("boxd API key", "BOXD_API_KEY: create one at app.boxd.sh or with `boxd auth keys create pi`");
	return entered?.trim() ? { apiKey: entered.trim() } : undefined;
}

/** A boxd machines client for these credentials. */
export function createClient(creds: { apiKey?: string; token?: string }, region: string | undefined): MachineClient {
	return new Boxd({ ...creds, region }).machines;
}
