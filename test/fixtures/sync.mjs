import { statSync } from "node:fs";

let last = 0;
setInterval(() => {
  const mtime = statSync("out.log").mtimeMs;
  if (mtime !== last) console.log("changed");
  last = mtime;
}, 2000);
