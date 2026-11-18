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
assert.ok(validateCatalog(withPreset({ id: 'p', name: 'P', emulator: { type: 'refix' } })).errors.length > 0, 'old emulator names are gone');
for (const type of ['refix_lan', 'refix_lan_online', 'refix_online_legacy', 'onlinefix', 'none'])
  assert.deepEqual(validateCatalog(withPreset({ id: 'p', name: 'P', emulator: { type } })).errors, [], type);
const meta = validateCatalog({ schemaVersion: 1, games: [{ appId: 5, name: 'M', tagIds: [19, 1663], releaseDateUtc: 1345568400,
  heroImageUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/5/abc/library_hero.jpg' }] });
assert.deepEqual(meta.errors, []);
assert.deepEqual(meta.catalog.games[0].tagIds, [19, 1663]);
assert.ok(validateCatalog({ schemaVersion: 1, games: [{ appId: 5, name: 'M', logoImageUrl: 'https://evil.example/l.png' }] }).errors.length > 0);
const rm = (refixMods) => validateCatalog(withPreset({ id: 'p', name: 'P', emulator: { type: 'refix_lan_online' }, refixMods }));
assert.deepEqual(rm(['refix.csgo.lan_overhaul', 'refix.csgo.lan_overhaul']).catalog.games[0].presets[0].refixMods, ['refix.csgo.lan_overhaul']);
assert.deepEqual(rm([]).catalog.games[0].presets[0].refixMods, [], 'an empty list means no ReFix mods');
assert.equal(rm(undefined).catalog.games[0].presets[0].refixMods, undefined);
for (const v of [['Bad Id'], ['a,b'], [1], 'refix.csgo.lan_overhaul']) assert.ok(rm(v).errors.length > 0, JSON.stringify(v));

const { buildOnDate } = await import('./steam.js');
const hist = [
  { branch: 'public', buildId: '3', timeUpdated: Date.parse('2018-08-30T12:00:00Z') / 1000 },
  { branch: 'public', buildId: '2', timeUpdated: Date.parse('2018-03-07T18:00:00Z') / 1000 },
  { branch: 'public', buildId: '1', timeUpdated: Date.parse('2018-02-01T00:00:00Z') / 1000 },
  { branch: 'beta', buildId: '9', timeUpdated: Date.parse('2018-03-08T00:00:00Z') / 1000 },
];
assert.equal(buildOnDate(hist, '2018-03-07').buildId, '2', 'a build published later that same day counts');
assert.equal(buildOnDate(hist, '2018-05-01').buildId, '2');
assert.equal(buildOnDate(hist, '2018-03-09', 'beta').buildId, '9');
assert.equal(buildOnDate(hist, '2017-01-01'), null);
assert.equal(buildOnDate(hist, 'nope'), null);
console.log('schema ok');
