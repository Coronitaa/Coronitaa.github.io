import { validateCatalog, EMULATOR_TYPES, steamHeaderUrl, httpsUrl } from './schema.js';
import { GitHubStore, LocalStore, ConflictError } from './github.js';
import { fetchSteamGame, fetchBuilds, loadTags, loadExploreIndex } from './steam.js';

// Refuse to run inside a frame (CSP frame-ancestors cannot be set from a <meta> tag).
if (window.top !== window.self) throw new Error('framed');

const TOKEN_KEY = 'bluestar-admin-token';
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

const $ = (id) => document.getElementById(id);
const state = { store: null, base: null, work: null, sha: null, selected: null, show: 'all', filter: '', source: 'catalog' };

/** Element builder. Text always goes through textContent/value, never innerHTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value' || k === 'checked') el[k] = v;
    else if (k === 'src') { el.src = v; el.addEventListener('error', () => el.removeAttribute('src')); }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const EMULATOR_LABELS = {
  none: 'Ninguno (Steam original)',
  refix_lan: 'ReFix LAN',
  refix_lan_online: 'ReFix LAN + Online',
  refix_online_legacy: 'ReFix Online Legacy',
  onlinefix: 'OnlineFix',
  custom: 'Otro (personalizado)',
};

/** replaceChildren that skips null/false, which it would otherwise print as the text "null". */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;
const slug = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'preset';

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ── Session ────────────────────────────────────────────────────────────────

async function start(store) {
  const who = await store.whoami();
  if (!who.canPush) throw new Error(`La cuenta ${who.login} no tiene permiso de escritura en el repo.`);
  state.store = store;
  $('session-user').textContent = who.login;
  $('session').hidden = false;
  $('login').hidden = true;
  $('app').hidden = false;
  await reload();
}

async function reload() {
  const { catalog, sha } = await state.store.load();
  state.base = catalog;
  state.work = structuredClone(catalog);
  state.work.games ??= [];
  state.sha = sha;
  state.selected = null;
  render();
}

function showLogin(error) {
  $('app').hidden = true;
  $('session').hidden = true;
  $('publish-bar').hidden = true;
  $('login').hidden = false;
  $('local-mode').hidden = !isLocalHost;
  $('login-error').hidden = !error;
  $('login-error').textContent = error ?? '';
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('token').value.trim();
  $('token').value = '';
  try {
    await start(new GitHubStore(token));
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch (err) {
    showLogin(err.message);
  }
});

$('token-file-btn').addEventListener('click', () => $('token-file').click());
$('token-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const token = typeof data === 'string' ? data
      : data?.Admin ?? data?.admin ?? data?.token ?? Object.values(data ?? {}).find((v) => typeof v === 'string');
    if (typeof token !== 'string' || !token.trim()) throw new Error('El archivo no tiene un token (clave "Admin").');
    $('token').value = token.trim();
    $('login-form').requestSubmit();
  } catch (err) {
    showLogin(err instanceof SyntaxError ? 'El archivo no es un JSON válido.' : err.message);
  }
});

$('local-mode').addEventListener('click', () => start(new LocalStore()).catch((err) => showLogin(err.message)));

$('logout').addEventListener('click', () => {
  if (isDirty() && !confirm('Hay cambios sin publicar. ¿Salir igualmente?')) return;
  sessionStorage.removeItem(TOKEN_KEY);
  state.store = null;
  showLogin();
});

window.addEventListener('beforeunload', (e) => { if (isDirty()) e.preventDefault(); });

// ── List ───────────────────────────────────────────────────────────────────

const games = () => state.work.games;
const findGame = (appId) => games().find((g) => g.appId === appId);
const isDirty = () => state.work && JSON.stringify(state.work) !== JSON.stringify(state.base);

async function renderExploreList() {
  const q = state.filter.trim().toLowerCase();
  const empty = $('list-empty');
  if (q.length < 2) {
    fill($('game-list'), );
    empty.hidden = false;
    empty.textContent = 'Escribe al menos 2 letras o un AppID para buscar entre todos los juegos de Explorar.';
    return;
  }
  let index;
  try { index = await loadExploreIndex(); } catch (err) { empty.hidden = false; empty.textContent = err.message; return; }
  if (state.source !== 'explore' || q !== state.filter.trim().toLowerCase()) return;
  const matches = [];
  for (const g of index) {
    if (String(g.appId) === q || g.key.includes(q)) matches.push(g);
    if (matches.length >= 100) break;
  }
  fill($('game-list'), ...matches.map((x) => {
    const inCatalog = findGame(x.appId);
    const open = (patch) => {
      if (!inCatalog) games().unshift({ appId: x.appId, name: x.name, ...patch });
      else Object.assign(inCatalog, patch);
      state.selected = x.appId;
      changed();
      renderEditor();
    };
    return h('li', { class: 'explore-row' },
      h('span', { class: 'game-meta' },
        h('span', { class: 'game-name', text: x.name }),
        h('span', { class: 'game-sub', text: String(x.appId) })),
      inCatalog?.hidden
        ? h('button', { type: 'button', class: 'btn btn-quiet', text: 'Mostrar', onclick: () => { delete inCatalog.hidden; open({}); } })
        : h('button', { type: 'button', class: 'btn btn-quiet', text: 'Ocultar', onclick: () => open({ hidden: true }) }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: inCatalog ? 'Editar' : 'Añadir', onclick: () => open({}) }));
  }));
  empty.hidden = matches.length > 0;
  empty.textContent = 'Ningún juego de Explorar coincide. Puedes añadirlo igual por AppID arriba.';
}

function renderList() {
  $('show-seg').hidden = state.source === 'explore';
  if (state.source === 'explore') { renderExploreList(); return; }
  const q = state.filter.trim().toLowerCase();
  const list = games().filter((g) =>
    (state.show === 'all' || (state.show === 'hidden') === !!g.hidden)
    && (!q || String(g.appId).includes(q) || (g.name ?? '').toLowerCase().includes(q)));

  fill($('game-list'), ...list.map((g) => {
    const presets = g.presets?.length ?? 0;
    return h('li', {},
      h('button', {
        type: 'button',
        class: 'game-item',
        'aria-current': g.appId === state.selected ? 'true' : null,
        onclick: () => { state.selected = g.appId; render(); },
      },
      h('img', { src: g.headerImageUrl || steamHeaderUrl(g.appId), alt: '', width: 92, height: 43, loading: 'lazy' }),
      h('span', { class: 'game-meta' },
        h('span', { class: 'game-name', text: g.name || 'Sin nombre' }),
        h('span', { class: 'game-sub', text: `${g.appId}${presets ? ` · ${presets} preset${presets > 1 ? 's' : ''}` : ''}` })),
      g.hidden ? h('span', { class: 'tag tag-hidden', text: 'Oculto' }) : null));
  }));

  const empty = $('list-empty');
  empty.hidden = list.length > 0;
  empty.textContent = games().length === 0
    ? 'El catálogo está vacío. Añade un juego con su AppID de Steam.'
    : 'Ningún juego coincide con la búsqueda.';
}

$('filter').addEventListener('input', (e) => { state.filter = e.target.value; renderList(); });
document.querySelectorAll('#show-seg button').forEach((b) => b.addEventListener('click', () => {
  state.show = b.dataset.show;
  document.querySelectorAll('#show-seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderList();
}));
document.querySelectorAll('.seg.source button').forEach((b) => b.addEventListener('click', () => {
  state.source = b.dataset.source;
  document.querySelectorAll('.seg.source button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderList();
}));

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const appId = Number($('add-appid').value.trim());
  if (!Number.isInteger(appId) || appId <= 0 || appId > 4294967295) { toast('Ese AppID no es válido.'); return; }
  const isNew = !findGame(appId);
  if (isNew) games().unshift({ appId, name: '' });
  $('add-appid').value = '';
  state.selected = appId;
  render();
  if (isNew) importFromSteam(findGame(appId), { onlyMissing: true });
});

// ── Editor ─────────────────────────────────────────────────────────────────

/** A labelled input bound to obj[key]. Changes update state without re-rendering, so focus stays put. */
function field(label, obj, key, opts = {}) {
  const id = nextId('f');
  const input = h(opts.multiline ? 'textarea' : 'input', {
    id,
    value: obj[key] ?? '',
    placeholder: opts.placeholder,
    inputmode: opts.numeric ? 'numeric' : null,
    spellcheck: opts.code ? 'false' : null,
    rows: opts.multiline ? 4 : null,
    'data-field': key,
    class: opts.code ? 'mono' : null,
    oninput: (e) => {
      const v = e.target.value;
      if (v.trim() === '') delete obj[key]; else obj[key] = opts.trim === false ? v : v.trim();
      opts.onchange?.(v);
      changed();
    },
  });
  return h('div', { class: `field ${opts.wide ? 'wide' : ''}` },
    h('label', { for: id, text: label }), input, opts.hint ? h('p', { class: 'hint', text: opts.hint }) : null);
}

/** Unix-seconds field shown as a date picker. */
function dateField(label, obj, key) {
  const id = nextId('d');
  const value = obj[key] ? new Date(obj[key] * 1000).toISOString().slice(0, 10) : '';
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), h('input', {
    id, type: 'date', value,
    oninput: (e) => {
      if (!e.target.value) delete obj[key]; else obj[key] = Math.floor(Date.parse(`${e.target.value}T00:00:00Z`) / 1000);
      changed();
    },
  }));
}

function changed() {
  const n = pendingCount();
  $('publish-bar').hidden = n === 0;
  $('pending-text').textContent = n === 1 ? '1 juego con cambios sin publicar' : `${n} juegos con cambios sin publicar`;
  renderList();
}

function renderEditor() {
  const ed = $('editor');
  const g = state.selected != null ? findGame(state.selected) : null;
  document.body.classList.toggle('editing', !!g);
  if (!g) {
    fill(ed, h('div', { class: 'editor-empty' },
      h('h2', { text: 'Elige un juego' }),
      h('p', { text: 'Selecciona un juego de la lista para editar su ficha y sus versiones recomendadas, u ocultarlo de Explorar.' })));
    return;
  }

  const preview = h('img', { class: 'header-preview', alt: '', width: 460, height: 215, src: g.headerImageUrl || steamHeaderUrl(g.appId) });
  const updatePreview = (v) => {
    const u = v ? httpsUrl(v) : null;
    preview.src = u ? u.href : steamHeaderUrl(g.appId);
  };

  fill(ed, 
    h('button', { type: 'button', class: 'btn btn-quiet back', text: '← Juegos', onclick: () => { state.selected = null; render(); } }),
    h('div', { class: 'editor-head' },
      preview,
      h('div', { class: 'head-text' },
        h('p', { class: 'appid' }, 'AppID ', h('a', {
          href: `https://steamdb.info/app/${g.appId}/depots/`, target: '_blank', rel: 'noopener noreferrer', text: String(g.appId),
        })),
        h('label', { class: 'switch' },
          h('input', {
            type: 'checkbox', checked: !!g.hidden,
            onchange: (e) => { if (e.target.checked) g.hidden = true; else delete g.hidden; changed(); renderEditor(); },
          }),
          h('span', { text: 'Ocultar en Explorar' })),
        h('p', { class: 'hint', text: g.hidden
          ? 'BlueStar no lo mostrará en Explorar, aunque Steam lo devuelva en una búsqueda.'
          : 'Forma parte del feed de Explorar como cualquier juego: búsquedas, tags y orden normales.' }),
        h('button', { type: 'button', class: 'btn', text: 'Traer datos de Steam', onclick: () => importFromSteam(g) }))),
    h('div', { class: 'grid' },
      field('Nombre', g, 'name', { placeholder: 'Nombre como aparece en Steam' }),
      field('Imagen de cabecera', g, 'headerImageUrl', {
        code: true, placeholder: steamHeaderUrl(g.appId), onchange: updatePreview,
        hint: 'Vacío usa la imagen de Steam. Solo CDN de Steam o de Coronitaa.',
      }),
      field('Cápsula vertical (600×900)', g, 'capsuleImageUrl', { code: true }),
      field('Hero (fondo)', g, 'heroImageUrl', { code: true }),
      field('Logo', g, 'logoImageUrl', { code: true }),
      field('Desarrollador', g, 'developer'),
      field('Editor', g, 'publisher'),
      dateField('Fecha de lanzamiento', g, 'releaseDateUtc'),
      tagEditor(g),
      field('Descripción', g, 'description', { multiline: true, wide: true, trim: false })),
    h('div', { class: 'section-head' }, h('h2', { text: 'Builds del juego' })),
    buildsSection(g),
    h('div', { class: 'section-head' },
      h('h2', { text: 'Versiones recomendadas' }),
      h('button', { type: 'button', class: 'btn', text: 'Añadir preset', onclick: () => addPreset(g) })),
    (g.presets?.length ?? 0) === 0
      ? h('p', { class: 'empty', text: 'Sin presets: el instalador ofrecerá la última versión de Steam. Añade uno para fijar un build, un emulador y mods.' })
      : h('div', { class: 'presets' }, g.presets.map((p, i) => presetCard(g, p, i))),
    h('div', { class: 'danger-zone' },
      h('button', {
        type: 'button', class: 'btn btn-danger', text: 'Quitar del catálogo',
        onclick: () => {
          if (!confirm(`¿Quitar ${g.name || g.appId} del catálogo? Volverá a comportarse como cualquier juego de Steam.`)) return;
          state.work.games = games().filter((x) => x !== g);
          state.selected = null;
          changed();
          render();
        },
      })),
  );
}

/** Fills name, artwork, tags, developer and release date from Steam. */
async function importFromSteam(g, { onlyMissing = false } = {}) {
  try {
    const data = await fetchSteamGame(g.appId);
    for (const [k, v] of Object.entries(data)) if (!onlyMissing || g[k] == null || g[k] === '') g[k] = v;
    changed();
    if (state.selected === g.appId) renderEditor();
    toast(`Datos de Steam cargados para ${g.name || g.appId}.`);
  } catch (err) {
    toast(`Steam: ${err.message} Puedes rellenar los datos a mano.`);
  }
}

/** Tag chips with remove buttons and a name box that suggests Steam's tags. */
function tagEditor(g) {
  const wrap = h('div', { class: 'field wide' });
  const listId = nextId('tags');
  loadTags().then((tags) => {
    const byName = new Map(Object.entries(tags).map(([id, name]) => [name.toLowerCase(), Number(id)]));
    const draw = () => {
      const input = h('input', {
        list: listId, placeholder: 'Añadir tag (ej.: Acción)', 'aria-label': 'Añadir tag',
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const v = e.target.value.trim();
          const id = /^[0-9]+$/.test(v) ? Number(v) : byName.get(v.toLowerCase());
          if (!id) { toast('Ese tag no existe en Steam.'); return; }
          g.tagIds = [...new Set([...(g.tagIds ?? []), id])].slice(0, 40);
          changed();
          draw();
          wrap.querySelector('input')?.focus();
        },
      });
      fill(wrap, 
        h('label', { text: 'Tags (filtros de Explorar)' }),
        h('div', { class: 'chips' }, (g.tagIds ?? []).map((id) => h('span', { class: 'chip' },
          tags[id] ?? `#${id}`,
          h('button', {
            type: 'button', class: 'chip-x', 'aria-label': `Quitar ${tags[id] ?? id}`, text: '×',
            onclick: () => { g.tagIds = g.tagIds.filter((t) => t !== id); if (!g.tagIds.length) delete g.tagIds; changed(); draw(); },
          })))),
        input,
        h('datalist', { id: listId }, Object.values(tags).sort().map((n) => h('option', { value: n }))));
    };
    draw();
  });
  return wrap;
}

/** The game's builds (live branches + recorded history); each one can become a preset. */
function buildsSection(g) {
  const wrap = h('div', { class: 'builds' });
  const load = async () => {
    fill(wrap, h('p', { class: 'empty', text: 'Cargando builds…' }));
    const builds = await fetchBuilds(g.appId);
    if (!builds.length) {
      fill(wrap, h('p', { class: 'empty', text: 'Steam no publica builds para este juego (o necesita contraseña). Rellena los depots del preset a mano.' }));
      return;
    }
    const fmt = (t) => (t ? new Date(t * 1000).toLocaleDateString('es', { year: 'numeric', month: 'short', day: 'numeric' }) : 'fecha desconocida');
    fill(wrap, 
      h('p', { class: 'hint', text: 'Steam solo publica el build actual de cada rama; los anteriores son los que el panel ha ido registrando desde que el juego está en el catálogo.' }),
      h('ul', { class: 'build-list' }, builds.map((b) => h('li', { class: 'build-row' },
        h('span', { class: 'game-meta' },
          h('span', { class: 'game-name', text: `Build ${b.buildId}${b.live ? ' · actual' : ''}` }),
          h('span', { class: 'game-sub', text: `${b.branch} · ${fmt(b.timeUpdated ?? b.seenAt)} · ${Object.keys(b.manifests).length} depots` })),
        h('button', { type: 'button', class: 'btn', text: 'Usar como preset', onclick: () => addPreset(g, b) })))));
  };
  wrap.append(h('button', { type: 'button', class: 'btn', text: 'Cargar builds', onclick: load }));
  return wrap;
}

function addPreset(g, build) {
  g.presets ??= [];
  const n = g.presets.length + 1;
  const preset = { id: n === 1 ? 'recomendada' : `recomendada-${n}`, name: '', branch: 'public', emulator: { type: 'refix_lan_online' } };
  if (build) {
    const date = build.timeUpdated ? new Date(build.timeUpdated * 1000).toISOString().slice(0, 10) : '';
    Object.assign(preset, {
      id: `build-${build.buildId}`, name: `Build ${build.buildId}${date ? ` (${date})` : ''}`,
      branch: build.branch, buildId: build.buildId, manifests: { ...build.manifests },
    });
    if (g.presets.some((x) => x.id === preset.id)) { toast('Ya hay un preset con ese build.'); return; }
  }
  g.presets.push(preset);
  changed();
  renderEditor();
}

function presetCard(g, p, index) {
  p.emulator ??= { type: 'none' };
  const move = (d) => {
    const j = index + d;
    [g.presets[index], g.presets[j]] = [g.presets[j], g.presets[index]];
    changed();
    renderEditor();
  };
  const idField = field('Id', p, 'id', { code: true, hint: 'Minúsculas, números, - y _. No lo cambies una vez publicado.' });

  return h('article', { class: 'preset' },
    h('div', { class: 'preset-head' },
      h('span', { class: 'preset-num', text: index === 0 ? 'Principal' : `Alternativa ${index}` }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-quiet', text: '↑', 'aria-label': 'Subir', disabled: index === 0, onclick: () => move(-1) }),
        h('button', { type: 'button', class: 'btn btn-quiet', text: '↓', 'aria-label': 'Bajar', disabled: index === g.presets.length - 1, onclick: () => move(1) }),
        h('button', {
          type: 'button', class: 'btn btn-quiet danger-text', text: 'Eliminar',
          onclick: () => { g.presets.splice(index, 1); changed(); renderEditor(); },
        }))),
    h('div', { class: 'grid' },
      field('Nombre', p, 'name', {
        placeholder: 'Ej.: Última versión de CS:GO',
        onchange: (v) => {
          // Until it is published, the id follows the name.
          if (!isPublishedPreset(g.appId, p.id)) { p.id = slug(v); idField.querySelector('input').value = p.id; }
        },
      }),
      idField,
      field('Rama', p, 'branch', { code: true, placeholder: 'public' }),
      field('Build ID', p, 'buildId', { code: true, numeric: true, placeholder: 'Opcional', hint: 'Lo rellena «Usar como preset» en Builds del juego.' })),
    h('h3', { text: 'Depots y manifests' }),
    pairTable(p, 'manifests', ['Depot', 'Manifest'], 'Sin depots fijados: se descarga lo último de la rama.'),
    h('h3', { text: 'Emulador' }),
    emulatorEditor(p),
    h('h3', { text: 'Mods' }),
    modsEditor(p),
    field('Nota para el usuario', p, 'note', {
      multiline: true, wide: true, trim: false,
      hint: 'Se muestra en el instalador junto a la versión recomendada.',
    }));
}

function isPublishedPreset(appId, id) {
  return !!state.base.games?.find((x) => x.appId === appId)?.presets?.some((x) => x.id === id);
}

/** Editable key/value rows stored as an object (depot → manifest, setting → value). */
function pairTable(owner, key, [kLabel, vLabel], emptyText) {
  const rows = Object.entries(owner[key] ?? {}).map(([k, v]) => ({ k, v }));
  const wrap = h('div', { class: 'pairs' });
  const sync = () => {
    const obj = {};
    for (const r of rows) if (r.k.trim()) obj[r.k.trim()] = r.v.trim();
    if (Object.keys(obj).length) owner[key] = obj; else delete owner[key];
    changed();
  };
  const draw = () => {
    fill(wrap, 
      rows.length === 0 ? h('p', { class: 'empty', text: emptyText }) : null,
      ...rows.map((r, i) => h('div', { class: 'pair' },
        h('input', { class: 'mono', value: r.k, placeholder: kLabel, 'aria-label': kLabel, oninput: (e) => { r.k = e.target.value; sync(); } }),
        h('input', { class: 'mono', value: r.v, placeholder: vLabel, 'aria-label': vLabel, oninput: (e) => { r.v = e.target.value; sync(); } }),
        h('button', { type: 'button', class: 'btn btn-quiet', text: 'Quitar', onclick: () => { rows.splice(i, 1); sync(); draw(); } }))),
      h('button', { type: 'button', class: 'btn btn-quiet', text: `Añadir ${kLabel.toLowerCase()}`, onclick: () => { rows.push({ k: '', v: '' }); draw(); } }));
  };
  draw();
  return wrap;
}

async function sha256OfFile(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 input with a "compute from a local file" button. */
function shaField(obj) {
  const f = field('SHA-256', obj, 'sha256', {
    code: true, placeholder: 'Obligatorio fuera de github.com/Coronitaa',
  });
  const input = f.querySelector('input');
  const picker = h('input', {
    type: 'file', hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      input.value = await sha256OfFile(file);
      input.dispatchEvent(new Event('input'));
      toast(`SHA-256 calculado de ${file.name}`);
    },
  });
  f.append(picker, h('button', { type: 'button', class: 'btn btn-quiet', text: 'Calcular desde archivo', onclick: () => picker.click() }));
  return f;
}

function emulatorEditor(p) {
  const e = p.emulator;
  const id = nextId('emu');
  const custom = h('div', { class: 'grid', hidden: e.type !== 'custom' },
    field('Nombre del emulador', e, 'name'),
    field('URL de descarga (zip/7z/rar)', e, 'url', { code: true, placeholder: 'https://github.com/Coronitaa/…/releases/download/…' }),
    shaField(e),
    field('Archivo de ajustes', e, 'settingsFile', { code: true, placeholder: 'steam_settings/configs.user.ini', hint: 'Ruta dentro de la carpeta del juego.' }),
    h('div', { class: 'field wide' }, h('label', { text: 'Ajustes (clave = valor)' }),
      pairTable(e, 'settings', ['Clave', 'Valor'], 'Sin ajustes.')));
  return h('div', {},
    h('div', { class: 'field' },
      h('label', { for: id, text: 'Emulador que se instala' }),
      h('select', {
        id,
        onchange: (ev) => {
          const type = ev.target.value;
          for (const k of Object.keys(e)) delete e[k];
          e.type = type;
          custom.hidden = type !== 'custom';
          changed();
          if (type === 'custom') renderEditor();
        },
      }, EMULATOR_TYPES.map((t) => h('option', { value: t, text: EMULATOR_LABELS[t], selected: t === e.type })))),
    custom);
}

function modsEditor(p) {
  p.mods ??= [];
  const wrap = h('div', { class: 'mods' });
  const draw = () => fill(wrap, 
    p.mods.length === 0 ? h('p', { class: 'empty', text: 'Sin mods.' }) : null,
    ...p.mods.map((m, i) => h('div', { class: 'mod grid' },
      field('Nombre', m, 'name'),
      field('URL', m, 'url', { code: true, placeholder: 'https://github.com/Coronitaa/…' }),
      shaField(m),
      h('div', { class: 'field end' }, h('button', {
        type: 'button', class: 'btn btn-quiet danger-text', text: 'Quitar mod',
        onclick: () => { p.mods.splice(i, 1); changed(); draw(); },
      })))),
    h('button', { type: 'button', class: 'btn btn-quiet', text: 'Añadir mod', onclick: () => { p.mods.push({}); draw(); } }));
  draw();
  return wrap;
}

function render() {
  renderList();
  renderEditor();
  changed();
}

// ── Publish ────────────────────────────────────────────────────────────────

/** Cleans the working copy into what gets committed: empty arrays and blank mod rows dropped. */
function normalized() {
  const out = structuredClone(state.work);
  for (const g of out.games) {
    if (g.presets) {
      for (const p of g.presets) {
        if (p.mods) p.mods = p.mods.filter((m) => Object.keys(m).length);
        if (!p.mods?.length) delete p.mods;
      }
      if (!g.presets.length) delete g.presets;
    }
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

function changesSummary() {
  const before = new Map((state.base.games ?? []).map((g) => [g.appId, g]));
  const after = new Map(games().map((g) => [g.appId, g]));
  const lines = [];
  for (const [id, g] of after) {
    const old = before.get(id);
    const label = g.name || String(id);
    if (!old) lines.push(`Añadido: ${label}${g.hidden ? ' (oculto)' : ''}`);
    else if (JSON.stringify(old) !== JSON.stringify(g)) {
      if (!!old.hidden !== !!g.hidden) lines.push(`${g.hidden ? 'Ocultado' : 'Visible otra vez'}: ${label}`);
      else lines.push(`Editado: ${label}`);
    }
  }
  for (const [id, g] of before) if (!after.has(id)) lines.push(`Quitado: ${g.name || id}`);
  return lines;
}

function pendingCount() {
  if (!state.work) return 0;
  const before = new Map((state.base.games ?? []).map((g) => [g.appId, JSON.stringify(g)]));
  let n = 0;
  for (const g of games()) if (before.get(g.appId) !== JSON.stringify(g)) n++;
  const now = new Set(games().map((g) => g.appId));
  for (const id of before.keys()) if (!now.has(id)) n++;
  return n;
}

$('discard').addEventListener('click', () => {
  if (!confirm('¿Descartar todos los cambios sin publicar?')) return;
  state.work = structuredClone(state.base);
  state.work.games ??= [];
  render();
});

$('review').addEventListener('click', () => {
  const summary = changesSummary();
  const { errors } = validateCatalog(normalized());
  fill($('publish-summary'), ...summary.map((s) => h('li', { text: s })));
  fill($('publish-errors'), ...errors.map((s) => h('li', { text: s })));
  $('publish-errors').hidden = errors.length === 0;
  $('publish-confirm').disabled = errors.length > 0;
  $('publish-status').hidden = true;
  $('commit-msg').value = summary.length === 1 ? `catalog: ${summary[0]}` : `catalog: ${summary.length} cambios`;
  $('publish-dialog').showModal();
});

$('publish-cancel').addEventListener('click', () => $('publish-dialog').close());

$('publish-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { catalog, errors } = validateCatalog(normalized());
  if (errors.length) return;
  const status = $('publish-status');
  $('publish-confirm').disabled = true;
  try {
    state.sha = await state.store.save(catalog, state.sha, $('commit-msg').value.trim() || 'catalog: update');
    state.base = structuredClone(catalog);
    state.work = structuredClone(catalog);
    $('publish-dialog').close();
    toast('Publicado. GitHub Pages lo sirve en un par de minutos.');
    render();
  } catch (err) {
    status.hidden = false;
    status.textContent = err instanceof ConflictError
      ? `${err.message} Recarga la página para traer la versión nueva; tus cambios sin publicar se perderán.`
      : err.message;
  } finally {
    $('publish-confirm').disabled = false;
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────

const saved = sessionStorage.getItem(TOKEN_KEY);
if (saved) start(new GitHubStore(saved)).catch((err) => { sessionStorage.removeItem(TOKEN_KEY); showLogin(err.message); });
else showLogin();

// Exposed for the local-mode check only; never set on the live site.
if (isLocalHost) window.__bluestarAdmin = { state, normalized };
