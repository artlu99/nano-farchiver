import { randomBytes } from "node:crypto";
import {
	CastType,
	FarcasterNetwork,
	getFarcasterTime,
	MessageData,
	makeCastAdd,
	NobleEd25519Signer,
} from "@farcaster/core";
import type { SnapMessage } from "../lib/snapchain";

export const FARCASTER_EPOCH_S = 1609459200;

export interface SignedFixture {
	hashHex: string;
	signerHex: string;
	snap: SnapMessage;
}

/**
 * A genuinely signed CastAdd message built through the production path
 * (makeCastAdd + NobleEd25519Signer), converted into the gateway's JSON shape
 * — the exact shape backup/gate consume.
 */
export const buildSignedSnapMessage = async (
	overrides: { ageDays?: number; text?: string; fid?: number } = {},
): Promise<SignedFixture> => {
	const ageDays = overrides.ageDays ?? 30;
	const timestamp = getFarcasterTime()._unsafeUnwrap() - ageDays * 86_400;
	const signer = new NobleEd25519Signer(randomBytes(32));
	const result = await makeCastAdd(
		{
			text: overrides.text ?? "fixture cast",
			embeds: [],
			embedsDeprecated: [],
			mentions: [],
			mentionsPositions: [],
			type: CastType.CAST,
		},
		{
			fid: overrides.fid ?? 3319217,
			network: FarcasterNetwork.MAINNET,
			timestamp,
		},
		signer,
	);
	const message = result._unsafeUnwrap();
	const snap: SnapMessage = {
		data: MessageData.toJSON(message.data) as SnapMessage["data"],
		hash: `0x${Buffer.from(message.hash).toString("hex")}`,
		hashScheme: "HASH_SCHEME_BLAKE3",
		signature: Buffer.from(message.signature).toString("base64"),
		signatureScheme: "SIGNATURE_SCHEME_ED25519",
		signer: `0x${Buffer.from(message.signer).toString("hex")}`,
	};
	return { hashHex: snap.hash, signerHex: snap.signer, snap };
};

export const makeReactionMessage = (
	targetHash: string,
	fid = 3319217,
): SnapMessage => ({
	data: {
		type: "MESSAGE_TYPE_REACTION_ADD",
		fid,
		timestamp: 1000,
		network: "FARCASTER_NETWORK_MAINNET",
		reactionBody: {
			type: "REACTION_TYPE_LIKE",
			targetCastId: { fid: 3319217, hash: targetHash },
		},
	},
	hash: `0x${"f".repeat(40)}`,
	hashScheme: "HASH_SCHEME_BLAKE3",
	signature: Buffer.from([1]).toString("base64"),
	signatureScheme: "SIGNATURE_SCHEME_ED25519",
	signer: `0x${"e".repeat(64)}`,
});
