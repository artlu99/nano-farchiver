import { AwsClient } from "aws4fetch";
import {
	type ArchiveStore,
	type ListOptions,
	type ListPage,
	PreconditionFailedError,
	type PutOptions,
	type PutResult,
	type StoredObject,
	textToBytes,
} from "./types";

export interface S3StoreConfig {
	/** e.g. R2: https://<account>.r2.cloudflarestorage.com */
	endpoint: string;
	bucket: string;
	region?: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export const s3ConfigFromEnv = (): S3StoreConfig => {
	const endpoint = process.env.S3_ENDPOINT;
	const bucket = process.env.S3_BUCKET;
	const accessKeyId = process.env.S3_ACCESS_KEY_ID;
	const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
		throw new Error(
			"missing S3 config: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY " +
				"(R2: endpoint https://<account>.r2.cloudflarestorage.com, S3_REGION=auto, token scoped to the bucket)",
		);
	}
	return {
		endpoint,
		bucket,
		region: process.env.S3_REGION ?? "auto",
		accessKeyId,
		secretAccessKey,
	};
};

const stripEtagQuotes = (etag: string | undefined): string | undefined =>
	etag?.replace(/^"(.*)"$/, "$1");

const xmlDecode = (value: string): string =>
	value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");

const safeText = async (res: Response): Promise<string> => {
	try {
		return (await res.text()).slice(0, 300);
	} catch {
		return "";
	}
};

const RETRY_ATTEMPTS = 3;

/** S3 REST via aws4fetch (sigv4). Runtime-agnostic: Bun + Workers + Node >= 18. */
export class S3Store implements ArchiveStore {
	private readonly client: AwsClient;
	private readonly base: string;

	constructor(config: S3StoreConfig) {
		this.client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			service: "s3",
			region: config.region ?? "auto",
		});
		this.base = `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}`;
	}

	private url(key: string): string {
		const encoded = key.split("/").map(encodeURIComponent).join("/");
		return `${this.base}/${encoded}`;
	}

	/** Retries network errors, 5xx and 429; passes 4xx through to callers. */
	private async requestUrl(url: string, init: RequestInit): Promise<Response> {
		let lastError: unknown;
		for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
			try {
				const res = await this.client.fetch(url, init);
				if (res.status >= 500 || res.status === 429) {
					lastError = new Error(
						`S3 ${init.method ?? "GET"}: HTTP ${res.status}`,
					);
				} else {
					return res;
				}
			} catch (error) {
				lastError = error;
			}
			if (attempt < RETRY_ATTEMPTS - 1) {
				await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private async request(key: string, init: RequestInit): Promise<Response> {
		return this.requestUrl(this.url(key), init);
	}

	async get(key: string): Promise<StoredObject | null> {
		const res = await this.request(key, { method: "GET" });
		if (res.status === 404) return null;
		if (!res.ok) {
			throw new Error(
				`S3 GET ${key}: HTTP ${res.status} ${await safeText(res)}`,
			);
		}
		return {
			body: new Uint8Array(await res.arrayBuffer()),
			etag: stripEtagQuotes(res.headers.get("etag") ?? undefined),
		};
	}

	async put(
		key: string,
		data: Uint8Array | string,
		options?: PutOptions,
	): Promise<PutResult> {
		const headers: Record<string, string> = {};
		if (options?.ifMatch) headers["if-match"] = options.ifMatch;
		if (options?.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
		const res = await this.request(key, {
			method: "PUT",
			headers,
			body: (typeof data === "string" ? textToBytes(data) : data) as BodyInit,
		});
		if (res.status === 412) throw new PreconditionFailedError(key);
		if (!res.ok) {
			throw new Error(
				`S3 PUT ${key}: HTTP ${res.status} ${await safeText(res)}`,
			);
		}
		return { etag: stripEtagQuotes(res.headers.get("etag") ?? undefined) };
	}

	async deleteKey(key: string): Promise<void> {
		const res = await this.request(key, { method: "DELETE" });
		if (!res.ok && res.status !== 404) {
			throw new Error(`S3 DELETE ${key}: HTTP ${res.status}`);
		}
	}

	async list(prefix: string, options?: ListOptions): Promise<ListPage> {
		const url = new URL(`${this.base}/`);
		url.searchParams.set("list-type", "2");
		url.searchParams.set("prefix", prefix);
		if (options?.delimiter)
			url.searchParams.set("delimiter", options.delimiter);
		if (options?.maxKeys) {
			url.searchParams.set("max-keys", String(options.maxKeys));
		}
		if (options?.token) {
			url.searchParams.set("continuation-token", options.token);
		}
		const res = await this.requestUrl(url.toString(), { method: "GET" });
		if (!res.ok) {
			throw new Error(`S3 LIST ${prefix}: HTTP ${res.status}`);
		}
		const text = await res.text();
		const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
			xmlDecode(match[1] ?? ""),
		);
		const prefixes: string[] = [];
		for (const block of text.matchAll(
			/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g,
		)) {
			const match = /<Prefix>([\s\S]*?)<\/Prefix>/.exec(block[1] ?? "");
			if (match) prefixes.push(xmlDecode(match[1] ?? ""));
		}
		const truncated =
			/<IsTruncated>([\s\S]*?)<\/IsTruncated>/.exec(text)?.[1] === "true";
		const nextToken =
			/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(
				text,
			)?.[1];
		return { keys, prefixes, truncated, nextToken };
	}
}
