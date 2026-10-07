import { LEADER_COMMAND } from "@xdev-hive/core";

/** A standalone stdio MCP: Electron's bundled main cannot be imported by a child Node process. */
export function leaderRepoScript(o: { roots: string[]; cwd: string; commands: string[]; repos?: string[] }): string {
  const prefixes = o.commands.filter((c) => LEADER_COMMAND.test(c)).flatMap((c) => {
    const words = c.split(" ");
    return o.repos && words[0] === "git" ? o.repos.map((repo) => ["git", "-C", repo, ...words.slice(1)]) : [words];
  });
  return String.raw`
import { realpathSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
const roots = ${JSON.stringify(o.roots)}.map(p => realpathSync(p));
const cwd = ${JSON.stringify(o.cwd)};
const prefixes = ${JSON.stringify(prefixes)};
function filePath(value) {
  if (typeof value !== 'string') throw new Error('path must be a string');
  const p = realpathSync(path.resolve(cwd, value));
  if (!roots.some(r => p === r || p.startsWith(r + path.sep))) throw new Error('Path is outside this chat');
  return p;
}
const tools = [
  { name: 'read_file', description: 'Read a text file or image in this chat repository or attachments. Paths may be absolute.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'list_directory', description: 'List entries in a directory of this chat.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  ...(prefixes.length ? [{ name: 'command', description: 'Run one permitted command as an argv array, without a shell. Permitted prefixes: ' + JSON.stringify(prefixes), inputSchema: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } }, required: ['argv'], additionalProperties: false } }] : [])
];
function call(name, args) {
  if (name === 'read_file') {
    const p = filePath(args.path);
    if (!statSync(p).isFile() || statSync(p).size > 5 * 1024 * 1024) throw new Error('Expected a file up to 5 MB');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(p).toLowerCase()];
    return { content: [mime ? { type: 'image', mimeType: mime, data: readFileSync(p).toString('base64') } : { type: 'text', text: readFileSync(p, 'utf8').slice(0, 40000) }] };
  }
  if (name === 'list_directory') return { content: [{ type: 'text', text: readdirSync(filePath(args.path)).slice(0, 1000).join('\n') }] };
  if (name !== 'command' || !Array.isArray(args.argv) || args.argv.length > 100 || !args.argv.every(a => typeof a === 'string' && !a.includes('\0'))) throw new Error('Invalid command');
  const argv = args.argv;
  const prefix = prefixes.find(p => p.every((v, i) => argv[i] === v));
  if (!prefix) throw new Error('Command is not permitted');
  // Git read commands can otherwise write output or invoke an external diff supplied by repo config.
  const extra = argv.slice(prefix.length);
  const unsafeGitOption = a => {
    if (/^-[Cc]/.test(a)) return true;
    const option = a.startsWith('--') && a !== '--' ? a.slice(2).split('=')[0] : '';
    // Git accepts unique abbreviations too: --out= must not bypass --output's ban.
    return option && ['output', 'git-dir', 'work-tree', 'exec-path', 'ext-diff', 'textconv', 'no-index'].some(name => name.startsWith(option));
  };
  if (argv[0] === 'git' && extra.some(unsafeGitOption)) throw new Error('Git option is not permitted');
  const subcommand = prefix[1] === '-C' ? prefix[3] : prefix[1];
  const safe = argv[0] === 'git' && ['diff', 'show', 'log'].includes(subcommand) ? [...argv.slice(1, prefix.length), '--no-ext-diff', '--no-textconv', ...extra] : argv.slice(1);
  const env = { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  try { return { content: [{ type: 'text', text: execFileSync(argv[0], safe, { cwd, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }).slice(-40000) }] }; }
  catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.stderr || e.message).slice(-40000) }] }; }
}
for await (const line of createInterface({ input: process.stdin })) {
  let req;
  try {
    req = JSON.parse(line);
    if (req.id === undefined) continue;
    let result;
    if (req.method === 'initialize') result = { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'leader-repo', version: '1' } };
    else if (req.method === 'tools/list') result = { tools };
    else if (req.method === 'tools/call') {
      try { result = call(req.params.name, req.params.arguments || {}); }
      catch (e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
    }
    else if (req.method === 'ping') result = {};
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
  } catch { if (req?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'Invalid request' } }) + '\n'); }
}
`;
}
