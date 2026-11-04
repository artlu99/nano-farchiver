import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { cluster } from "radash";
import { defaultRunContext, type RunContext } from "../ctx";
import { mapWithConcurrency } from "../lib/concurrency";
import { normalizeHash, type User } from "../lib/helpers";
import { getCasts, getConversation } from "../lib/neynar";
import { getUserFromShim } from "../lib/shim";
import { traverse } from "../lib/snapchain";
import { renderCast } from "./write";

const VERBOSE = false;

export const isCastDeleted = (
	hash: string,
	ctx: RunContext = defaultRunContext(),
): Promise<boolean> => ctx.data.isDeleted(hash);

export const markCastsDeleted = (
	hashes: string[],
	reason: string,
	deletedAt: number = Date.now(),
	ctx: RunContext = defaultRunContext(),
): Promise<number> => {
	if (hashes.length === 0) return Promise.resolve(0);
	return ctx.data
		.markDeleted(hashes, reason, deletedAt)
		.then(() => hashes.length);
};

export const filterNonDeletedCastHashes = (
	hashes: string[],
	ctx: RunContext = defaultRunContext(),
): Promise<string[]> => ctx.data.filterNotDeleted(hashes);

export const hasCastInDb = (
	hash: string,
	ctx: RunContext = defaultRunContext(),
): Promise<boolean> => ctx.data.hasCast(hash);

export const clearUserCache = (ctx: RunContext = defaultRunContext()): void => {
	ctx.userCache.clear();
};

export const getUserFromFid = async (
	fid: number,
	ctx: RunContext = defaultRunContext(),
): Promise<User> => {
	const cached = ctx.userCache.get(fid);
	if (cached) return cached;
	const user = await ctx.data.getUser(fid);
	if (!user) {
		try {
			const shimUser = await getUserFromShim(fid);
			return shimUser;
		} catch (e) {
			throw new Error(
				`User with fid ${fid} not found in database: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	ctx.userCache.set(fid, user);
	return user;
};

export const getCastFromHash = async (
	hash: string,
	fid: number | undefined,
	ctx: RunContext = defaultRunContext(),
): Promise<Cast | undefined> => {
	const with0x = normalizeHash(hash);
	if (await ctx.data.isDeleted(with0x)) {
		return undefined;
	}
	const data = await ctx.data.getCastData(with0x, fid);
	if (data === undefined) {
		console.error(`Cast with hash ${hash} [${fid}] not found in database`);
		ctx.missingCastHashes.add(with0x);
		return undefined;
	}
	return JSON.parse(data) as Cast;
};

export const hydrateMissingCasts = async (
	ctx: RunContext = defaultRunContext(),
): Promise<number> => {
	const hashes = Array.from(ctx.missingCastHashes);
	if (hashes.length === 0) return 0;

	ctx.missingCastHashes.clear();
	await Promise.all(cluster(hashes, 25).map((chunk) => getCasts(chunk, ctx)));
	for (const hash of hashes) {
		if (!(await hasCastInDb(hash, ctx))) {
			ctx.missingCastHashes.add(hash);
		}
	}
	return hashes.length;
};

export const getMissingCastCount = (
	ctx: RunContext = defaultRunContext(),
): number => ctx.missingCastHashes.size;

export const drainMissingCasts = async (
	maxRounds: number = 5,
	ctx: RunContext = defaultRunContext(),
): Promise<number> => {
	let total = 0;
	for (let i = 0; i < maxRounds; i++) {
		const hydrated = await hydrateMissingCasts(ctx);
		total += hydrated;
		if (hydrated === 0) break;
	}
	return total;
};

export const missingParentHashes = (
	ctx: RunContext = defaultRunContext(),
): Promise<string[]> => ctx.data.missingParentHashes();

export const hydrateReferencedParents = async (
	maxRounds: number = 5,
	ctx: RunContext = defaultRunContext(),
): Promise<number> => {
	let total = 0;
	for (let i = 0; i < maxRounds; i++) {
		const missingParents = await missingParentHashes(ctx);

		if (missingParents.length === 0) break;

		total += missingParents.length;
		await Promise.all(
			cluster(missingParents, 25).map((chunk) => getCasts(chunk, ctx)),
		);
	}
	return total;
};

export const missingQuotedHashes = (
	ctx: RunContext = defaultRunContext(),
): Promise<string[]> => ctx.data.missingQuotedHashes();

export const hydrateQuotedCastEmbeds = async (
	maxRounds: number = 5,
	ctx: RunContext = defaultRunContext(),
): Promise<number> => {
	let total = 0;
	for (let i = 0; i < maxRounds; i++) {
		const missing = await missingQuotedHashes(ctx);
		if (missing.length === 0) break;
		total += missing.length;
		await Promise.all(
			cluster(missing, 25).map((chunk) => getCasts(chunk, ctx)),
		);
	}
	return total;
};

export const countReplies = (
	fid: number,
	hash: string,
	ctx: RunContext = defaultRunContext(),
): Promise<number> => ctx.data.countReplies(fid, hash);

export const processQueuedCast = async (
	c: Cast,
	fullConversationsMode: boolean,
	ctx: RunContext,
) => {
	await tagCast(c, ctx);

	if (!fullConversationsMode) return;

	const phases: Promise<void>[] = [];

	if (c.thread_hash) {
		phases.push(tagThreadConversation(c.thread_hash, ctx));
	}

	phases.push(tagReplies(c.hash, ctx));

	if (c.parent_author?.fid && c.parent_hash) {
		phases.push(hydrateFullThread(c.parent_author.fid, c.parent_hash, ctx));
	} else {
		console.error("No parent author or hash found for cast", c.hash);
	}

	const results = await Promise.allSettled(phases);
	const firstRejected = results.find((r) => r.status === "rejected");
	if (firstRejected) {
		throw (firstRejected as PromiseRejectedResult).reason;
	}
	if (VERBOSE) console.log(await renderCast(c));
};

const tagThreadConversation = async (threadHash: string, ctx: RunContext) => {
	const conversation = await getConversation(threadHash);
	if (VERBOSE) {
		console.log(
			(conversation.conversation.chronological_parent_casts ?? []).length,
		);
		console.log(conversation.conversation.cast.direct_replies.length);
		console.log(conversation.next?.cursor ?? "no cursor");
	}
	await tagCasts(
		[
			conversation.conversation.cast,
			...(conversation.conversation.chronological_parent_casts ?? []),
			...conversation.conversation.cast.direct_replies,
		],
		ctx,
	);
};

const tagReplies = async (hash: string, ctx: RunContext) => {
	const replies = await getConversation(hash);
	await tagCasts(
		[
			replies.conversation.cast,
			...(replies.conversation.chronological_parent_casts ?? []),
			...replies.conversation.cast.direct_replies,
		],
		ctx,
	);
};

const hydrateFullThread = async (
	fid: number,
	hash: string,
	ctx: RunContext = defaultRunContext(),
) => {
	const fullThread = await traverse(fid, hash);
	await Promise.all(
		cluster(fullThread, 25).map((chunk) =>
			getCasts(
				chunk.map((item) => item.hash),
				ctx,
			),
		),
	);
};

export const tagCast = (
	cast: Cast,
	ctx: RunContext = defaultRunContext(),
): Promise<void> => tagCasts([cast], ctx);

export const tagCasts = async (
	casts: Cast[],
	ctx: RunContext = defaultRunContext(),
): Promise<void> => {
	if (casts.length === 0) return;
	// A cast being tagged is, by definition, no longer missing.
	for (const cast of casts) {
		ctx.missingCastHashes.delete(normalizeHash(cast.hash));
	}
	await ctx.data.tagCasts(casts);
};

export const queueLoop = async (
	casts: Cast[],
	fullConversationsMode: boolean = true,
	concurrency: number = 3,
	ctx: RunContext = defaultRunContext(),
) => {
	await mapWithConcurrency(casts, concurrency, (c) =>
		processQueuedCast(c, fullConversationsMode, ctx),
	);
};
