// Validation for bluestar/catalog.json. Mirrors AdminCatalogParser.cs in BlueStar: the panel refuses
// to commit anything BlueStar would drop, and BlueStar re-validates everything it downloads anyway.

export const SCHEMA_VERSION = 1;

const TRUSTED_OWNER = 'coronitaa';
const IMAGE_HOSTS = new Set([
  'shared.steamstatic.com', 'cdn.steamstatic.com', 'shared.cloudflare.steamstatic.com', 'cdn.cloudflare.steamstatic.com',
  'shared.akamai.steamstatic.com', 'cdn.akamai.steamstatic.com', 'steamcdn-a.akamaihd.net',
  'coronitaa.github.io', 'raw.githubusercontent.com',
]);
export const EMULATOR_TYPES = ['none', 'refix', 'refix_goldberg', 'onlinefix', 'custom'];
const SETTINGS_EXT = ['.ini', '.cfg', '.txt', '.json'];

const RE_PRESET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RE_BRANCH = /^[A-Za-z0-9_.-]{1,64}$/;
const RE_DIGITS = /^[0-9]{1,20}$/;
const RE_SHA = /^[0-9a-f]{64}$/;
const RE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const RE_SEGMENT = /^[A-Za-z0-9 _.()+-]{1,64}$/;
const U32_MAX = 4294967295n;
const U64_MAX = 18446744073709551615n;

export function httpsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return null;
  if (/^[0-9.]+$/.test(u.hostname) || u.hostname.startsWith('[')) return null;
  return u;
}

export function isTrustedDownload(u) {
  const host = u.hostname.toLowerCase();
  if (host === 'coronitaa.github.io') return true;
  if (host === 'github.com' || host === 'raw.githubusercontent.com') {
    const seg = u.pathname.split('/').filter(Boolean);
    return seg.length >= 2 && seg[0].toLowerCase() === TRUSTED_OWNER;
  }
  return false;
}

export function isSafeRelativePath(path, extensions) {
  if (typeof path !== 'string' || !path.trim() || path.length > 200) return false;
  const segs = path.replace(/\\/g, '/').split('/');
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || s.endsWith('.') || s.endsWith(' ') || !RE_SEGMENT.test(s)) return false;
  }
  if (!extensions) return true;
  const dot = path.lastIndexOf('.');
  return dot > 0 && extensions.includes(path.slice(dot).toLowerCase());
}

const clean = (s, max, newlines = false) => {
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const out = (newlines ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]/g, '')).trim();
  return out ? out.slice(0, max) : null;
};

const isUint = (s, max) => RE_DIGITS.test(s) && BigInt(s) > 0n && BigInt(s) <= max;

function validateDownload(d, where, errors, fallbackName) {
  if (!d || typeof d !== 'object') { errors.push(`${where}: falta la descarga`); return null; }
  const u = httpsUrl(d.url ?? '');
  if (!u) { errors.push(`${where}: la URL tiene que ser https://`); return null; }
  let sha = typeof d.sha256 === 'string' ? d.sha256.trim().toLowerCase() : '';
  if (sha && !RE_SHA.test(sha)) { errors.push(`${where}: el SHA-256 tiene que tener 64 caracteres hex`); return null; }
  if (!sha && !isTrustedDownload(u)) {
    errors.push(`${where}: fuera de github.com/Coronitaa hace falta el SHA-256`);
    return null;
  }
  const name = clean(d.name, 120) ?? fallbackName;
  if (!name) { errors.push(`${where}: falta el nombre`); return null; }
  const out = { name, url: u.href };
  if (sha) out.sha256 = sha;
  return out;
}

function validateEmulator(e, where, errors) {
  if (e == null) return { type: 'none' };
  const type = e.type ?? 'none';
  if (!EMULATOR_TYPES.includes(type)) { errors.push(`${where}: tipo de emulador desconocido`); return null; }
  if (type !== 'custom') return { type };

  const name = clean(e.name, 80);
  if (!name) { errors.push(`${where}: el emulador personalizado necesita nombre`); return null; }
  const dl = validateDownload(e, `${where} emulador`, errors, name);
  if (!dl) return null;
  const out = { type, name, url: dl.url };
  if (dl.sha256) out.sha256 = dl.sha256;

  const settings = e.settings && typeof e.settings === 'object' ? e.settings : {};
  const keys = Object.keys(settings);
  if (e.settingsFile) {
    if (!isSafeRelativePath(e.settingsFile, SETTINGS_EXT)) {
      errors.push(`${where}: el archivo de ajustes tiene que ser una ruta relativa .ini/.cfg/.txt/.json dentro del juego`);
      return null;
    }
    out.settingsFile = e.settingsFile;
  }
  if (keys.length) {
    if (!out.settingsFile) { errors.push(`${where}: los ajustes necesitan un archivo de ajustes`); return null; }
    if (keys.length > 64) { errors.push(`${where}: demasiados ajustes`); return null; }
    out.settings = {};
    for (const k of keys) {
      const v = settings[k];
      if (!RE_KEY.test(k) || typeof v !== 'string' || v.length > 500 || /[\r\n\0]/.test(v)) {
        errors.push(`${where}: ajuste inválido "${k}"`);
        return null;
      }
      out.settings[k] = v;
    }
  }
  return out;
}

function validatePreset(p, appId, errors) {
  const where = `juego ${appId}, preset "${p?.id ?? '?'}"`;
  if (!p || typeof p !== 'object' || !RE_PRESET_ID.test(p.id ?? '')) {
    errors.push(`juego ${appId}: preset sin id válido (minúsculas, números, - y _)`);
    return null;
  }
  const name = clean(p.name, 120);
  if (!name) { errors.push(`${where}: falta el nombre`); return null; }
  const branch = p.branch || 'public';
  if (!RE_BRANCH.test(branch)) { errors.push(`${where}: rama inválida`); return null; }
  if (p.buildId && !RE_DIGITS.test(p.buildId)) { errors.push(`${where}: el build id son solo números`); return null; }

  const manifests = {};
  const entries = Object.entries(p.manifests ?? {});
  if (entries.length > 64) { errors.push(`${where}: demasiados depots`); return null; }
  for (const [depot, manifest] of entries) {
    if (!isUint(depot, U32_MAX) || typeof manifest !== 'string' || !isUint(manifest, U64_MAX)) {
      errors.push(`${where}: depot/manifest inválido (${depot})`);
      return null;
    }
    manifests[depot] = manifest;
  }

  const emulator = validateEmulator(p.emulator, where, errors);
  if (!emulator) return null;

  const mods = [];
  for (const m of (p.mods ?? []).slice(0, 50)) {
    const dl = validateDownload(m, `${where} mod`, errors);
    if (!dl) return null;
    mods.push(dl);
  }

  const out = { id: p.id, name, branch };
  if (p.buildId) out.buildId = p.buildId;
  if (entries.length) out.manifests = manifests;
  out.emulator = emulator;
  if (mods.length) out.mods = mods;
  const note = clean(p.note, 2000, true);
  if (note) out.note = note;
  return out;
}

/** Returns { catalog, errors }. Invalid entries are left out of `catalog` and explained in `errors`. */
export function validateCatalog(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== SCHEMA_VERSION) {
    return { catalog: null, errors: [`schemaVersion tiene que ser ${SCHEMA_VERSION}`] };
  }
  const games = [];
  const seen = new Set();
  for (const g of (Array.isArray(input.games) ? input.games : []).slice(0, 5000)) {
    const appId = g?.appId;
    if (!Number.isInteger(appId) || appId <= 0 || appId > 4294967295) { errors.push('juego sin AppID válido'); continue; }
    if (seen.has(appId)) { errors.push(`juego ${appId}: repetido`); continue; }
    const hidden = g.hidden === true;
    const name = clean(g.name, 200);
    if (!name && !hidden) { errors.push(`juego ${appId}: un juego visible necesita nombre`); continue; }

    const out = { appId };
    if (name) out.name = name;
    if (hidden) out.hidden = true;
    if (g.headerImageUrl) {
      const u = httpsUrl(g.headerImageUrl);
      if (u && IMAGE_HOSTS.has(u.hostname.toLowerCase())) out.headerImageUrl = u.href;
      else { errors.push(`juego ${appId}: la imagen tiene que ser https en un CDN de Steam o de Coronitaa`); continue; }
    }
    const desc = clean(g.description, 2000, true);
    if (desc) out.description = desc;

    const presets = [];
    const ids = new Set();
    let presetsOk = true;
    for (const p of (Array.isArray(g.presets) ? g.presets : []).slice(0, 20)) {
      const vp = validatePreset(p, appId, errors);
      if (!vp) { presetsOk = false; continue; }
      if (ids.has(vp.id)) { errors.push(`juego ${appId}: id de preset repetido "${vp.id}"`); presetsOk = false; continue; }
      ids.add(vp.id);
      presets.push(vp);
    }
    if (!presetsOk) continue;
    if (presets.length) out.presets = presets;
    seen.add(appId);
    games.push(out);
  }
  return { catalog: { schemaVersion: SCHEMA_VERSION, updatedAt: input.updatedAt, games }, errors };
}

export const steamHeaderUrl = (appId) =>
  `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
