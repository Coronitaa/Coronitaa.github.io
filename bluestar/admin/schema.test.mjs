// Run with: node bluestar/admin/schema.test.mjs   (no dependencies)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCatalog, isSafeRelativePath } from './schema.js';

const live = JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'));
assert.deepEqual(validateCatalog(live).errors, [], 'the committed catalog must be valid');

const withPreset = (p) => ({ schemaVersion: 1, games: [{ appId: 10, name: 'G', presets: [p] }] });
const bad = [
  { id: 'p', name: 'P', mods: [{ name: 'm', url: 'http://github.com/Coronitaa/x/a.zip' }] },
  { id: 'p', name: 'P', mods: [{ name: 'm', url: 'https://evil.example/a.zip' }] },
  { id: 'p', name: 'P', mods: [{ name: 'm', url: 'https://github.com/someoneelse/x/a.zip' }] },
  { id: 'p', name: 'P', manifests: { 1: 123 } },
  { id: 'p', name: 'P', emulator: { type: 'custom', name: 'E', url: 'https://github.com/Coronitaa/e/e.zip', settingsFile: '../x.ini', settings: { k: 'v' } } },
  { id: 'P!', name: 'P' },
];
for (const p of bad) assert.ok(validateCatalog(withPreset(p)).errors.length > 0, JSON.stringify(p));

const ok = validateCatalog(withPreset({ id: 'p', name: 'P', manifests: { 731: '18446744073709551615' },
  mods: [{ name: 'm', url: 'https://cdn.example/a.zip', sha256: 'A'.repeat(64) }] }));
assert.deepEqual(ok.errors, []);
assert.equal(ok.catalog.games[0].presets[0].mods[0].sha256, 'a'.repeat(64));

for (const p of ['../a.ini', 'C:/a.ini', '/a.ini', 'a/../b.ini', 'a.ini:s']) assert.equal(isSafeRelativePath(p), false, p);
assert.equal(validateCatalog({ schemaVersion: 2, games: [] }).catalog, null);
console.log('schema ok');
