import { ed25519, fromFarcasterTime, MessageData } from "@farcaster/core";
import { defaultRunContext, type RunContext } from "../ctx";
import {
	manifestSha256,
	readBackupFiles,
	readCheckpoint,
	readManifest,
	sha256Hex,
} from "./backup";
import { normalizeHash, strip0x } from "./helpers";
import { snapOnChainSigners } from "./snapchain";

export type VerifyLevel = "hash+sig" | "hash+sig+signer";

export interface GateChecks {
	files_exist: boolean;
	json_reencodes_to_bin: boolean;
	ed25519_signature: boolean;
	fid_network_type: boolean;
	sha256_matches_manifest: boolean;
	signer_registered: boolean | null; // null = couldn't check (degraded)
	text_matches_local_archive: boolean | null; // null = no local row to compare
}

export interface GateResult {
	ok: boolean;
	hash: string;
	level: VerifyLevel;
	checks: GateChecks;
	age_days: number | null;
	error?: string;
}

const failed = (
	hash: string,
	checks: GateChecks,
	error: string,
	level: VerifyLevel = "hash+sig",
): GateResult => ({ ok: false, hash, level, checks, error, age_days: null });

const emptyChecks = (): GateChecks => ({
	files_exist: false,
	json_reencodes_to_bin: false,
	ed25519_signature: false,
	fid_network_type: false,
	sha256_matches_manifest: false,
	signer_registered: null,
	text_matches_local_archive: null,
});

/** Latest on-chain signer event for `keyHex` is ADD? null = gateway unavailable (degraded). */
export const signerRegistered = async (
	fid: number,
	keyHex: string,
): Promise<boolean | null> => {
	try {
		const events = await snapOnChainSigners(fid);
		const key = keyHex.toLowerCase();
		let latest: string | undefined;
		for (const event of events) {
			if (event.signerEventBody?.key?.toLowerCase() === key) {
				latest = event.signerEventBody.eventType;
			}
		}
		if (latest === undefined) return false;
		return latest === "SIGNER_EVENT_TYPE_ADD";
	} catch {
		return null;
	}
};

// The gateway's HTTP API is JSON-only and snapchain's canonical serialization
// (Rust/prost) is not byte-identical to protobufjs re-encoding, so the hash
// cannot be re-derived from data locally. The gate therefore proves:
//   - stored JSON and stored bytes agree (deterministic re-encode + sha256 manifest)
//   - the original artifact is authentic: Ed25519(signature, envelope hash, signer)
//     with the signer registered to the fid (KeyRegistry)
// The data↔hash binding is inherited from the HTTPS gateway response and
// cross-checked against the independent local archive copy (different upstream).
// Upgrade path: fetch raw `data_bytes` via snapchain gRPC and hash those.
export const gateFromDisk = async (
	hash: string,
	ctx: RunContext = defaultRunContext(),
): Promise<GateResult> => {
	const normalized = normalizeHash(hash);
	const checks = emptyChecks();

	try {
		const backup = readBackupFiles(normalized);
		if (!backup) {
			return failed(normalized, checks, "no .bin/.json backup on disk");
		}
		checks.files_exist = true;
		const { bin, json } = backup;

		// 1. stored JSON and stored bytes agree (deterministic protobufjs encoding)
		const reencoded = MessageData.encode(
			MessageData.fromJSON(json.data as unknown as Record<string, unknown>),
		).finish();
		checks.json_reencodes_to_bin =
			reencoded.length === bin.length &&
			Buffer.from(reencoded).equals(Buffer.from(bin));
		if (!checks.json_reencodes_to_bin) {
			return failed(normalized, checks, "re-encoded MessageData != .bin bytes");
		}

		// 2. authenticity: Ed25519(signature, envelope hash, signer)
		const hashBytes = new Uint8Array(Buffer.from(strip0x(normalized), "hex"));
		const signature = new Uint8Array(
			Buffer.from(json.signature ?? "", "base64"),
		);
		const signerBytes = new Uint8Array(
			Buffer.from(strip0x(json.signer ?? ""), "hex"),
		);
		const sigResult = await ed25519.verifyMessageHashSignature(
			signature,
			hashBytes,
			signerBytes,
		);
		checks.ed25519_signature = sigResult.isOk() && sigResult.value === true;
		if (!checks.ed25519_signature) {
			const sigErr = sigResult.isErr() ? sigResult.error : undefined;
			return failed(
				normalized,
				checks,
				`ed25519 signature invalid${sigErr ? `: ${sigErr.message}` : ""}`,
			);
		}

		// 3. sanity: our fid, mainnet, CAST_ADD
		checks.fid_network_type =
			json.data?.type === "MESSAGE_TYPE_CAST_ADD" &&
			json.data?.network === "FARCASTER_NETWORK_MAINNET";
		if (!checks.fid_network_type) {
			return failed(
				normalized,
				checks,
				`unexpected message type/network: ${json.data?.type} ${json.data?.network}`,
			);
		}

		// 4. corpus integrity: sha256(bin) matches the manifest's recorded value
		const diskSha = sha256Hex(bin);
		const entry = readManifest()
			.filter((e) => e.hash === normalized)
			.at(-1);
		checks.sha256_matches_manifest = !!entry && entry.data_sha256 === diskSha;
		if (!checks.sha256_matches_manifest) {
			return failed(normalized, checks, "sha256(.bin) != manifest data_sha256");
		}

		// 5. provenance: signer key registered to the fid (KeyRegistry)
		const registered = await signerRegistered(json.data.fid, json.signer ?? "");
		checks.signer_registered = registered;
		let level: VerifyLevel = "hash+sig";
		if (registered === true) {
			level = "hash+sig+signer";
		} else if (registered === false) {
			return failed(
				normalized,
				checks,
				"signer key not registered to fid (latest KeyRegistry event is not ADD)",
			);
		}
		// registered === null → gateway unavailable: degraded to hash+sig, pass loudly

		// 6. second source: text agrees with the local archive copy (informational)
		const data = await ctx.data.getCastData(normalized);
		if (data !== undefined) {
			try {
				const localText = (JSON.parse(data) as { text?: string }).text;
				checks.text_matches_local_archive =
					localText === (json.data?.castAddBody?.text ?? "");
			} catch {
				checks.text_matches_local_archive = null;
			}
		}

		const tsResult = fromFarcasterTime(json.data.timestamp);
		const ageDays = tsResult.isOk()
			? (Date.now() - tsResult.value) / 86_400_000
			: null;

		return {
			ok: true,
			hash: normalized,
			level,
			checks,
			age_days: ageDays,
		};
	} catch (error) {
		return failed(
			normalized,
			checks,
			`gate error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

/** A live delete may proceed only if the checkpoint reflects the current manifest. */
export const checkpointMatchesManifest = (): {
	ok: boolean;
	reason?: string;
} => {
	const entry = readManifest();
	const diskSha = manifestSha256();
	const checkpoint = readCheckpoint();
	if (!checkpoint) {
		return {
			ok: false,
			reason:
				"no CHECKPOINT.json — run `bun run backup:checkpoint` after syncing backups/ offsite",
		};
	}
	if (checkpoint.manifest_sha256 !== diskSha) {
		return {
			ok: false,
			reason: `CHECKPOINT.json manifest_sha256 (${checkpoint.manifest_sha256.slice(0, 12)}…) != current manifest (${diskSha.slice(0, 12)}…) — backups changed since last offsite sync; run \`bun run backup:checkpoint\``,
		};
	}
	if (checkpoint.count !== entry.length) {
		return { ok: false, reason: "checkpoint count != manifest length" };
	}
	return { ok: true };
};
