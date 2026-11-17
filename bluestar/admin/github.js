// Storage backends. GitHub is the only authority: the panel can render without permission, but a write
// without push access to the repo is rejected by GitHub, not by this code.

export const REPO = { owner: 'Coronitaa', repo: 'Coronitaa.github.io', branch: 'main', path: 'bluestar/catalog.json' };
const API = 'https://api.github.com';

export const EMPTY_CATALOG = () => ({ schemaVersion: 1, games: [] });

export class ConflictError extends Error {}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubStore {
  #token;

  constructor(token) { this.#token = token; }

  async #call(path, init = {}) {
    const res = await fetch(API + path, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    return res;
  }

  /** Who the token belongs to and whether it can push to the catalog repo. */
  async whoami() {
    const user = await this.#call('/user');
    if (user.status === 401) throw new Error('GitHub no acepta ese token (caducado o mal copiado).');
    if (!user.ok) throw new Error(`GitHub respondió ${user.status}.`);
    const login = (await user.json()).login;
    const repo = await this.#call(`/repos/${REPO.owner}/${REPO.repo}`);
    if (!repo.ok) throw new Error('El token no tiene acceso al repo Coronitaa.github.io.');
    const canPush = (await repo.json()).permissions?.push === true;
    return { login, canPush };
  }

  async load() {
    const res = await this.#call(`/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.path}?ref=${REPO.branch}`);
    if (res.status === 404) return { catalog: EMPTY_CATALOG(), sha: null };
    if (!res.ok) throw new Error(`No se pudo leer el catálogo (${res.status}).`);
    const body = await res.json();
    return { catalog: JSON.parse(fromBase64Utf8(body.content)), sha: body.sha };
  }

  /** Commits the catalog. `sha` is the version it was edited from; GitHub refuses if someone committed since. */
  async save(catalog, sha, message) {
    const res = await this.#call(`/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.path}`, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: toBase64Utf8(JSON.stringify(catalog, null, 2) + '\n'),
        branch: REPO.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.status === 409 || res.status === 422) throw new ConflictError('El catálogo cambió en GitHub desde que lo abriste.');
    if (res.status === 403 || res.status === 404) throw new Error('GitHub rechazó el commit: esta cuenta no puede escribir en el repo.');
    if (!res.ok) throw new Error(`GitHub respondió ${res.status} al publicar.`);
    return (await res.json()).content.sha;
  }
}

/** Offline backend for trying the panel on localhost: reads ../catalog.json, "commits" stay in memory. */
export class LocalStore {
  saved = null;

  async whoami() { return { login: 'local (sin GitHub)', canPush: true }; }

  async load() {
    if (this.saved) return { catalog: structuredClone(this.saved), sha: 'local' };
    const res = await fetch('../catalog.json', { cache: 'no-store' });
    return { catalog: res.ok ? await res.json() : EMPTY_CATALOG(), sha: 'local' };
  }

  async save(catalog) {
    this.saved = structuredClone(catalog);
    return 'local';
  }
}
