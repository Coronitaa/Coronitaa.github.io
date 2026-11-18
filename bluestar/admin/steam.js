// Public Steam data for the panel. api.steamcmd.net is the only Steam source that allows browser
// requests (CORS); everything it returns goes through the same validation as hand-typed data.

const ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/';
const RE_DIGITS = /^[0-9]{1,20}$/;
const RE_REL = /^[0-9a-f]{40}\/[A-Za-z0-9_.-]+\.(jpg|png)$|^[A-Za-z0-9_.-]+\.(jpg|png)$/;

async function steamcmdInfo(appId) {
  const res = await fetch(`https://api.steamcmd.net/v1/info/${appId}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Steam no respondió (${res.status}).`);
  const body = await res.json();
  const info = body?.data?.[String(appId)];
  if (!info) throw new Error('Steam no conoce ese AppID.');
  return info;
}

const asset = (appId, rel) => {
  const path = typeof rel === 'object' && rel ? (rel.english ?? Object.values(rel)[0]) : rel;
  return typeof path === 'string' && RE_REL.test(path) ? `${ASSET_BASE}${appId}/${path}` : undefined;
};

/** Name, artwork, tags, developer/publisher and release date, ready to merge into a catalog game. */
export async function fetchSteamGame(appId) {
  const c = (await steamcmdInfo(appId)).common ?? {};
  const laf = c.library_assets_full ?? {};
  const pick = (k) => laf[k]?.image2x ?? laf[k]?.image;
  const assoc = Object.values(c.associations ?? {});
  const release = Number(c.steam_release_date);
  const out = {
    name: typeof c.name === 'string' ? c.name : undefined,
    headerImageUrl: asset(appId, c.header_image),
    capsuleImageUrl: asset(appId, pick('library_capsule')),
    heroImageUrl: asset(appId, pick('library_hero')),
    logoImageUrl: asset(appId, pick('library_logo')),
    developer: assoc.find((a) => a.type === 'developer')?.name,
    publisher: assoc.find((a) => a.type === 'publisher')?.name,
    releaseDateUtc: Number.isInteger(release) && release > 0 ? release : undefined,
    tagIds: Object.entries(c.store_tags ?? {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, t]) => Number(t))
      .filter((t) => Number.isInteger(t) && t > 0),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
}

/** Current build of each public branch (Steam only publishes the latest), Windows/shared depots only. */
function currentBuilds(info) {
  const depots = info.depots ?? {};
  const builds = [];
  for (const [branch, b] of Object.entries(depots.branches ?? {})) {
    const buildId = String(b.buildid ?? '');
    if (!RE_DIGITS.test(buildId) || String(b.pwdrequired ?? '0') === '1') continue;
    const manifests = {};
    for (const [depot, d] of Object.entries(depots)) {
      if (!/^[0-9]+$/.test(depot) || typeof d !== 'object') continue;
      const os = d.config?.oslist ?? '';
      if (os && !os.includes('windows')) continue;
      const gid = String(d.manifests?.[branch]?.gid ?? '');
      if (RE_DIGITS.test(gid)) manifests[depot] = gid;
    }
    if (Object.keys(manifests).length) builds.push({ buildId, branch, timeUpdated: Number(b.timeupdated) || null, manifests, live: true });
  }
  return builds;
}

/**
 * Every known build of a game: the live branches from Steam plus the history the hourly workflow
 * recorded in ../builds/<appId>.json. Newest first, one entry per branch+build.
 */
export async function fetchBuilds(appId) {
  const [live, recorded] = await Promise.all([
    steamcmdInfo(appId).then(currentBuilds).catch(() => []),
    fetch(`../builds/${appId}.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { builds: [] })).catch(() => ({ builds: [] })),
  ]);
  const seen = new Set();
  const all = [];
  for (const b of [...live, ...(recorded.builds ?? [])]) {
    const key = `${b.branch}/${b.buildId}`;
    if (seen.has(key) || !RE_DIGITS.test(String(b.buildId))) continue;
    seen.add(key);
    all.push(b);
  }
  return all.sort((a, b) => (b.timeUpdated ?? b.seenAt ?? 0) - (a.timeUpdated ?? a.seenAt ?? 0));
}

let tagsPromise;
/** Steam tag id → Spanish name (generated from Steam's popular tags list). */
export const loadTags = () => (tagsPromise ??= fetch('tags.json').then((r) => r.json()).catch(() => ({})));

let indexPromise;
/** Every game in BlueStar's Explore catalog as { appId, name, key } (key = lowercased name). */
export const loadExploreIndex = () => (indexPromise ??= fetch('../explore-index.json')
  .then((r) => { if (!r.ok) throw new Error('No se pudo cargar la lista de Explorar.'); return r.json(); })
  .then((rows) => rows.map(([appId, name]) => ({ appId, name, key: name.toLowerCase() }))));
