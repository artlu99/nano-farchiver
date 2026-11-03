import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPAdapter, HTTPRequestContext } from "@x402/core/server";
import {
	HTTPFacilitatorClient,
	x402HTTPResourceServer,
	x402ResourceServer,
} from "@x402/core/server";
import {
	FacilitatorResponseError,
	SettleError,
	VerifyError,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { PaywallConfig } from "@x402/hono";
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import { createPaywall, evmPaywall } from "@x402/paywall";
import type { Context, Next } from "hono";
import { getAddress } from "viem";
import type { Env } from "./env";

const X402_FACILITATOR_URL = "https://cf-x402-facilitator.artlu.workers.dev";
const PAY_TO_ADDRESS = "0xAa591218305E621D8A128309e655A91e49A87a92";
const PRICE = "$0.01";
const NETWORK = "eip155:8453"; // Base mainnet
const DEFAULT_MAX_TIMEOUT_SECONDS = 900;

interface Gate {
	username: string;
	allowlist: Set<string>; // lowercased addresses
	/** Run the x402 middleware: 402/paywall on failure, onPaid() on success. */
	gate: (
		c: Context<{ Bindings: Env }>,
		onPaid: () => Response,
	) => Promise<Response | undefined>;
	/** Verify a payment signature header and return the payer address. */
	verifyPayer: (c: Context<{ Bindings: Env }>) => Promise<string | undefined>;
}

let gateSingleton: Gate | undefined;

const decodeJsonSafe = (value: unknown): string => {
	try {
		return JSON.stringify(
			value,
			(_k, v) => (typeof v === "bigint" ? v.toString() : v),
			2,
		);
	} catch {
		return String(value);
	}
};

/**
 * The x402 paywall stack, ported from server.ts and built lazily on first
 * use. DISABLED unless X402_API_KEY is configured — ungated mode serves full
 * content (dev/staging; the paywall is prod-only config).
 */
export const getGate = (env: Env): Gate | undefined => {
	if (gateSingleton) return gateSingleton;
	if (!env.X402_API_KEY) return undefined;

	const username = env.X402_USERNAME ?? "decent-artlu";
	const apiKey = env.X402_API_KEY;
	const maxTimeoutSeconds =
		Number(env.X402_MAX_TIMEOUT_SECONDS ?? DEFAULT_MAX_TIMEOUT_SECONDS) ||
		DEFAULT_MAX_TIMEOUT_SECONDS;
	const allowlist = new Set(
		(env.X402_ALLOWLIST ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);

	const facilitatorClient = new HTTPFacilitatorClient({
		url: X402_FACILITATOR_URL,
		createAuthHeaders: async () => {
			const auth = { Authorization: `Bearer ${apiKey}` };
			return {
				supported: { ...auth },
				verify: { ...auth },
				settle: { ...auth },
			};
		},
	});

	const x402Server = new x402ResourceServer(facilitatorClient)
		.register(NETWORK, new ExactEvmScheme())
		.onVerifyFailure(async (ctx) => {
			console.error(
				"[x402] verify failed:",
				ctx.error instanceof Error ? ctx.error.message : ctx.error,
			);
		})
		.onSettleFailure(async (ctx) => {
			const err = ctx.error;
			console.error("[x402] settle failure", {
				name:
					err instanceof SettleError ||
					err instanceof FacilitatorResponseError ||
					err instanceof VerifyError
						? err.name
						: String(err),
			});
		});

	const x402HttpServer = new x402HTTPResourceServer(x402Server, {
		[`GET /browse/${username}/*`]: {
			accepts: {
				scheme: "exact",
				price: PRICE,
				network: NETWORK,
				payTo: PAY_TO_ADDRESS,
				maxTimeoutSeconds,
			},
			description: "Read archived cast",
		},
	});

	const paywallConfig: PaywallConfig = {
		appName: "nano-farchiver",
		testnet: false,
	};
	const paywallProvider = createPaywall().withNetwork(evmPaywall).build();
	const x402Gate = paymentMiddlewareFromHTTPServer(
		x402HttpServer,
		paywallConfig,
		paywallProvider,
	);

	const verifyPayer = async (
		c: Context<{ Bindings: Env }>,
	): Promise<string | undefined> => {
		const paymentSignature =
			c.req.header("payment-signature") ??
			c.req.header("x-payment") ??
			c.req.header("x-payment-signature");
		if (!paymentSignature) return undefined;

		let paymentPayload: ReturnType<typeof decodePaymentSignatureHeader>;
		try {
			paymentPayload = decodePaymentSignatureHeader(paymentSignature);
		} catch {
			console.warn("[x402] allowlist path: signature decode failed");
			return undefined;
		}

		const adapter: HTTPAdapter = {
			getHeader: (name) => c.req.header(name),
			getMethod: () => c.req.method,
			getPath: () => c.req.path,
			getUrl: () => c.req.url,
			getAcceptHeader: () => c.req.header("accept") ?? "",
			getUserAgent: () => c.req.header("user-agent") ?? "",
			getQueryParams: () =>
				Object.fromEntries(new URL(c.req.url).searchParams.entries()),
			getQueryParam: (name) =>
				new URL(c.req.url).searchParams.get(name) ?? undefined,
			getBody: async () => undefined,
		};
		const context: HTTPRequestContext = {
			adapter,
			path: c.req.path,
			method: c.req.method,
		};

		try {
			const requirements = await x402Server.buildPaymentRequirementsFromOptions(
				[
					{
						scheme: "exact",
						price: PRICE,
						network: NETWORK,
						payTo: PAY_TO_ADDRESS,
						maxTimeoutSeconds,
					},
				],
				context,
			);
			const matching = x402Server.findMatchingRequirements(
				requirements,
				paymentPayload,
			);
			if (!matching) return undefined;
			const verification = await x402Server.verifyPayment(
				paymentPayload,
				matching,
			);
			if (!verification.isValid || !verification.payer) return undefined;
			return getAddress(verification.payer as `0x${string}`);
		} catch (error) {
			console.error("[x402] allowlist verify error:", error);
			return undefined;
		}
	};

	gateSingleton = {
		username,
		allowlist,
		gate: async (c, onPaid) => {
			let served: Response | undefined;
			const gateResult = await x402Gate(c, async () => {
				served = onPaid();
			});
			if (gateResult instanceof Response) return gateResult;
			return served;
		},
		verifyPayer,
	};
	return gateSingleton;
};
