import { spawn } from "node:child_process";

const children = [];

function launch(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`${name} exited with signal ${signal}`);
    } else if (code && code !== 0) {
      console.log(`${name} exited with code ${code}`);
    }
    shutdown(code ?? 0);
  });

  children.push(child);
}

let stopping = false;

function shutdown(code) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

launch("api", "npm", ["run", "dev:server"]);
launch("web", "npm", ["run", "dev:web"]);
