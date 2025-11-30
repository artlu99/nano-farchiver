import { Database } from "bun:sqlite";
import { pluralize } from "../lib/helpers";

const db = new Database("db/queue.db3", { strict: true });

export const writeLoop = async () => {
	const fids = db.query("SELECT fid FROM fids").all() as { fid: number }[];
	console.log(pluralize(fids.length, "fid"));
	for (const fid of fids) {
		// console.log(fid.fid);
	}
	const casts = db.query("SELECT hash, fid FROM casts").all() as {
		hash: string;
		fid: number;
	}[];
	console.log(pluralize(casts.length, "cast"));
	for (const cast of casts) {
		// console.log(cast.hash, cast.fid);
	}
};
