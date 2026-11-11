/** Public HTTPS URLs for ports inside the machine, through boxd named proxies. */

import { ConflictError } from "@boxd-sh/sdk";
import { type ActiveMachine, withRecovery } from "./machine.ts";

/** The proxy name used for a port: `p<port>`. */
export function proxyName(port: number): string {
	return `p${port}`;
}

/** Return the route's public URL (`https://p<port>.<machine>.<zone>`), creating the route on first use. */
export async function previewUrl(machine: ActiveMachine, port: number): Promise<string> {
	const name = proxyName(port);
	const list = () => withRecovery(machine, () => machine.client.proxies.list(machine.id));
	let route = (await list()).find((p) => p.name === name);
	if (!route) {
		try {
			await withRecovery(machine, () => machine.client.proxies.create(machine.id, name, port));
		} catch (err) {
			// Two calls racing for the same port: the other one created it.
			if (!(err instanceof ConflictError)) throw err;
		}
		route = (await list()).find((p) => p.name === name);
	}
	if (!route) throw new Error(`Could not create a preview route for port ${port}.`);
	// A route's `domain` is its full host name.
	return `https://${route.domain}`;
}
