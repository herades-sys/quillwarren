// The browser editor's shared password, as the hash the server reads from
// DELVE_EDIT_PASSWORD_HASH (until the first admin account exists; see
// docs/API.md, "Getting started"). Only the scrypt hash is printed.
//   npm run password-hash                 asks twice, without showing what you type
//   echo 'my password' | npm run -s password-hash   for scripts (first line of stdin)
import { createInterface } from 'node:readline';
import { hashPassword } from '../auth.ts';

/** One line from a terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let typed = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(typed);
          return;
        }
        if (ch === '\u0003') process.exit(130); // Ctrl C
        if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function firstLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) return line;
  return '';
}

let password: string;
if (process.stdin.isTTY) {
  password = await askHidden('Editor password: ');
  if ((await askHidden('Again: ')) !== password) {
    process.stderr.write('The two passwords differ. Nothing was printed.\n');
    process.exit(1);
  }
} else password = await firstLine();

if (password.length < 12) {
  process.stderr.write('Use at least 12 characters. Nothing was printed.\n');
  process.exit(1);
}
process.stdout.write(`DELVE_EDIT_PASSWORD_HASH=${hashPassword(password)}\n`);
