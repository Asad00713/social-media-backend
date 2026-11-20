#!/usr/bin/env node
/**
 * Set one variable in a .env file, in place, without printing its value.
 *
 * Why a script rather than editing by hand: a rotated database URL has to land
 * in exactly one line, with the rest of the file untouched, and a stray edit to
 * a 100-line .env is both easy and invisible. This rewrites one key, backs the
 * file up first, and never echoes the value to the terminal or to any log.
 *
 * Usage (the value is READ FROM A PROMPT, never from argv, so it does not land
 * in your shell history):
 *
 *   node scripts/set-env-var.mjs DATABASE_URL
 *
 * Then paste the value and press Enter.
 *
 *   node scripts/set-env-var.mjs DATABASE_URL --file .env.production
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const key = argv.find((a) => !a.startsWith('-'));
const fileIdx = argv.indexOf('--file');
const file = fileIdx >= 0 ? argv[fileIdx + 1] : '.env';

if (!key || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
  console.error('Usage: node scripts/set-env-var.mjs <KEY> [--file .env]');
  console.error('Example: node scripts/set-env-var.mjs DATABASE_URL');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question(`Paste the new value for ${key} (input is not echoed back): `, (answer) => {
  rl.close();
  const value = answer.trim();
  if (!value) {
    console.error('Empty value — nothing changed.');
    process.exit(1);
  }

  // A postgres URL whose password contains @ : / # ? breaks the URL itself,
  // and the error it produces points at the HOST, not the password — so check
  // here rather than let it surface as a confusing connection failure.
  if (/^postgres(ql)?:\/\//.test(value)) {
    try {
      const u = new URL(value);
      if (!u.hostname) throw new Error('no host');
      // `new URL` ACCEPTS postgresql://user:pa@ss@host/db — it just splits on
      // the LAST @, so the password silently truncates and the host becomes
      // whatever followed the first one. Tested: 'pa@ss' parsed "fine" with
      // host 'host'. Count the separators instead of trusting the parse.
      const afterScheme = value.slice(value.indexOf('://') + 3);
      const authority = afterScheme.split('/')[0];
      if ((authority.match(/@/g) || []).length > 1) {
        throw new Error('more than one @ before the host');
      }
      console.log(`Parsed OK — host ${u.hostname}:${u.port || '5432'}${u.pathname}`);
    } catch {
      console.error(
        'That does not parse as a URL. If the password contains @ : / # or ?,\n' +
        'it has to be percent-encoded, or regenerated without them.',
      );
      process.exit(1);
    }
  }

  const original = readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);

  let found = 0;
  const next = lines.map((line) => {
    // Only a real assignment, not a comment and not KEY_SOMETHING_ELSE.
    if (new RegExp(`^\s*${key}\s*=`).test(line)) {
      found += 1;
      return `${key}=${value}`;
    }
    return line;
  });

  if (found === 0) {
    next.push(`${key}=${value}`);
  } else if (found > 1) {
    console.error(
      `${key} appears ${found} times in ${file}. Refusing to guess which one wins — fix it by hand.`,
    );
    process.exit(1);
  }

  const backup = `${file}.bak`;
  copyFileSync(file, backup);
  writeFileSync(file, next.join(eol), 'utf8');

  console.log(
    found === 0
      ? `Added ${key} to ${file} (backup: ${backup})`
      : `Updated ${key} in ${file} (backup: ${backup})`,
  );
  console.log('The value was not printed and is not in your shell history.');
});
