import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb } from "../lib/db";
import { hash2filename } from "../lib/helpers";
import { makeCast, makeReply } from "../test/fixtures";
import { clearUserCache, tagCasts } from "./read";
import { castsLoop, fidsLoop } from "./write";

let outRoot: string;

beforeEach(() => {
	initDb(":memory:");
	clearUserCache();
	outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "farchiver-out-"));
});

const outDir = () => path.join(outRoot, "out");

const seededArchive = () => {
	const parent = makeCast();
	const reply = makeReply(parent);
	tagCasts([parent, reply]);
	return { parent, reply };
};

describe("fidsLoop", () => {
	test("writes user files with profile and cast hash list", async () => {
		const { parent } = seededArchive();
		await fidsLoop(outDir());
		const userPath = path.join(outDir(), "_users_", "artlu.md");
		expect(fs.existsSync(userPath)).toBe(true);
		const content = fs.readFileSync(userPath, "utf8");
		expect(content).toContain("username: artlu");
		expect(content).toContain("fid: 3319217");
		expect(content).toContain(parent.hash.replace(/^0x/, ""));
	});

	test("skips existing user files", async () => {
		seededArchive();
		await fidsLoop(outDir());
		const userPath = path.join(outDir(), "_users_", "artlu.md");
		const before = fs.statSync(userPath).mtimeMs;
		await fidsLoop(outDir());
		expect(fs.statSync(userPath).mtimeMs).toBe(before);
	});
});

describe("castsLoop", () => {
	test("writes markdown for top-level casts and replies", async () => {
		const { parent, reply } = seededArchive();
		await castsLoop(outDir());

		const parentPath = path.join(
			outDir(),
			"artlu",
			hash2filename(parent.hash, parent.timestamp),
		);
		const parentContent = fs.readFileSync(parentPath, "utf8");
		expect(parentContent).toContain("hello");
		expect(parentContent).toContain(parent.hash.replace(/^0x/, ""));
		expect(parentContent).toContain("1 Reply");

		const replyPath = path.join(
			outDir(),
			"artlu",
			hash2filename(reply.hash, reply.timestamp),
		);
		const replyContent = fs.readFileSync(replyPath, "utf8");
		expect(replyContent).toContain("hello");
		expect(replyContent).toContain(
			`parent_hash: ${reply.parent_hash?.replace(/^0x/, "")}`,
		);
		expect(replyContent).toContain(
			`../artlu/${hash2filename(parent.hash, parent.timestamp)}`,
		);
	});

	test("second run skips unchanged casts", async () => {
		const { parent } = seededArchive();
		await castsLoop(outDir());
		const castPath = path.join(
			outDir(),
			"artlu",
			hash2filename(parent.hash, parent.timestamp),
		);
		const before = fs.statSync(castPath).mtimeMs;
		await castsLoop(outDir());
		expect(fs.statSync(castPath).mtimeMs).toBe(before);
	});

	test("writes every cast exactly once", async () => {
		const { parent, reply } = seededArchive();
		await castsLoop(outDir());
		const userDir = path.join(outDir(), "artlu");
		const files = fs.readdirSync(userDir).filter((f) => f.endsWith(".md"));
		expect(files).toHaveLength(2);
		expect(files).toContain(hash2filename(parent.hash, parent.timestamp));
		expect(files).toContain(hash2filename(reply.hash, reply.timestamp));
	});
});
