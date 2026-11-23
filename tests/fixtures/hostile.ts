// G5.4: what a compromised daemon would try. Run inside the jail; prints what happened to each attempt.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const [approvedFile, secretFile, approvedDir, brainPort, otherPort, realBus] = process.argv.slice(2) as string[];
const result: Record<string, string> = {};
const attempt = (name: string, fn: () => unknown) => {
  try { fn(); result[name] = "ok"; } catch (error) { result[name] = `refused: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`; }
};
const tcp = (port: number) => new Promise<string>((resolve) => {
  const socket = connect({ host: "127.0.0.1", port }, () => { socket.destroy(); resolve("ok"); });
  socket.on("error", (error: NodeJS.ErrnoException) => resolve(`refused: ${error.code}`));
});
const unix = (path: string) => new Promise<string>((resolve) => {
  const socket = connect({ path }, () => { socket.destroy(); resolve("ok"); });
  socket.on("error", (error: NodeJS.ErrnoException) => resolve(`refused: ${error.code}`));
});

attempt("read approved file", () => readFileSync(approvedFile));
attempt("read a file outside the folders", () => readFileSync(secretFile));
attempt("write into a read-only approved folder", () => writeFileSync(`${approvedDir}/planted.txt`, "x"));
attempt("read a file in the home directory", () => readFileSync(`${homedir()}/.bashrc`));
// Bun lives under ~/.bun/bin, so the jail has an otherwise empty home holding just that.
result["what the home directory shows"] = readdirSync(homedir()).join(",");
attempt("write outside /tmp", () => writeFileSync("/usr/planted", "x"));
attempt("create a namespace", () => {
  const run = spawnSync("unshare", ["--user", "true"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr.includes("Operation not permitted") ? "EPERM" : `status ${run.status}`);
});
result["connect to the Brain's port"] = await tcp(Number(brainPort));
result["connect to any other TCP port"] = await tcp(Number(otherPort));
result["connect to the real session bus"] = await unix(realBus!);
result["listen on a TCP port"] = await new Promise<string>((resolve) => {
  const server = createServer();
  server.on("error", (error: NodeJS.ErrnoException) => resolve(`refused: ${error.code}`));
  server.listen(0, "127.0.0.1", () => { server.close(); resolve("ok"); });
});
console.log(JSON.stringify(result));
