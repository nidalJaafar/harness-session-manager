import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export function ensureBun() {
  if (process.versions.bun) return;
  if (process.env.HSM_BUN_REEXEC === '1') throw new Error('OpenTUI needs Bun. Install Bun or run `mise install`.');
  const cwd = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const env = {...process.env, HSM_BUN_REEXEC: '1'};
  let result = spawnSync('bun', process.argv.slice(1), {cwd, env, stdio: 'inherit'});
  if (result.error?.code === 'ENOENT') result = spawnSync('mise', ['exec', '--', 'bun', ...process.argv.slice(1)], {cwd, env, stdio: 'inherit'});
  if (result.error) throw new Error('OpenTUI needs Bun. Install it or run `mise install`.');
  process.exit(result.status ?? 1);
}
