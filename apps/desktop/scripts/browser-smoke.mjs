// Run against the catalog rather than a hand-written MCP config, so this exercises the pinned seed.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OPEN_POLICY, toolEnv, toolArgv } from '@xdev-hive/core';
import { SqliteHive } from '@xdev-hive/core/node';
import { runTools, readyBrowserSecrets } from '#desktop/main/runner/tools.ts';

const destination = path.resolve(process.argv[2] ?? '.xdev-hive/artifacts');
const runDir = mkdtempSync(path.join(os.tmpdir(), 'hive-browser-smoke-'));
const hive = new SqliteHive(':memory:');
const admin = { role: 'admin', name: 'browser-smoke' };
const form = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<label>Test password<input type="password"></label>'); });
await new Promise(resolve => form.listen(0, '127.0.0.1', resolve));
const client = new Client({ name: 'hive-browser-smoke', version: '1.0.0' });
try {
  await hive.call('tools.setProject', { project: 'demo', id: 'browser', enabled: true, required: false }, admin);
  const entries = await hive.call('tools.list', {}, admin);
  const pick = runTools({ entries, projects: { demo: [{ id: 'browser', enabled: true, effective: true, required: false }] } }, 'demo', { codegraph: false, superpowers: false }, 'codex', OPEN_POLICY, {}, process.env);
  const browser = pick.tools.find(e => e.id === 'browser');
  assert.ok(browser, 'enabled catalog seed is selected');
  const testPassword = 'synthetic-only-quoted\"password';
  readyBrowserSecrets({ ...browser, secretEnv: ['TEST_PASSWORD'] }, runDir, { TEST_PASSWORD: testPassword });
  const [command, ...args] = toolArgv([browser.mcp.command, ...browser.mcp.args], browser);
  await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...(process.env.HIVE_BROWSER_SMOKE_NO_SANDBOX === '1' ? { PLAYWRIGHT_MCP_SANDBOX: 'false' } : {}), HOME: runDir, XDG_CONFIG_HOME: runDir, npm_config_cache: process.env.npm_config_cache ?? '/tmp/hive-npm', ...toolEnv(browser, runDir) }, stderr: 'inherit' }));
  const navigate = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
  assert.ok(!navigate.isError, JSON.stringify(navigate));
  assert.match(JSON.stringify(navigate), /Example Domain/);
  const shot = await client.callTool({ name: 'browser_take_screenshot', arguments: { type: 'png' } });
  assert.ok(!shot.isError, JSON.stringify(shot));
  const local = await client.callTool({ name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${form.address().port}` } });
  assert.ok(!local.isError, JSON.stringify(local));
  const output = path.join(runDir, '.xdev-hive/artifacts/browser');
  const snapshotFile = readdirSync(output).filter(name => name.endsWith('.yml')).sort().at(-1);
  const snapshot = readFileSync(path.join(output, snapshotFile), 'utf8');
  const ref = /textbox "Test password" \[ref=([a-z0-9]+)\]/.exec(snapshot)?.[1];
  assert.ok(ref, snapshot);
  const fill = await client.callTool({ name: 'browser_type', arguments: { target: ref, text: 'TEST_PASSWORD' } });
  assert.ok(!fill.isError, JSON.stringify(fill));
  assert.ok(!JSON.stringify(fill).includes(testPassword), 'MCP response masks secret');
  const length = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => document.querySelector("input").value.length' } });
  assert.match(JSON.stringify(length), new RegExp(String(testPassword.length)));
  await client.callTool({ name: 'browser_close', arguments: {} });
  const screenshots = readdirSync(output).filter(name => name.endsWith('.png'));
  assert.ok(screenshots.length, 'MCP saved its screenshot under runDir');
  mkdirSync(destination, { recursive: true });
  copyFileSync(path.join(output, screenshots[0]), path.join(destination, 'browser-example.png'));
  console.log('PASS: enabled pinned browser MCP opened https://example.com headlessly and saved browser-example.png; secret-name form fill passed');
} finally {
  await client.close();
  await new Promise(resolve => form.close(resolve));
  hive.close();
  rmSync(runDir, { recursive: true, force: true });
}
