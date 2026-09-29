/**
 * Runs the API and the worker together in one service (Render's free plan gives one instance).
 * If either stops, the other is stopped too and the process exits, so the platform restarts both.
 */
import { spawn } from "node:child_process";

const services = [
  ["api", ["--filter", "@bursar/api", "start"]],
  ["worker", ["--filter", "@bursar/worker", "start"]],
];

// Reuse the pnpm that started this script (e.g. `corepack pnpm start:production`), so both
// services run on the version pinned in package.json rather than whatever the host has.
const pnpm = process.env.npm_execpath;

const children = services.map(([name, args]) => {
  const child = pnpm
    ? spawn(process.execPath, [pnpm, ...args], { stdio: "inherit" })
    : spawn("pnpm", args, { stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code, signal) => {
    console.error(`${name} exited (${signal ?? code}); stopping`);
    for (const other of children) if (other !== child) other.kill("SIGTERM");
    process.exit(code ?? 1);
  });
  return child;
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}
