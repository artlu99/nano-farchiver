import { queueLoop } from "./jobs/process";
import { writeLoop } from "./jobs/write";
import { pluralize } from "./lib/helpers";
import { getReplies} from "./lib/neynar";

const doIt = async () => {
	const res = await getReplies(6546);
	console.log(pluralize(res.casts.length, "cast"));
	console.log(res.next?.cursor ?? "no cursor");
	
	queueLoop(res.casts);
	writeLoop();
};

doIt();
