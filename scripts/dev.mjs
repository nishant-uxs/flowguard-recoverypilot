import { spawn } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const commands = ['dev:api', 'dev:web'];
const children = commands.map((command) =>
  spawn(npm, ['run', command], {
    stdio: 'inherit',
  }),
);

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGINT');
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
