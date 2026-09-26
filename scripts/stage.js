#!/usr/bin/env node
/**
 * Copies the served files (scripts/lib/served.js) into a directory, as they
 * are, and nothing else. Both deployments start from this:
 *
 *   node scripts/stage.js _site          # GitHub Pages; the deploy then stamps sw.js
 *   node scripts/stage.js desktop/web    # the desktop app; desktop/scripts/build.js runs it
 *
 * The target is emptied first, so a file deleted from the repository does not
 * linger in the next build.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVED } from './lib/served.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function stage(target) {
  const out = resolve(target);
  // The target is deleted first, so it must not be (or contain) the repository,
  // nor sit inside one of the directories being copied.
  const up = relative(out, ROOT);
  const inside = relative(ROOT, out);
  if (!up.startsWith('..') || SERVED.includes(inside.split(/[\\/]/)[0])) {
    throw new Error(`stage: refusing to stage into ${out}, which would overwrite the site itself`);
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const entry of SERVED) {
    await cp(join(ROOT, entry), join(out, entry), { recursive: true });
  }
  return SERVED.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/stage.js <directory>');
    process.exit(1);
  }
  try {
    const count = await stage(target);
    console.log(`stage: ${count} entries -> ${resolve(target)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
