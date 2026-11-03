import type { Env } from "./env";
import { FACILITATOR_URL } from "./x402";

/**
 * Worker→Worker: fetching the facilitator's *.workers.dev URL from inside a
 * Worker is blocked by Cloudflare (error 1042), so requests to it are routed
 * through the FACILITATOR service binding instead. Installed once per
 * isolate; every other fetch passes through untouched.
 */
let installed = false;

export const installFacilitatorFetch = (env: Env): void => {
	if (installed) return;
	installed = true;
	const original = globalThis.fetch.bind(globalThis);
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url.startsWith(FACILITATOR_URL)) {
			const request =
				input instanceof Request && init === undefined
					? input
					: new Request(url, input instanceof Request ? input : init);
			return env.FACILITATOR.fetch(request);
		}
		return original(input as RequestInfo, init);
	}) as typeof fetch;
};
