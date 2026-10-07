import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const app = process.argv[2] && resolve(process.argv[2]);
const executable = app
  ? (process.platform === 'darwin' ? join(app, 'Contents/MacOS/xDev Hive') : join(app, 'xdev-hive'))
  : require('electron');
const modulePath = app
  ? join(app, process.platform === 'darwin' ? 'Contents/Resources' : 'resources', 'app.asar/out/main/pty-supervisor.js')
  : resolve(import.meta.dirname, '../out/main/pty-supervisor.js');
const result = spawnSync(executable, [join(import.meta.dirname, 'pty-smoke.mjs'), modulePath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 90_000,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
