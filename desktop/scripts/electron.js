#!/usr/bin/env node
/**
 * Runs Electron with the given arguments: `node scripts/electron.js . --debug`.
 *
 * The same as `npx electron`, except that it clears ELECTRON_RUN_AS_NODE.
 * VS Code sets that for everything its extensions start (tasks, AI agents,
 * test runners), and Electron then behaves as plain Node: `import { app }
 * from 'electron'` fails and no window ever opens.
 */
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env, windowsHide: false });
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
