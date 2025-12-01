import { queueLoop } from "./jobs/read";
import { writeLoop } from "./jobs/write";
import { pluralize } from "./lib/helpers";
import { getReplies } from "./lib/neynar";

const FID = 6546;

const doIt = async (fid: number) => {
	// TODO: process top-level casts
	const res = await getReplies(fid);
	console.log(pluralize(res.casts.length, "cast"));
	console.log(res.next?.cursor ?? "no cursor");

	queueLoop(res.casts);
	writeLoop();
};

doIt(FID);
