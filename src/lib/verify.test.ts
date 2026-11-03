import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSignedSnapMessage } from "../test/purgeFixtures";

const backupDir = mkdtempSync(join(tmpdir(), "farchiver-backups-"));
process.env.BACKUPS_DIR = backupDir;

// Build the fixture BEFORE mocking, so the registered-key mock can match it.
const fixture = await buildSignedSnapMessage({
	text: "gate fixture",
	ageDays: 30,
});

mock.module("./snapchain", () => ({
	snapOnChainSigners: async () => [
		{
			type: "EVENT_TYPE_SIGNER",
			blockNumber: 1,
			signerEventBody: {
				key: fixture.signerHex,
				keyType: 1,
				eventType: "SIGNER_EVENT_TYPE_ADD",
			},
		},
	],
	traverse: async () => [],
	getCastsByParent: async () => [],
	snapCastsByFid: async () => [],
	snapReactionsByFid: async () => [],
	snapCastById: async () => null,
	snapHasReaction: async () => false,
	snapSubmitMessage: async () => {},
}));

const { gateFromDisk } = await import("./verify");
const { backupMessage, readManifest } = await import("./backup");

const binPath = (hash: string): string =>
	join(backupDir, `${hash.replace(/^0x/, "")}.bin`);
const jsonPath = (hash: string): string =>
	join(backupDir, `${hash.replace(/^0x/, "")}.json`);

describe("gateFromDisk", () => {
	beforeEach(() => {
		// fresh copies of the fixture backup per test
		rmSync(backupDir, { recursive: true, force: true });
		process.env.BACKUPS_DIR = backupDir;
	});

	test("passes a genuine signed fixture end-to-end", async () => {
		backupMessage(fixture.snap);
		const gate = await gateFromDisk(fixture.hashHex);
		expect(gate.ok).toBe(true);
		if (gate.ok) {
			expect(gate.level).toBe("hash+sig+signer");
			expect(gate.checks.files_exist).toBe(true);
			expect(gate.checks.json_reencodes_to_bin).toBe(true);
			expect(gate.checks.ed25519_signature).toBe(true);
			expect(gate.checks.fid_network_type).toBe(true);
			expect(gate.checks.sha256_matches_manifest).toBe(true);
			expect(gate.checks.signer_registered).toBe(true);
		}
	});

	test("fails closed when a backup byte flips (corruption)", async () => {
		backupMessage(fixture.snap);
		const bytes = readFileSync(binPath(fixture.hashHex));
		bytes[3] = (bytes[3] ?? 0) ^ 0xff;
		writeFileSync(binPath(fixture.hashHex), bytes);
		const gate = await gateFromDisk(fixture.hashHex);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.error).toContain("re-encoded MessageData");
	});

	test("fails closed on a corrupted signature", async () => {
		backupMessage(fixture.snap);
		const json = JSON.parse(readFileSync(jsonPath(fixture.hashHex), "utf-8"));
		json.signature = Buffer.from("corrupted signature bytes").toString(
			"base64",
		);
		writeFileSync(jsonPath(fixture.hashHex), JSON.stringify(json));
		const gate = await gateFromDisk(fixture.hashHex);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.error).toContain("ed25519");
	});

	test("fails closed when the backup is missing", async () => {
		const gate = await gateFromDisk(fixture.hashHex);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.error).toContain("no .bin/.json");
	});

	test("fails closed on manifest sha256 mismatch (bit-rot)", async () => {
		backupMessage(fixture.snap);
		backupMessage(fixture.snap);
		const manifestFile = join(backupDir, "manifest.jsonl");
		const lines = readFileSync(manifestFile, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const entry = JSON.parse(line);
				if (entry.hash === fixture.hashHex) entry.data_sha256 = "0".repeat(64);
				return JSON.stringify(entry);
			});
		writeFileSync(manifestFile, `${lines.join("\n")}\n`);
		const gate = await gateFromDisk(fixture.hashHex);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.error).toContain("sha256");
	});

	test("manifest records the fixture and verified flags are writable", async () => {
		backupMessage(fixture.snap);
		const entries = readManifest().filter((e) => e.hash === fixture.hashHex);
		expect(entries.length).toBe(1);
		expect(existsSync(binPath(fixture.hashHex))).toBe(true);
	});
});
