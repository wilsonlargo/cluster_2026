// js/main_ob2_final_v2.js (ob2 rewrite aligned to current schema)
//
// ✅ casos_2026: CRUD + autosave + población (npersonas/nmujeres/nhombres/nmenores)
// ✅ Territorialización: tabla public.caso_municipio_2026 con columnas:
//    - id (uuid)
//    - caso_id (uuid)
//    - municipio (text)
//    - lat (float8)
//    - lng (float8)
// ✅ Agregar municipio: selecciona municipio (por id) -> trae municipio/lat/lng desde public.municipios -> inserta en caso_municipio_2026
// ✅ Quitar municipio: borra por (caso_id, municipio)

const SUPABASE_URL = 'https://sjvuxlcgeswapbphsqkv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqdnV4bGNnZXN3YXBicGhzcWt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDc4NDI5OTUsImV4cCI6MjA2MzQxODk5NX0.6DsrPgVPvg0VWIjV7jnwgNlIxFAM0wOeJfGYbl9MaKE';

const INDEX_PAGE = 'index.html';
const MONITOR_PAGE = 'monitor.html';

// Tablas
const TBL_CASOS = 'casos_2026';
const TBL_PUEBLOS = 'pueblos';
const TBL_TIPOS = 'tipos';
const TBL_DEPTOS = 'departamentos';
const TBL_MUNIS = 'municipios';
const TBL_CASO_MUNI = 'caso_municipio_2026';



// Desplazamientos (1 por caso)
const TBL_DESPLAZAMIENTOS = 'desplazamientos_2026';
const TBL_PERSONAS = 'personas_2026';
// Actores
const TBL_MACROACTOR = 'macroactor';
const TBL_ACTORES = 'actores';
// Columnas claves (tabla puente actual)
const COL_CASO_ID = 'caso_id';
const COL_MUNICIPIO_TXT = 'municipio';

// RPCs
const RPC_ANIOS = 'get_anios_casos_2026';
const RPC_MACROTIPOS = 'get_macrotipos';
const RPC_TERRITORIO = 'get_territorio_caso';

const CASE_SELECT_COLUMNS = [
  'id',
  'fecha_evento',
  'macrotipo',
  'detalle',
  'subtipos',
  'pueblo',
  'detalle_lugar',
  'npersonas',
  'nmujeres',
  'nhombres',
  'nmenores',
  'macroactor',
  'microactores',
  'fuente',
  'fechafuente',
  'enlace',
  'contextual_info',
  'contextual_type',
].join(', ');

function qs(id) { return document.getElementById(id); }

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  if (!Array.isArray(children)) children = [children];
  children.filter(Boolean).forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return n;
}

function alertBox(type, msg) {
  return el('div', { class: `alert alert-${type} py-2 mb-0`, role: 'alert', text: msg });
}

function showAlert(type, msg) {
  const host = qs('monitorAlert');
  if (!host) return;
  host.innerHTML = '';
  host.appendChild(alertBox(type, msg));
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function boolValue(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  return ['true', '1', 'si', 'sí', 'yes'].includes(normLocal(value));
}

function setValue(id, value = '') {
  const node = qs(id);
  if (node) node.value = value ?? '';
}

function setChecked(id, checked, disabled = false) {
  const node = qs(id);
  if (!node) return;
  node.checked = !!checked;
  node.disabled = !!disabled;
}

function updateCurrentCasePatch(patch) {
  if (state.idx < 0 || !state.cases[state.idx]) return;
  Object.assign(state.cases[state.idx], patch);
}

function debounce(fn, wait = 600) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function normLocal(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeArrayStrings(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map(x => x.trim()).filter(Boolean);
  return [];
}

function pickPuebloLabel(row) {
  if (!row || typeof row !== 'object') return '';
  const keys = ['pueblo', 'nombre', 'etnonimo', 'pueblos', 'pueblo_nombre', 'etnia', 'pueblo_txt'];
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim()) return String(row[k]).trim();
  }
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue;
    if (v != null && typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const state = {
  supabase: null,
  pueblosCatalog: [],
  year: null,
  cases: [],
  idx: -1,
  departamentos: [],
  deptoMap: new Map(),
  deptoNameMap: new Map(),
  municipiosByValue: new Map(),
  municipiosFullByName: null,
  viewIdxs: [],
  territorioByCaso: new Map(),
  muniDeptoMap: null,
};

let bindDone = false;
let detalleDebounce = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (!window.supabase?.createClient) {
    const app = qs('app');
    if (app) app.innerHTML = `<div class="container py-5">${alertBox('danger', 'No cargó supabase-js.').outerHTML}</div>`;
    return;
  }

  // index?
  if (qs('app') && !qs('selectYear')) {
    initIndex();
    return;
  }

  // monitor?
  if (qs('selectYear')) {
    initMonitor();
    return;
  }
});

// ----------------- INDEX -----------------
function initIndex() {
  const app = qs('app');
  if (!app) return;

  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const alertZone = el('div', { class: 'mb-3' });
  const inputEmail = el('input', { class: 'form-control', type: 'email', placeholder: 'tu@correo.com', autocomplete: 'username', required: 'true' });
  const inputPass = el('input', { class: 'form-control', type: 'password', placeholder: '••••••••', autocomplete: 'current-password', required: 'true' });

  const btn = el('button', { class: 'btn btn-primary w-100 d-flex align-items-center justify-content-center gap-2', type: 'submit' }, [
    el('i', { class: 'bi bi-box-arrow-in-right' }),
    el('span', { text: 'Ingresar' })
  ]);

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      alertZone.innerHTML = '';

      const email = inputEmail.value.trim();
      const password = inputPass.value;
      if (!email || !password) {
        alertZone.appendChild(alertBox('warning', 'Escribe correo y contraseña.'));
        return;
      }

      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span><span>Validando...</span>`;

      try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        if (data?.session) {
          alertZone.appendChild(alertBox('success', 'Ingreso correcto. Redirigiendo…'));
          setTimeout(() => (window.location.href = MONITOR_PAGE), 200);
        } else {
          alertZone.appendChild(alertBox('warning', 'No se obtuvo sesión.'));
        }
      } catch (err) {
        alertZone.appendChild(alertBox('danger', err?.message || 'Error al iniciar sesión.'));
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-box-arrow-in-right"></i><span>Ingresar</span>`;
      }
    }
  }, [
    el('div', { class: 'd-flex min-vh-100 align-items-center justify-content-center p-3' }, [
      el('div', { class: 'card shadow-sm', style: 'max-width:420px;width:100%;' }, [
        el('div', { class: 'card-body p-4' }, [
          el('div', { class: 'd-flex align-items-center gap-2 mb-2' }, [
            el('i', { class: 'bi bi-shield-lock fs-4' }),
            el('div', { class: 'h5 mb-0', text: 'Ingreso' })
          ]),
          el('div', { class: 'text-muted small mb-3', text: 'Accede con tu correo y contraseña.' }),
          alertZone,
          el('div', { class: 'mb-3' }, [
            el('label', { class: 'form-label', text: 'Correo' }),
            el('div', { class: 'input-group' }, [
              el('span', { class: 'input-group-text' }, [el('i', { class: 'bi bi-envelope' })]),
              inputEmail
            ])
          ]),
          el('div', { class: 'mb-3' }, [
            el('label', { class: 'form-label', text: 'Contraseña' }),
            el('div', { class: 'input-group' }, [
              el('span', { class: 'input-group-text' }, [el('i', { class: 'bi bi-key' })]),
              inputPass
            ])
          ]),
          btn
        ])
      ])
    ])
  ]);

  app.innerHTML = '';
  app.appendChild(form);
}

// ----------------- MONITOR -----------------
async function initMonitor() {
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  state.supabase = supabaseClient;

  const { data: sessionData } = await supabaseClient.auth.getSession();
  if (!sessionData?.session) {
    window.location.href = INDEX_PAGE;
    return;
  }

  const selYear = qs('selectYear');
  const selMacro = qs('selectMacrotipo');

  const years = await loadYears(selYear, supabaseClient);
  await loadMacrotipos(selMacro, supabaseClient);
  await loadSubtiposCatalog(qs('subtipoNew'), supabaseClient);
  await loadPueblosCatalog(qs('puebloNew'), supabaseClient);
  await loadMacroactoresCatalog(qs('selectMacroactor'), supabaseClient);
  await loadMicroactoresCatalog(qs('microactorNew'), supabaseClient, null);
  await loadDepartamentosCatalog(qs('selectDepartamento'), supabaseClient);
  await loadMunicipiosCatalog(qs('selectMunicipio'), supabaseClient, qs('selectDepartamento')?.value);

  const selDepto = qs('selectDepartamento');
  if (selDepto) {
    const onDeptChange = async () => {
      updateDeptoMacroInfo(selDepto.value);
      await loadMunicipiosCatalog(qs('selectMunicipio'), supabaseClient, selDepto.value);
    };
    selDepto.addEventListener('change', onDeptChange);
    selDepto.addEventListener('input', onDeptChange);
    updateDeptoMacroInfo(selDepto.value);
  }

  const yNow = String(new Date().getFullYear());
  const initial = years.includes(yNow) ? yNow : (years[0] || yNow);
  selYear.value = initial;

  await loadCasesForYear(initial, supabaseClient, { goLast: true });

  selYear.addEventListener('change', async () => {
    await loadCasesForYear(selYear.value, supabaseClient, { goLast: true });
  });

  bindMonitor(supabaseClient);
}

function getCurrentCase() {
  if (state.idx < 0) return null;
  return state.cases[state.idx] || null;
}

function setBtnEnabled(id, enabled) {
  const b = qs(id);
  if (!b) return;
  b.disabled = !enabled;
}

function applyContextualVisual(isContextual) {
  const active = !!isContextual;
  document.body.classList.toggle('contextual-active', active);
  document.body.dataset.contextual = active ? 'true' : 'false';

  qs('caseFormCard')?.classList.toggle('border-warning', active);
  qs('contextualInfo')?.classList.toggle('border-warning', active);
}


async function setIndex(newIdx, supabaseClient) {
  state.idx = newIdx;
  renderCurrentCase();
  await refreshTerritorioRPC(supabaseClient);
  await refreshDesplazamientoIndicator(supabaseClient);
  await loadPersonas(supabaseClient);
}

function renderCurrentCase() {
  const info = qs('caseInfo');
  const fecha = qs('fechaEvento');
  const mtSel = qs('selectMacrotipo');
  const det = qs('detalle');
  const detLugar = qs('detalleLugar');

  const fuenteEl = qs('fuente');
  const fechaFuenteEl = qs('fechaFuente');
  const enlaceFuenteEl = qs('enlaceFuente');
  const btnOpenFuente = qs('btnOpenFuente');
  const contextualEl = qs('contextualInfo');
  const contextualTypeEl = qs('contextualType');

  const selMacroactor = qs('selectMacroactor');
  const selMicroactor = qs('microactorNew');

  const nPersonas = qs('npersonas');
  const nMujeres = qs('nmujeres');
  const nHombres = qs('nhombres');
  const nMenores = qs('nmenores');

  const total = state.cases.length;
  const cur = getCurrentCase();

  setBtnEnabled('btnFirst', total > 0 && state.idx > 0);
  setBtnEnabled('btnPrev', total > 0 && state.idx > 0);
  setBtnEnabled('btnNext', total > 0 && state.idx < total - 1);
  setBtnEnabled('btnLast', total > 0 && state.idx < total - 1);
  setBtnEnabled('btnDelete', !!cur);
  setBtnEnabled('btnSave', !!cur);

  if (!cur) {
    if (info) info.textContent = 'Sin casos';
    if (fecha) fecha.value = '';
    if (mtSel) mtSel.value = '';
    if (det) det.value = '';
    if (detLugar) detLugar.value = '';

    if (nPersonas) nPersonas.value = 0;
    if (nMujeres) nMujeres.value = 0;
    if (nHombres) nHombres.value = 0;
    if (nMenores) nMenores.value = 0;
    setChecked('contextualType', false, true);
    applyContextualVisual(false);

    renderSubtiposBadges({ subtipos: [] });
    renderPueblosBadges({ pueblo: [] }, state.supabase);
    const selMacroactor0 = qs('selectMacroactor');
    if (selMacroactor0) selMacroactor0.value = '';
    renderMicroactoresBadges({ microactores: [] }, state.supabase);
    renderTerritorioUI([], [], [], state.supabase);
    renderPersonas([]);
    return;
  }

  if (info) {
    info.textContent = `Caso ${state.idx + 1} / ${total}`;
    info.className = 'h4 fw-bold text-info';
    info.onclick = () => console.log(`Caso ${state.idx + 1} / ${total} · ID ${cur.id}`);
  }
  if (fecha) fecha.value = cur.fecha_evento ? String(cur.fecha_evento).slice(0, 10) : '';
  if (mtSel) mtSel.value = cur.macrotipo || '';
  if (det) det.value = cur.detalle || '';
  if (detLugar) detLugar.value = cur.detalle_lugar || '';

  if (fuenteEl) fuenteEl.value = cur.fuente || '';
  if (fechaFuenteEl) fechaFuenteEl.value = cur.fechafuente ? String(cur.fechafuente).slice(0, 10) : '';
  if (enlaceFuenteEl) enlaceFuenteEl.value = cur.enlace || '';
  if (contextualEl) contextualEl.value = cur.contextual_info || '';
  setChecked('contextualType', boolValue(cur.contextual_type), false);
  applyContextualVisual(boolValue(cur.contextual_type));
  if (btnOpenFuente) {
    const url = (cur.enlace || '').trim();
    btnOpenFuente.disabled = !url;
  }

  if (selMacroactor) selMacroactor.value = cur.macroactor || '';
  renderMicroactoresBadges(cur, state.supabase);

  if (nPersonas) nPersonas.value = Number(cur.npersonas ?? 0);
  if (nMujeres) nMujeres.value = Number(cur.nmujeres ?? 0);
  if (nHombres) nHombres.value = Number(cur.nhombres ?? 0);
  if (nMenores) nMenores.value = Number(cur.nmenores ?? 0);

  renderSubtiposBadges(cur);
  renderPueblosBadges(cur, state.supabase);
}

function renderSubtiposBadges(cur) {
  const host = qs('subtiposBadges');
  if (!host) return;
  host.innerHTML = '';
  const arr = Array.isArray(cur?.subtipos) ? cur.subtipos : [];
  if (!arr.length) {
    host.appendChild(el('span', { class: 'text-muted small', text: '— Sin subtipos —' }));
    return;
  }
  for (const st of arr) {
    host.appendChild(el('span', { class: 'badge text-bg-secondary', text: st }));
  }
}

function renderPueblosBadges(cur, supabaseClient) {
  const host = qs('pueblosBadges');
  if (!host) return;
  host.innerHTML = '';
  const arr = Array.isArray(cur?.pueblo) ? cur.pueblo : [];
  if (!arr.length) {
    host.appendChild(el('span', { class: 'text-muted small', text: '— Sin pueblos —' }));
    return;
  }

  for (const p of arr) {
    const badge = el('span', { class: 'badge text-bg-success d-inline-flex align-items-center', text: p });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-close btn-close-white';
    close.title = 'Quitar';
    close.setAttribute('aria-label', 'Quitar');
    close.addEventListener('click', async () => {
      if (!supabaseClient) return;
      await removePueblo(supabaseClient, p);
    });

    badge.appendChild(close);
    host.appendChild(badge);
  }
}


// ---------- MICROACTORES (UI) ----------
function renderMicroactoresBadges(cur, supabaseClient) {
  const host = qs('microactoresBadges');
  if (!host) return;
  host.innerHTML = '';
  const arr = Array.isArray(cur?.microactores) ? cur.microactores : [];
  if (!arr.length) {
    host.appendChild(el('span', { class: 'text-muted small', text: '— Sin microactores —' }));
    return;
  }

  for (const a of arr) {
    const badge = el('span', { class: 'badge text-bg-dark d-inline-flex align-items-center', text: a });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-close btn-close-white';
    close.title = 'Quitar';
    close.setAttribute('aria-label', 'Quitar');
    close.addEventListener('click', async () => {
      if (!supabaseClient) return;
      await removeMicroactor(supabaseClient, a);
    });

    badge.appendChild(close);
    host.appendChild(badge);
  }
}

// ---------- ACTORES (guardar en casos_2026) ----------
async function saveMicroactores(supabaseClient, newArr) {
  const cur = getCurrentCase();
  if (!cur) return;

  const seen = new Set();
  const clean = [];
  for (const x of (newArr || [])) {
    const v = String(x || '').trim();
    if (!v) continue;
    const k = normLocal(v);
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(v);
  }

  const { error } = await supabaseClient
    .from(TBL_CASOS)
    .update({ microactores: clean })
    .eq('id', cur.id);

  if (error) {
    console.error('saveMicroactores:', error);
    showAlert('danger', error.message || 'No se pudo guardar microactores');
    return;
  }

  state.cases[state.idx].microactores = clean;
  renderMicroactoresBadges(state.cases[state.idx], supabaseClient);
}

async function addMicroactor(supabaseClient) {
  const cur = getCurrentCase();
  const sel = qs('microactorNew');
  if (!cur || !sel) return;

  const v = (sel.value || '').trim();
  if (!v) return;

  const arr = Array.isArray(cur.microactores) ? [...cur.microactores] : [];
  if (arr.some(x => normLocal(x) === normLocal(v))) {
    sel.value = '';
    return;
  }

  arr.push(v);
  sel.value = '';
  await saveMicroactores(supabaseClient, arr);
}

async function removeMicroactor(supabaseClient, microTxt) {
  const cur = getCurrentCase();
  if (!cur) return;
  const arr = Array.isArray(cur.microactores) ? cur.microactores : [];
  const next = arr.filter(x => normLocal(x) !== normLocal(microTxt));
  await saveMicroactores(supabaseClient, next);
}

async function updateMacroactorAuto(supabaseClient) {
  const cur = getCurrentCase();
  const sel = qs('selectMacroactor');
  if (!cur || !sel) return;

  const newVal = (sel.value || '').trim() || null;
  const { error } = await supabaseClient
    .from(TBL_CASOS)
    .update({ macroactor: newVal })
    .eq('id', cur.id);

  if (error) {
    console.error('update macroactor', error);
    showAlert('danger', error.message || 'No se pudo actualizar macroactor');
    sel.value = cur.macroactor || '';
    return;
  }

  state.cases[state.idx].macroactor = newVal;
  showAlert('success', 'macroactor actualizado');
  await loadMicroactoresCatalog(qs('microactorNew'), supabaseClient, newVal);
}

// ---------- ACTORES (catálogos) ----------
function pickActorLabel(row) {
  if (!row || typeof row !== 'object') return '';
  const keys = ['actor', 'nombre', 'microactor', 'macroactor', 'label', 'titulo', 'name'];
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim()) return String(row[k]).trim();
  }
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue;
    if (v != null && typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

async function loadMacroactoresCatalog(sel, supabaseClient) {
  if (!sel) return [];
  sel.innerHTML = `<option value="">Cargando…</option>`;

  const { data, error } = await supabaseClient
    .from(TBL_MACROACTOR)
    .select('*');

  if (error) {
    console.error('loadMacroactoresCatalog', error);
    showAlert('danger', error.message || 'No se pudo cargar macroactores');
    sel.innerHTML = `<option value="">Error</option>`;
    return [];
  }

  const list = (data || []).map(r => pickActorLabel(r)).filter(Boolean);
  const seen = new Set();
  const clean = [];
  for (const x of list) {
    const k = normLocal(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    clean.push(x);
  }
  clean.sort((a, b) => a.localeCompare(b, 'es'));

  sel.innerHTML = `<option value="">— Selecciona —</option>` + clean.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  return clean;
}

async function loadMicroactoresCatalog(sel, supabaseClient, macroactorVal = null) {
  if (!sel) return [];
  sel.innerHTML = `<option value="">Cargando…</option>`;

  let data = null;
  let error = null;

  if (macroactorVal) {
    const attempts = [
      { col: 'macroactor', val: macroactorVal },
      { col: 'macro_actor', val: macroactorVal },
      { col: 'macroactor_nombre', val: macroactorVal },
    ];
    for (const a of attempts) {
      const res = await supabaseClient
        .from(TBL_ACTORES)
        .select('*')
        .eq(a.col, a.val);
      if (!res.error) {
        data = res.data;
        error = null;
        break;
      }
      const msg = String(res.error?.message || '');
      if (!/Could not find the .* column|column .* does not exist|schema cache/i.test(msg)) {
        error = res.error;
        break;
      }
    }
  }

  if (!data && !error) {
    const resAll = await supabaseClient
      .from(TBL_ACTORES)
      .select('*');
    data = resAll.data;
    error = resAll.error;
  }

  if (error) {
    console.error('loadMicroactoresCatalog', error);
    showAlert('danger', error.message || 'No se pudo cargar microactores');
    sel.innerHTML = `<option value="">Error</option>`;
    return [];
  }

  const list = (data || []).map(r => pickActorLabel(r)).filter(Boolean);
  const seen = new Set();
  const clean = [];
  for (const x of list) {
    const k = normLocal(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    clean.push(x);
  }
  clean.sort((a, b) => a.localeCompare(b, 'es'));

  sel.innerHTML = `<option value="">— Selecciona —</option>` + clean.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  return clean;
}


// ---------- PUEBLOS ----------
async function savePueblos(supabaseClient, newArr) {
  const cur = getCurrentCase();
  if (!cur) return;

  const seen = new Set();
  const clean = [];
  for (const x of (newArr || [])) {
    const v = String(x || '').trim();
    if (!v) continue;
    const k = normLocal(v);
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(v);
  }

  const { error } = await supabaseClient
    .from(TBL_CASOS)
    .update({ pueblo: clean })
    .eq('id', cur.id);

  if (error) {
    console.error('savePueblos:', error);
    showAlert('danger', error.message || 'No se pudo guardar pueblos');
    return;
  }

  state.cases[state.idx].pueblo = clean;
  renderPueblosBadges(state.cases[state.idx], supabaseClient);
}

async function addPueblo(supabaseClient) {
  const cur = getCurrentCase();
  const sel = qs('puebloNew');
  if (!cur || !sel) return;

  const v = (sel.value || '').trim();
  if (!v) return;

  const arr = Array.isArray(cur.pueblo) ? [...cur.pueblo] : [];
  if (arr.some(x => normLocal(x) === normLocal(v))) {
    sel.value = '';
    return;
  }

  arr.push(v);
  sel.value = '';
  await savePueblos(supabaseClient, arr);
}

async function removePueblo(supabaseClient, puebloTxt) {
  const cur = getCurrentCase();
  if (!cur) return;
  const arr = Array.isArray(cur.pueblo) ? cur.pueblo : [];
  const next = arr.filter(x => normLocal(x) !== normLocal(puebloTxt));
  await savePueblos(supabaseClient, next);
}

// ---------- TERRITORIO UI ----------
function renderTerritorioUI(deptos, macros, lugares, supabaseClient) {
  const deptInfo = qs('caseDeptInfo');
  const macroInfo = qs('caseMacroInfo');
  if (deptInfo) deptInfo.textContent = 'Departamentos: ' + (deptos?.length ? deptos.join(', ') : '—');
  if (macroInfo) macroInfo.textContent = 'Macroregiones: ' + (macros?.length ? macros.join(', ') : '—');

  const host = qs('lugaresBadges');
  if (!host) return;
  host.innerHTML = '';

  if (!lugares?.length) {
    host.appendChild(el('span', { class: 'text-muted small', text: '— Sin municipios —' }));
    return;
  }

  for (const it of lugares) {
    const dep = it.departamento || '—';
    const mp = it.municipio || '—';
    const municipioTxt = it.municipio || mp;

    const badge = el('span', { class: 'badge text-bg-primary d-inline-flex align-items-center', text: `${dep} · ${mp}` });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-close btn-close-white';
    close.title = 'Quitar';
    close.setAttribute('aria-label', 'Quitar');
    close.addEventListener('click', async () => {
      if (!supabaseClient) return;
      await removeMunicipioFromCaso(supabaseClient, municipioTxt);
    });

    badge.appendChild(close);
    host.appendChild(badge);
  }
}

async function refreshTerritorioRPC(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) {
    renderTerritorioUI([], [], [], supabaseClient);
    return;
  }

  const { data, error } = await supabaseClient
    .from(TBL_CASO_MUNI)
    .select(`${COL_MUNICIPIO_TXT}, lat, lng`)
    .eq(COL_CASO_ID, cur.id);

  if (error) {
    console.error('refreshTerritorio local', error);
    showAlert('danger', error.message || 'No se pudo cargar territorio');
    renderTerritorioUI([], [], [], supabaseClient);
    return;
  }

  const muniIndex = await ensureMunicipiosFullIndex(supabaseClient);
  const deptos = [];
  const macros = [];
  const deptoSeen = new Set();
  const macroSeen = new Set();

  const lugares = (data || []).map(r => {
    const municipio = String(r[COL_MUNICIPIO_TXT] || '').trim();
    const muniRow = muniIndex.get(normLocal(municipio));
    let depto = muniRow?.departamento_id ? getDeptoByAny(muniRow.departamento_id) : null;
    const muniDepTxt = pickMunicipioDepartamento(muniRow);
    if (!depto && muniDepTxt) depto = getDeptoByAny(muniDepTxt);

    const departamento = depto?.departamento || pickMunicipioDepartamento(muniRow) || '—';
    const macroregion = depto?.macroregion || null;

    if (departamento && departamento !== '—') {
      const k = normLocal(departamento);
      if (!deptoSeen.has(k)) {
        deptoSeen.add(k);
        deptos.push(departamento);
      }
    }

    if (macroregion) {
      const k = normLocal(macroregion);
      if (!macroSeen.has(k)) {
        macroSeen.add(k);
        macros.push(macroregion);
      }
    }

    return {
      municipio,
      departamento,
      macroregion,
      lat: r.lat ?? muniRow?.lat ?? null,
      lng: r.lng ?? muniRow?.lng ?? null,
    };
  }).filter(x => x.municipio);

  renderTerritorioUI(deptos, macros, lugares, supabaseClient);
}

// ----------------- LOADERS -----------------
async function loadYears(selYear, supabaseClient) {
  selYear.innerHTML = `<option value="">Cargando…</option>`;
  const { data, error } = await supabaseClient.rpc(RPC_ANIOS);
  if (error) {
    console.error(RPC_ANIOS, error);
    showAlert('danger', error.message || 'Error años');
    selYear.innerHTML = `<option value="">Error</option>`;
    return [];
  }
  const years = (data || [])
    .map(x => (typeof x === 'object' ? (x.anio ?? x.year ?? x.y ?? x.ano) : x))
    .map(y => String(y))
    .filter(Boolean)
    .sort((a, b) => Number(b) - Number(a));
  selYear.innerHTML = '';
  if (!years.length) { selYear.appendChild(new Option('Sin años', '')); return []; }
  for (const y of years) selYear.appendChild(new Option(y, y));
  return years;
}

async function loadMacrotipos(selMacro, supabaseClient) {
  selMacro.innerHTML = `<option value="">Cargando…</option>`;
  const { data, error } = await supabaseClient.rpc(RPC_MACROTIPOS);
  if (error) {
    console.error(RPC_MACROTIPOS, error);
    showAlert('danger', error.message || 'Error macrotipos');
    selMacro.innerHTML = `<option value="">Error</option>`;
    return;
  }
  const list = (data || [])
    .map(x => ({ value: String(x?.value ?? x?.tipos ?? x?.label ?? '').trim(), label: String(x?.label ?? x?.value ?? x?.tipos ?? '').trim() }))
    .filter(x => x.value);
  selMacro.innerHTML = '';
  selMacro.appendChild(new Option('— Selecciona —', ''));
  for (const it of list) selMacro.appendChild(new Option(it.label, it.value));
}

async function loadSubtiposCatalog(sel, supabaseClient) {
  if (!sel) return;
  sel.innerHTML = `<option value="">Cargando…</option>`;
  const { data, error } = await supabaseClient
    .from(TBL_TIPOS)
    .select('tipos')
    .not('tipos', 'is', null)
    .order('tipos', { ascending: true });
  if (error) {
    console.error('loadSubtiposCatalog', error);
    showAlert('danger', error.message || 'Error lista subtipos');
    sel.innerHTML = `<option value="">Error</option>`;
    return;
  }
  const seen = new Set();
  const unique = [];
  for (const row of (data || [])) {
    const v = String(row.tipos || '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(v);
  }
  sel.innerHTML = '';
  sel.appendChild(new Option('— Selecciona —', ''));
  for (const v of unique) sel.appendChild(new Option(v, v));
}

async function loadPueblosCatalog(sel, supabaseClient) {
  if (!sel) return [];
  sel.innerHTML = `<option value="">Cargando…</option>`;

  const { data, error } = await supabaseClient
    .from(TBL_PUEBLOS)
    .select('*');

  if (error) {
    console.error('loadPueblosCatalog', error);
    showAlert('danger', error.message || 'No se pudo cargar pueblos');
    sel.innerHTML = `<option value="">Error</option>`;
    state.pueblosCatalog = [];
    return [];
  }

  const list = (data || [])
    .map(r => pickPuebloLabel(r))
    .filter(Boolean);

  const seen = new Set();
  const clean = [];
  for (const x of list) {
    const k = normLocal(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    clean.push(x);
  }
  clean.sort((a, b) => a.localeCompare(b, 'es'));

  state.pueblosCatalog = clean;

  sel.innerHTML = `<option value="">— Selecciona —</option>` + clean.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  return clean;
}


function pickMunicipioNombre(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.nombre ?? row.municipio ?? row.name ?? '').trim();
}

function pickMunicipioDepartamento(row) {
  if (!row || typeof row !== 'object') return '';
  // Tu esquema actual usa public.municipios.departamentos (plural).
  // Dejamos también departamento como respaldo por si en otra versión cambias el nombre.
  return String(row.departamentos ?? row.departamento ?? row.departamento_nombre ?? '').trim();
}

function getDeptoByAny(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return state.deptoMap.get(raw) || state.deptoNameMap.get(normLocal(raw)) || null;
}

async function fetchMunicipiosRows(supabaseClient, departamento_id) {
  const depto = getDeptoByAny(departamento_id);
  const deptoName = String(depto?.departamento || '').trim();
  const rowsByKey = new Map();

  const addRows = (rows) => {
    (rows || []).forEach(r => {
      const nombre = pickMunicipioNombre(r);
      if (!nombre) return;
      const depId = String(r.departamento_id || '').trim();
      const depTxt = pickMunicipioDepartamento(r);
      const matchesById = departamento_id && depId && String(depId) === String(departamento_id);
      const matchesByText = deptoName && depTxt && normLocal(depTxt) === normLocal(deptoName);
      if (matchesById || matchesByText) {
        const key = String(r.id || `${nombre}__${depId || depTxt}`).trim();
        rowsByKey.set(key, r);
      }
    });
  };

  // Intento 1: relación normal por departamento_id.
  if (departamento_id) {
    const res = await supabaseClient
      .from(TBL_MUNIS)
      .select('*')
      .eq('departamento_id', departamento_id);
    if (!res.error) addRows(res.data || []);
    else console.warn('municipios por departamento_id falló; se intenta por texto:', res.error.message || res.error);
  }

  // Intento 2: relación por texto del departamento.
  // IMPORTANTE: tu esquema actual usa public.municipios.departamentos (plural).
  // No consultar "departamento" porque esa columna NO existe y produce 400 Bad Request.
  if (!rowsByKey.size && deptoName) {
    const res = await supabaseClient
      .from(TBL_MUNIS)
      .select('*')
      .ilike('departamentos', deptoName);

    if (!res.error) {
      addRows(res.data || []);
    } else {
      console.warn('municipios por departamentos falló; se intenta carga general:', res.error.message || res.error);
    }
  }

  // Intento 3: carga general y filtro local normalizado.
  if (!rowsByKey.size && (departamento_id || deptoName)) {
    const res = await supabaseClient
      .from(TBL_MUNIS)
      .select('*')
      .limit(5000);
    if (!res.error) addRows(res.data || []);
    else throw res.error;
  }

  return Array.from(rowsByKey.values()).sort((a, b) =>
    pickMunicipioNombre(a).localeCompare(pickMunicipioNombre(b), 'es')
  );
}

async function ensureMunicipiosFullIndex(supabaseClient) {
  if (state.municipiosFullByName) return state.municipiosFullByName;

  const map = new Map();
  const { data, error } = await supabaseClient
    .from(TBL_MUNIS)
    .select('*')
    .limit(5000);

  if (error) {
    console.error('ensureMunicipiosFullIndex', error);
    state.municipiosFullByName = map;
    return map;
  }

  (data || []).forEach(r => {
    const nombre = pickMunicipioNombre(r);
    if (!nombre) return;
    const k = normLocal(nombre);
    if (!map.has(k)) map.set(k, r);
  });

  state.municipiosFullByName = map;
  return map;
}

async function loadDepartamentosCatalog(sel, supabaseClient) {
  if (!sel) return;
  sel.innerHTML = `<option value="">Cargando…</option>`;

  const { data, error } = await supabaseClient
    .from(TBL_DEPTOS)
    .select('id, departamento, macroregion')
    .order('departamento', { ascending: true });

  if (error) {
    console.error('loadDepartamentosCatalog', error);
    showAlert('danger', error.message || 'Error departamentos');
    sel.innerHTML = `<option value="">Error</option>`;
    return;
  }

  state.departamentos = data || [];
  state.deptoMap = new Map((state.departamentos || []).map(d => [String(d.id), d]));
  state.deptoNameMap = new Map((state.departamentos || []).map(d => [normLocal(d.departamento), d]));

  sel.innerHTML = '';
  sel.appendChild(new Option('— Departamento —', ''));
  for (const d of state.departamentos) sel.appendChild(new Option(d.departamento, d.id));
  sel.value = '';
  updateDeptoMacroInfo(sel.value);
}

function updateDeptoMacroInfo(departamento_id) {
  const d = getDeptoByAny(departamento_id);
  const elInfo = qs('deptoMacroInfo');
  if (elInfo) elInfo.textContent = 'Macroregión (depto): ' + (d?.macroregion || '—');
}

async function loadMunicipiosCatalog(sel, supabaseClient, departamento_id) {
  if (!sel) return;
  state.municipiosByValue = new Map();

  if (!departamento_id) {
    sel.innerHTML = `<option value="">Selecciona un departamento</option>`;
    return;
  }

  sel.innerHTML = `<option value="">Cargando…</option>`;

  try {
    const rows = await fetchMunicipiosRows(supabaseClient, departamento_id);

    sel.innerHTML = '';
    sel.appendChild(new Option('— Municipio —', ''));

    if (!rows.length) {
      sel.appendChild(new Option('(Sin municipios para este departamento)', ''));
      const d = getDeptoByAny(departamento_id);
      showAlert('warning', `No se encontraron municipios para ${d?.departamento || 'el departamento seleccionado'}. Revisa que public.municipios.departamento_id tenga el uuid correcto o que public.municipios.departamentos coincida con el nombre del departamento.`);
      return;
    }

    for (const m of rows) {
      const nombre = pickMunicipioNombre(m);
      const value = String(m.id || `${nombre}__${m.departamento_id || pickMunicipioDepartamento(m) || ''}`).trim();
      state.municipiosByValue.set(value, m);
      sel.appendChild(new Option(nombre, value));
    }

    sel.value = '';
  } catch (error) {
    console.error('loadMunicipiosCatalog', error);
    showAlert('danger', error.message || 'Error cargando municipios');
    sel.innerHTML = `<option value="">Error</option>`;
  }
}

async function loadCasesForYear(year, supabaseClient, opts = {}) {
  const { focusId = null, goLast = true } = opts;

  state.year = year;

  let q = supabaseClient
    .from(TBL_CASOS)
    .select(CASE_SELECT_COLUMNS)
    .order('fecha_evento', { ascending: true });

  if (year) q = q.gte('fecha_evento', `${year}-01-01`).lte('fecha_evento', `${year}-12-31`);

  const { data, error } = await q;
  if (error) {
    console.error('loadCasesForYear', error);
    showAlert('danger', error.message || 'Error cargando casos');
    state.cases = [];
    await setIndex(-1, supabaseClient);
    return;
  }

  state.cases = (data || []).map(r => ({
    ...r,
    subtipos: normalizeArrayStrings(r.subtipos),
    microactores: normalizeArrayStrings(r.microactores),
    fuente: r.fuente ?? null,
    fechafuente: r.fechafuente ?? null,
    enlace: r.enlace ?? null,
    contextual_info: r.contextual_info ?? null,
    contextual_type: boolValue(r.contextual_type),
    npersonas: Number(r.npersonas ?? 0),
    nmujeres: Number(r.nmujeres ?? 0),
    nhombres: Number(r.nhombres ?? 0),
    nmenores: Number(r.nmenores ?? 0),
  }));


  await buildTerritorioIndexForYear(supabaseClient);
  viewAll();
  updateAuditInfoUI();
  let idx = -1;
  if (focusId) {
    const i = state.cases.findIndex(c => String(c.id) === String(focusId));
    idx = i >= 0 ? i : (state.cases.length - 1);
  } else if (goLast) {
    idx = state.cases.length - 1;
  } else {
    idx = Math.min(state.idx, state.cases.length - 1);
  }

  await setIndex(idx, supabaseClient);
}

// ----------------- UPDATES -----------------
async function updateMacrotipoAuto(supabaseClient) {
  const cur = getCurrentCase();
  const sel = qs('selectMacrotipo');
  if (!cur || !sel) return;

  const newVal = sel.value || null;
  const { error } = await supabaseClient.from(TBL_CASOS).update({ macrotipo: newVal }).eq('id', cur.id);
  if (error) {
    console.error('update macrotipo', error);
    showAlert('danger', error.message || 'No se pudo actualizar macrotipo');
    sel.value = cur.macrotipo || '';
    return;
  }
  state.cases[state.idx].macrotipo = newVal;
  showAlert('success', 'macrotipo actualizado');
}

async function updateDetalleAuto(supabaseClient, expectedId = null) {
  const cur = getCurrentCase();
  const ta = qs('detalle');
  if (!cur || !ta) return;
  if (expectedId && String(cur.id) !== String(expectedId)) return;

  const newText = ta.value ?? '';
  const newVal = newText.trim() === '' ? null : newText;
  const oldVal = cur.detalle ?? null;
  if (newVal === oldVal) return;

  const { error } = await supabaseClient.from(TBL_CASOS).update({ detalle: newVal }).eq('id', cur.id);
  if (error) {
    console.error('update detalle', error);
    showAlert('danger', error.message || 'No se pudo actualizar detalle');
    ta.value = oldVal || '';
    return;
  }
  state.cases[state.idx].detalle = newVal;
}

function readInt(id) {
  const n = Number(qs(id)?.value ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

async function saveFechaEvento(supabaseClient) {
  const cur = getCurrentCase();
  const input = qs('fechaEvento');
  if (!cur || !input) return;

  const newDate = input.value || null;
  if (!newDate) {
    showAlert('warning', 'Define fecha_evento');
    return;
  }

  const mtSel = qs('selectMacrotipo');
  const det = qs('detalle');

  const payload = {
    fecha_evento: newDate,
    macrotipo: (mtSel ? (mtSel.value || null) : (cur.macrotipo || null)),
    detalle: (det ? (det.value.trim() || null) : (cur.detalle || null)),
    subtipos: Array.isArray(cur.subtipos) ? cur.subtipos : [],
    contextual_type: !!qs('contextualType')?.checked,
    npersonas: readInt('npersonas'),
    nmujeres: readInt('nmujeres'),
    nhombres: readInt('nhombres'),
    nmenores: readInt('nmenores'),
  };

  const { error } = await supabaseClient.from(TBL_CASOS).update(payload).eq('id', cur.id);
  if (error) {
    console.error('save', error);
    showAlert('danger', error.message || 'No se pudo guardar');
    return;
  }
  updateCurrentCasePatch(payload);
  showAlert('success', 'Guardado');
  await loadCasesForYear(state.year, supabaseClient, { focusId: cur.id, goLast: false });
}

async function addCase(supabaseClient) {
  const y = state.year;
  const defaultDate = y ? `${y}-12-31` : new Date().toISOString().slice(0, 10);

  const { data, error } = await supabaseClient
    .from(TBL_CASOS)
    .insert({
      fecha_evento: defaultDate,
      npersonas: 0,
      nmujeres: 0,
      nhombres: 0,
      nmenores: 0,
      macroactor: null,
      microactores: [],
      contextual_type: false,
    })
    .select('id')
    .single();

  if (error) {
    console.error('addCase', error);
    showAlert('danger', error.message || 'No se pudo agregar');
    return;
  }

  showAlert('success', 'Caso agregado');
  await loadCasesForYear(state.year, supabaseClient, { focusId: data?.id, goLast: true });
}

async function deleteCase(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) return;

  const ok = confirm('¿Borrar este caso?');
  if (!ok) return;

  const { error } = await supabaseClient.from(TBL_CASOS).delete().eq('id', cur.id);
  if (error) {
    console.error('deleteCase', error);
    showAlert('danger', error.message || 'No se pudo borrar');
    return;
  }

  showAlert('success', 'Caso borrado');
  await loadCasesForYear(state.year, supabaseClient, { goLast: true });
}

// ----------------- SUBTIPOS -----------------
function renderSubtiposModal(supabaseClient) {
  const cur = getCurrentCase();
  const list = qs('subtiposList');
  if (!list) return;
  list.innerHTML = '';

  if (!cur) {
    list.innerHTML = `<div class="text-muted small">Sin caso seleccionado</div>`;
    return;
  }

  const arr = Array.isArray(cur.subtipos) ? cur.subtipos : [];
  if (!arr.length) {
    list.innerHTML = `<div class="text-muted small">No hay subtipos. Agrega uno arriba.</div>`;
    return;
  }

  for (const st of arr) {
    const row = el('div', { class: 'list-group-item d-flex align-items-center justify-content-between' }, []);
    const label = el('div', { class: 'me-2 flex-grow-1', text: st });
    const btn = el('button', { class: 'btn btn-outline-danger btn-sm', type: 'button', title: 'Quitar', 'aria-label': 'Quitar' }, [
      el('i', { class: 'bi bi-x-lg' })
    ]);
    btn.addEventListener('click', async () => removeSubtipo(supabaseClient, st));
    row.append(label, btn);
    list.appendChild(row);
  }
}

async function saveSubtipos(supabaseClient, newArr) {
  const cur = getCurrentCase();
  if (!cur) return;

  const clean = Array.from(new Set((newArr || []).map(x => String(x).trim()).filter(x => x)));
  const { error } = await supabaseClient.from(TBL_CASOS).update({ subtipos: clean }).eq('id', cur.id);
  if (error) {
    console.error('update subtipos', error);
    showAlert('danger', error.message || 'No se pudo actualizar subtipos');
    return;
  }

  state.cases[state.idx].subtipos = clean;
  renderSubtiposBadges(state.cases[state.idx]);
  renderSubtiposModal(supabaseClient);
}

async function addSubtipo(supabaseClient) {
  const cur = getCurrentCase();
  const sel = qs('subtipoNew');
  if (!cur || !sel) return;

  const v = (sel.value || '').trim();
  if (!v) return;

  const arr = Array.isArray(cur.subtipos) ? [...cur.subtipos] : [];
  if (arr.some(x => String(x).toLowerCase() === v.toLowerCase())) {
    sel.value = '';
    return;
  }

  arr.push(v);
  sel.value = '';
  await saveSubtipos(supabaseClient, arr);
}

async function removeSubtipo(supabaseClient, value) {
  const cur = getCurrentCase();
  if (!cur) return;
  const arr = Array.isArray(cur.subtipos) ? cur.subtipos.filter(x => x !== value) : [];
  await saveSubtipos(supabaseClient, arr);
}

// ----------------- TERRITORIAL

// ----------------- TERRITORIAL (tabla puente actual) -----------------
async function addMunicipioToCaso(supabaseClient) {
  const cur = getCurrentCase();
  const selMpio = qs('selectMunicipio');
  if (!cur || !selMpio) return;

  const selectedValue = (selMpio.value || '').trim();
  if (!selectedValue) {
    showAlert('warning', 'Selecciona un municipio');
    return;
  }

  let muniData = state.municipiosByValue.get(selectedValue) || null;

  // Respaldo por si se perdió el mapa local del select.
  if (!muniData) {
    const res = await supabaseClient
      .from(TBL_MUNIS)
      .select('*')
      .eq('id', selectedValue)
      .maybeSingle();
    if (!res.error && res.data) muniData = res.data;
  }

  if (!muniData) {
    showAlert('danger', 'No se pudo leer el municipio seleccionado. Vuelve a seleccionar el departamento.');
    return;
  }

  const municipioTxt = pickMunicipioNombre(muniData);
  if (!municipioTxt) {
    showAlert('danger', 'El municipio seleccionado no trae nombre');
    return;
  }

  const latNum = Number(muniData?.lat);
  const lngNum = Number(muniData?.lng);

  const payload = {
    [COL_CASO_ID]: cur.id,
    [COL_MUNICIPIO_TXT]: municipioTxt,
    lat: Number.isFinite(latNum) ? latNum : null,
    lng: Number.isFinite(lngNum) ? lngNum : null,
  };

  const { error } = await supabaseClient
    .from(TBL_CASO_MUNI)
    .insert(payload);

  if (error) {
    console.error('addMunicipioToCaso:', error);
    if (String(error.code) === '23505') {
      showAlert('warning', 'Ese municipio ya está agregado');
      selMpio.value = '';
      return;
    }
    showAlert('danger', error.message || 'No se pudo agregar municipio');
    return;
  }

  showAlert('success', 'Municipio agregado');
  selMpio.value = '';
  state.municipiosFullByName = null;
  state.muniDeptoMap = null;
  await refreshTerritorioRPC(supabaseClient);
  await buildTerritorioIndexForYear(supabaseClient);
}

async function removeMunicipioFromCaso(supabaseClient, municipioTxt) {
  const cur = getCurrentCase();
  if (!cur) return;

  const municipio = String(municipioTxt || '').trim();
  if (!municipio) {
    showAlert('warning', 'Municipio inválido para borrar');
    return;
  }

  const { error } = await supabaseClient
    .from(TBL_CASO_MUNI)
    .delete()
    .eq(COL_CASO_ID, cur.id)
    .eq(COL_MUNICIPIO_TXT, municipio);

  if (error) {
    console.error('removeMunicipioFromCaso', error);
    showAlert('danger', error.message || 'No se pudo quitar municipio');
    return;
  }

  showAlert('success', 'Municipio quitado');
  await refreshTerritorioRPC(supabaseClient);
}







async function updateContextualTypeAuto(supabaseClient) {
  const cur = getCurrentCase();
  const input = qs('contextualType');
  if (!cur || !input) return;

  const contextual_type = !!input.checked;
  const previous = boolValue(cur.contextual_type);
  if (contextual_type === previous) {
    applyContextualVisual(previous);
    return;
  }

  input.disabled = true;
  applyContextualVisual(contextual_type);

  const { error } = await supabaseClient
    .from(TBL_CASOS)
    .update({ contextual_type })
    .eq('id', cur.id);

  input.disabled = false;

  if (error) {
    console.error('update contextual_type', error);
    showAlert('danger', error.message || 'No se pudo actualizar contextual_type');
    setChecked('contextualType', previous, false);
    applyContextualVisual(previous);
    return;
  }

  updateCurrentCasePatch({ contextual_type });
  showAlert('success', contextual_type ? 'Caso marcado como contextual' : 'Caso marcado como no contextual');
}

// ----------------- FUENTE + CONTEXTO -----------------
async function updateFuenteAuto(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) return;

  const fuente = (qs('fuente')?.value || '').trim() || null;
  const fechafuente = qs('fechaFuente') ? (qs('fechaFuente').value || null) : null;
  const enlace = (qs('enlaceFuente')?.value || '').trim() || null;

  const { error } = await supabaseClient
    .from(TBL_CASOS)
    .update({ fuente, fechafuente, enlace })
    .eq('id', cur.id);

  if (error) {
    console.error('updateFuenteAuto', error);
    showAlert('danger', error.message || 'No se pudo guardar fuente');
    return;
  }

  updateCurrentCasePatch({ fuente, fechafuente, enlace });

  const btn = qs('btnOpenFuente');
  if (btn) btn.disabled = !((enlace || '').trim());
}

async function updateContextualInfoAuto(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) return;

  const contextual_info = (qs('contextualInfo')?.value || '').trim() || null;

  const { error } = await supabaseClient
    .from(TBL_CASOS)
    .update({ contextual_info })
    .eq('id', cur.id);

  if (error) {
    console.error('updateContextualInfoAuto', error);
    showAlert('danger', error.message || 'No se pudo guardar contextual_info');
    return;
  }

  updateCurrentCasePatch({ contextual_info });
}

function openFuenteInNewTab() {
  const cur = getCurrentCase();
  let url = (cur?.enlace || (qs('enlaceFuente') ? qs('enlaceFuente').value : '') || '').trim();
  if (!url) return;

  // Asegurar protocolo para que el navegador no lo trate como ruta relativa
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) {
    showAlert('warning', 'El navegador bloqueó la apertura de la pestaña. Permite pop-ups para este sitio.');
  }
}

// ----------------- DESPLAZAMIENTO (1 por caso) -----------------
function clearDesplazamientoForm() {
  const ids = ['des_tipo', 'des_fecha_des', 'des_lugar_des', 'des_entorno_des', 'des_fecha_ori', 'des_lugar_ori', 'des_entorno_ori'];
  ids.forEach(id => { const n = qs(id); if (n) n.value = ''; });
}

function fillDesplazamientoForm(row) {
  const eTipo = qs('des_tipo');
  if (eTipo) eTipo.value = (row?.tipo || '');

  const eFechaDes = qs('des_fecha_des');
  if (eFechaDes) eFechaDes.value = row?.fecha_des ? String(row.fecha_des).slice(0, 10) : '';

  const eLugarDes = qs('des_lugar_des');
  if (eLugarDes) eLugarDes.value = (row?.lugar_des || '');

  const eEntornoDes = qs('des_entorno_des');
  if (eEntornoDes) eEntornoDes.value = (row?.entorno_des || '');

  const eFechaOri = qs('des_fecha_ori');
  if (eFechaOri) eFechaOri.value = row?.fecha_ori ? String(row.fecha_ori).slice(0, 10) : '';

  const eLugarOri = qs('des_lugar_ori');
  if (eLugarOri) eLugarOri.value = (row?.lugar_ori || '');

  const eEntornoOri = qs('des_entorno_ori');
  if (eEntornoOri) eEntornoOri.value = (row?.entorno_ori || '');
}

async function fetchDesplazamientoByCaso(supabaseClient, casoId) {
  const { data, error } = await supabaseClient
    .from(TBL_DESPLAZAMIENTOS)
    .select('*')
    .eq('caso_id', casoId)
    .maybeSingle();

  // maybeSingle: error can happen if multiple rows; but we have unique index.
  if (error) {
    console.error('fetchDesplazamientoByCaso', error);
    showAlert('danger', error.message || 'No se pudo cargar desplazamiento');
    return { row: null, error };
  }
  return { row: data || null, error: null };
}

async function refreshDesplazamientoIndicator(supabaseClient) {
  const cur = getCurrentCase();
  const host = qs('desplazamientoStatus');
  if (!host) {
    return;
  }
  if (!cur) {
    host.textContent = 'Estado: —';
    host.className = 'small mt-1 text-muted';
    return;
  }

  const { row, error } = await fetchDesplazamientoByCaso(supabaseClient, cur.id);
  if (error) {
    host.textContent = 'Estado: error al cargar';
    host.className = 'small mt-1 text-danger';
    return;
  }

  if (!row) {
    host.textContent = 'Estado: sin desplazamiento';
    host.className = 'small mt-1 text-muted';
    return;
  }

  const tipo = row.tipo ? String(row.tipo) : 'registrado';
  const fecha = row.fecha_des ? String(row.fecha_des).slice(0, 10) : 'sin fecha';
  host.textContent = `Estado: ${tipo} · ${fecha}`;
  host.className = 'small mt-1 text-success';
}

async function openDesplazamientoModal(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) return;

  const delBtn = qs('btnDeleteDesplazamiento');
  if (delBtn) delBtn.style.display = 'none';

  clearDesplazamientoForm();

  const { row } = await fetchDesplazamientoByCaso(supabaseClient, cur.id);
  if (row) {
    fillDesplazamientoForm(row);
    if (delBtn) delBtn.style.display = 'inline-block';
  }

  const modalEl = qs('modalDesplazamiento');
  if (!modalEl) {
    showAlert('danger', 'No existe modalDesplazamiento en el HTML');
    return;
  }
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
  await refreshDesplazamientoIndicator(supabaseClient);
}

/*
  const payload = {
    caso_id: casoId,
    tipo: qs('des_tipo')?.value?.trim() || None,
    fecha_des: qs('des_fecha_des')?.value || None,
    lugar_des: qs('des_lugar_des')?.value?.trim() || None,
    entorno_des: qs('des_entorno_des')?.value?.trim() || None,
    fecha_ori: qs('des_fecha_ori')?.value || None,
    lugar_ori: qs('des_lugar_ori')?.value?.trim() || None,
    entorno_ori: qs('des_entorno_ori')?.value?.trim() || None,
  };
  // JS doesn't have None; we replace below
  return payload;
*/

async function saveDesplazamiento(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) return;

  const payload = {
    caso_id: cur.id,
    tipo: (qs('des_tipo')?.value || '').trim() || null,
    fecha_des: qs('des_fecha_des') ? (qs('des_fecha_des').value || null) : null,
    lugar_des: (qs('des_lugar_des')?.value || '').trim() || null,
    entorno_des: (qs('des_entorno_des')?.value || '').trim() || null,
    fecha_ori: qs('des_fecha_ori') ? (qs('des_fecha_ori').value || null) : null,
    lugar_ori: (qs('des_lugar_ori')?.value || '').trim() || null,
    entorno_ori: (qs('des_entorno_ori')?.value || '').trim() || null,
  };

  // 1) Ver si ya existe desplazamiento para este caso
  const { data: existing, error: exErr } = await supabaseClient
    .from(TBL_DESPLAZAMIENTOS)
    .select('id')
    .eq('caso_id', cur.id)
    .maybeSingle();

  if (exErr) {
    console.error('saveDesplazamiento (check existing)', exErr);
    showAlert('danger', exErr.message || 'No se pudo validar desplazamiento existente');
    return;
  }

  // 2) Update o Insert
  if (existing?.id) {
    const { error } = await supabaseClient
      .from(TBL_DESPLAZAMIENTOS)
      .update(payload)
      .eq('id', existing.id);

    if (error) {
      console.error('saveDesplazamiento (update)', error);
      showAlert('danger', error.message || 'No se pudo actualizar desplazamiento');
      return;
    }
  } else {
    const { error } = await supabaseClient
      .from(TBL_DESPLAZAMIENTOS)
      .insert(payload);

    if (error) {
      console.error('saveDesplazamiento (insert)', error);
      showAlert('danger', error.message || 'No se pudo crear desplazamiento');
      return;
    }
  }

  showAlert('success', 'Desplazamiento guardado');
  await refreshDesplazamientoIndicator(supabaseClient);
  const delBtn = qs('btnDeleteDesplazamiento');
  if (delBtn) delBtn.style.display = 'inline-block';
}

async function deleteDesplazamiento(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) return;

  const ok = confirm('¿Eliminar el desplazamiento de este caso?');
  if (!ok) return;

  const { error } = await supabaseClient
    .from(TBL_DESPLAZAMIENTOS)
    .delete()
    .eq('caso_id', cur.id);

  if (error) {
    console.error('deleteDesplazamiento', error);
    showAlert('danger', error.message || 'No se pudo eliminar desplazamiento');
    return;
  }

  showAlert('success', 'Desplazamiento eliminado');
  await refreshDesplazamientoIndicator(supabaseClient);
  clearDesplazamientoForm();

  const delBtn = qs('btnDeleteDesplazamiento');
  if (delBtn) delBtn.style.display = 'none';
}



// ----------------- AUDITORÍA / FILTROS (MODAL) -----------------
function viewAll() {
  state.viewIdxs = (state.cases || []).map((_, i) => i);
}

function viewPos() {
  return state.viewIdxs.indexOf(state.idx);
}

async function gotoViewPos(pos, supabaseClient) {
  if (!state.viewIdxs.length) return;
  const p = Math.max(0, Math.min(state.viewIdxs.length - 1, pos));
  await setIndex(state.viewIdxs[p], supabaseClient);
  updateAuditInfoUI();
}

function updateAuditInfoUI() {
  const total = (state.cases || []).length;
  const shown = (state.viewIdxs || []).length;
  const pos = viewPos();
  const posTxt = (pos >= 0 && shown) ? ` · ${pos + 1}/${shown}` : '';
  const el = qs('auditInfo');
  if (el) el.textContent = `Mostrando ${shown} de ${total}${posTxt}`;
}

async function ensureMuniDeptoMap(supabaseClient) {
  if (state.muniDeptoMap) return state.muniDeptoMap;
  const map = new Map();

  try {
    const { data, error } = await supabaseClient
      .from(TBL_MUNIS)
      .select('*')
      .limit(5000);

    if (!error) {
      (data || []).forEach(r => {
        const nombre = pickMunicipioNombre(r);
        const k = normLocal(nombre);
        if (!k) return;
        let dep = r.departamento_id || null;
        const depTxt = pickMunicipioDepartamento(r);
        if (!dep && depTxt) {
          const d = getDeptoByAny(depTxt);
          dep = d?.id || null;
        }
        if (dep) map.set(k, String(dep));
      });
    } else {
      console.error('ensureMuniDeptoMap', error);
    }
  } catch (e) {
    console.error('ensureMuniDeptoMap catch', e);
  }

  state.muniDeptoMap = map;
  return map;
}

async function buildTerritorioIndexForYear(supabaseClient) {
  state.territorioByCaso = new Map();
  const ids = (state.cases || []).map(c => c.id).filter(Boolean);
  if (!ids.length) return;

  await ensureMuniDeptoMap(supabaseClient);

  const chunk = 500;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const { data, error } = await supabaseClient
      .from(TBL_CASO_MUNI)
      .select(`${COL_CASO_ID}, ${COL_MUNICIPIO_TXT}`)
      .in(COL_CASO_ID, part);

    if (error) {
      console.error('buildTerritorioIndexForYear', error);
      return;
    }

    (data || []).forEach(r => {
      const casoId = r[COL_CASO_ID];
      const muni = String(r[COL_MUNICIPIO_TXT] || '').trim();
      if (!casoId) return;
      let entry = state.territorioByCaso.get(casoId);
      if (!entry) {
        entry = { municipios: [], depto_ids: new Set() };
        state.territorioByCaso.set(casoId, entry);
      }
      if (muni) {
        entry.municipios.push(muni);
        const dep = state.muniDeptoMap?.get(normLocal(muni)) || null;
        if (dep) entry.depto_ids.add(String(dep));
      }
    });
  }
}

function passTextFilter(c, q) {
  if (!q) return true;
  const blob = [
    c.detalle || '',
    c.detalle_lugar || '',
    c.fuente || '',
    c.contextual_info || ''
  ].join(' ').toLowerCase();
  return blob.includes(q);
}

function fillAuditDepartamentos() {
  const sel = qs('f_depto');
  if (!sel) return;
  const opts = ['<option value="">Todos</option>'];
  (state.departamentos || []).forEach(d => {
    const id = String(d.id || '').trim();
    const name = String(d.departamento || d.nombre || '').trim();
    if (!id) return;
    opts.push(`<option value="${escapeHtml(id)}">${escapeHtml(name || id)}</option>`);
  });
  sel.innerHTML = opts.join('');
}

async function fillAuditMunicipios(supabaseClient, deptoId) {
  const sel = qs('f_muni');
  if (!sel) return;
  if (typeof loadMunicipiosCatalog === 'function') {
    // reutiliza el loader existente (sobrescribe options), luego reponemos "Todos"
    await loadMunicipiosCatalog(sel, supabaseClient, deptoId || null);
    if (!sel.querySelector('option[value=""]')) {
      sel.insertAdjacentHTML('afterbegin', '<option value="">Todos</option>');
    }
    sel.value = '';
  }
}

function applyAuditFilters() {
  const idRaw = (qs('f_id')?.value || '').trim();
  const idVal = idRaw ? Number(idRaw) : null;

  const deptoId = (qs('f_depto')?.value || '').trim();
  const muniTxt = (qs('f_muni')?.value || '').trim();
  const issue = (qs('f_issue')?.value || '').trim();
  const text = (qs('f_text')?.value || '').trim().toLowerCase();

  const minM = (qs('f_nmuj_min')?.value || '').trim();
  const minH = (qs('f_nhom_min')?.value || '').trim();
  const minP = (qs('f_nper_min')?.value || '').trim();
  const minMVal = minM === '' ? null : Number(minM);
  const minHVal = minH === '' ? null : Number(minH);
  const minPVal = minP === '' ? null : Number(minP);

  const idxs = [];

  for (let i = 0; i < (state.cases || []).length; i++) {
    const c = state.cases[i];
    let ok = true;

    if (idVal !== null && Number.isFinite(idVal)) {
      if (Number(c.id) !== idVal) ok = false;
    }

    if (ok && minMVal !== null && Number.isFinite(minMVal)) {
      if (Number(c.nmujeres || 0) < minMVal) ok = false;
    }
    if (ok && minHVal !== null && Number.isFinite(minHVal)) {
      if (Number(c.nhombres || 0) < minHVal) ok = false;
    }
    if (ok && minPVal !== null && Number.isFinite(minPVal)) {
      if (Number(c.npersonas || 0) < minPVal) ok = false;
    }

    if (ok && text) {
      if (!passTextFilter(c, text)) ok = false;
    }

    const terr = state.territorioByCaso.get(c.id) || { municipios: [], depto_ids: new Set() };

    if (ok && deptoId) {
      if (!terr.depto_ids || !terr.depto_ids.has(deptoId)) ok = false;
    }

    if (ok && muniTxt) {
      const has = (terr.municipios || []).some(m => String(m).toLowerCase() === muniTxt.toLowerCase());
      if (!has) ok = false;
    }

    if (ok && issue) {
      if (issue === 'sinMunicipio') {
        if ((terr.municipios || []).length > 0) ok = false;
      } else if (issue === 'sinDepartamento') {
        if (terr.depto_ids && terr.depto_ids.size > 0) ok = false;
      } else if (issue === 'sinMujeres') {
        if (Number(c.nmujeres || 0) > 0) ok = false;
      } else if (issue === 'sinHombres') {
        if (Number(c.nhombres || 0) > 0) ok = false;
      } else if (issue === 'sinPersonas') {
        if (Number(c.npersonas || 0) > 0) ok = false;
      } else if (issue === 'sinFuente') {
        if (String(c.fuente || '').trim()) ok = false;
      }
    }

    if (ok) idxs.push(i);
  }

  state.viewIdxs = idxs;
  updateAuditInfoUI();

  if (idxs.length) {
    gotoViewPos(0, state.supabase);
  } else {
    showAlert('warning', 'No hay registros con ese filtro');
    updateAuditInfoUI();
  }
}

function resetAuditFilters() {
  const ids = ['f_id', 'f_depto', 'f_muni', 'f_nmuj_min', 'f_nhom_min', 'f_nper_min', 'f_issue', 'f_text'];
  ids.forEach(id => { const e = qs(id); if (e) e.value = ''; });
  viewAll();
  updateAuditInfoUI();
  if (state.viewIdxs.length) gotoViewPos(0, state.supabase);
}

async function openAuditModal(supabaseClient) {
  fillAuditDepartamentos();
  await fillAuditMunicipios(supabaseClient, qs('f_depto')?.value || null);
  updateAuditInfoUI();
  bootstrap.Modal.getOrCreateInstance(qs('modalAudit')).show();
}


// ----------------- PASTE JSON MODAL -----------------
function pj_parseDateFlexible(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;               // yyyy-mm-dd
  const m = s.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);     // dd-mm-yyyy or dd/mm/yyyy
  if (m) {
    const dd = m[1], mm = m[2], yyyy = m[3];
    const d = Number(dd), mo = Number(mm), y = Number(yyyy);
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function pj_safeJsonParse(txt) {
  try { return { ok: true, value: JSON.parse(txt) }; }
  catch (e) { return { ok: false, error: e }; }
}

function pj_showErrors(msgs) {
  const host = qs('pasteJsonErrors');
  if (!host) return;
  host.innerHTML = '';
  if (!msgs || !msgs.length) return;
  host.innerHTML =
    `<div class="alert alert-warning py-2 mb-0">
      <div class="small"><b>Revisa:</b>
        <ul class="mb-0">${msgs.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      </div>
    </div>`;
}

function pj_hint(msg) {
  const h = qs('pasteJsonHint');
  if (h) h.textContent = msg || '—';
}

function pj_validate(obj) {
  const errs = [];
  const fecha = pj_parseDateFlexible(obj?.fecha || obj?.fecha_evento || obj?.fechaEvento);
  if (!fecha) errs.push('Falta "fecha" (o "fecha_evento") con formato válido (2026-02-21 o 21-02-2026).');
  return { ok: errs.length === 0, errs, fecha };
}

async function pj_readClipboard() {
  const ta = qs('pasteJsonText');
  if (!ta) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      ta.value = text.trim();
      pj_hint('Portapapeles leído.');
      pj_onChange();
    } else {
      pj_hint('Portapapeles vacío.');
    }
  } catch (e) {
    console.error('pj_readClipboard', e);
    pj_hint('No se pudo leer portapapeles (permiso).');
    showAlert('warning', 'No se pudo leer el portapapeles. Pega manualmente el JSON.');
  }
}

function pj_onChange() {
  const ta = qs('pasteJsonText');
  const btn = qs('btnInsertJsonCase');
  if (!ta || !btn) return;

  const txt = (ta.value || '').trim();
  if (!txt) {
    btn.disabled = true;
    pj_showErrors([]);
    pj_hint('Pega un JSON.');
    return;
  }

  const parsed = pj_safeJsonParse(txt);
  if (!parsed.ok) {
    btn.disabled = true;
    pj_showErrors(['JSON inválido: revisa llaves, comillas y comas.']);
    pj_hint('JSON inválido.');
    return;
  }

  const v = pj_validate(parsed.value);
  if (!v.ok) {
    btn.disabled = true;
    pj_showErrors(v.errs);
    pj_hint('Campos requeridos faltantes.');
    return;
  }

  btn.disabled = false;
  pj_showErrors([]);
  pj_hint(`Listo · fecha_evento = ${v.fecha}`);
}

function pj_normUnique(arr) {
  const out = [];
  const seen = new Set();
  (arr || []).forEach(x => {
    const v = String(x || '').trim();
    if (!v) return;
    const k = normLocal(v);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(v);
  });
  return out;
}

function pj_int0(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

async function pj_openModal() {
  const modalEl = qs('modalPasteJson');
  if (!modalEl) {
    showAlert('danger', 'No existe modalPasteJson en el HTML');
    return;
  }
  if (qs('pasteJsonText')) qs('pasteJsonText').value = '';
  if (qs('btnInsertJsonCase')) qs('btnInsertJsonCase').disabled = true;
  pj_showErrors([]);
  pj_hint('Leyendo portapapeles…');

  bootstrap.Modal.getOrCreateInstance(modalEl).show();
  await pj_readClipboard();
}

async function pj_insertFromJson(supabaseClient) {
  console.log("pegando")
  const ta = qs('pasteJsonText');
  if (!ta) return;

  const txt = (ta.value || '').trim();
  const parsed = pj_safeJsonParse(txt);
  if (!parsed.ok) {
    pj_showErrors(['JSON inválido.']);
    return;
  }

  const obj = parsed.value;
  const v = pj_validate(obj);
  if (!v.ok) {
    pj_showErrors(v.errs);
    return;
  }

  // payload compatible con tu SELECT en loadCasesForYear
  const payload = {
    fecha_evento: v.fecha,
    macrotipo: (obj.macrotipo || '').trim() || null,
    detalle: (obj.detalle || '').trim() || null,
    detalle_lugar: (obj.detalle_lugar || obj.detalleLugar || '').trim() || null,
    subtipos: pj_normUnique(obj.subtipos || []),
    pueblo: pj_normUnique(obj.pueblo || []),
    macroactor: (obj.macroactor || '').trim() || null,
    microactores: pj_normUnique(obj.microactores || []),

    npersonas: pj_int0(obj.npersonas),
    nmujeres: pj_int0(obj.nmujeres),
    nhombres: pj_int0(obj.nhombres),
    nmenores: pj_int0(obj.nmenores),

    fuente: (obj.fuente || '').trim() || null,
    fechafuente: pj_parseDateFlexible(obj.fechafuente || obj.fechaFuente) || null,
    enlace: (obj.enlace || '').trim() || null,
    contextual_info: (obj.contextual_info || '').trim() || null,
    contextual_type: boolValue(obj.contextual_type ?? obj.contextualType),
  };

  const { data, error } = await supabaseClient
    .from(TBL_CASOS)
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    console.error('pj_insertFromJson casos_2026', error);
    showAlert('danger', error.message || 'No se pudo insertar el caso');
    return;
  }

  const newId = data?.id;
  if (!newId) {
    showAlert('warning', 'Caso insertado pero no devolvió id.');
    return;
  }

  // Vincular lugares[] -> caso_municipio_2026 (tu puente usa municipio TEXT + lat/lng)
  const lugares = Array.isArray(obj.lugares) ? obj.lugares : [];
  for (const l of lugares) {
    const muniTxt = String(l?.municipio || '').trim();
    if (!muniTxt) continue;

    const payloadM = {
      [COL_CASO_ID]: newId,
      [COL_MUNICIPIO_TXT]: muniTxt,
      lat: (l?.lat ?? null),
      lng: (l?.lng ?? null),
    };

    const ins = await supabaseClient
      .from(TBL_CASO_MUNI)
      .insert(payloadM);

    if (ins.error && String(ins.error.code) !== '23505') {
      console.error('pj_insertFromJson caso_municipio_2026', ins.error);
      // no aborta, solo avisa
      showAlert('warning', 'Caso creado, pero hubo un problema vinculando algunos municipios.');
      break;
    }
  }

  // Cerrar modal
  const modalEl = qs('modalPasteJson');
  const inst = modalEl ? bootstrap.Modal.getInstance(modalEl) : null;
  if (inst) inst.hide();

  showAlert('success', 'Caso creado desde portapapeles');
  await loadCasesForYear(state.year, supabaseClient, { focusId: newId, goLast: true });
}



async function logoutToIndex(supabaseClient) {
  const btn = qs('btnLogoutToIndex');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span><span class="d-none d-md-inline">Saliendo…</span>';
  }

  try {
    await supabaseClient?.auth?.signOut?.();
  } catch (error) {
    console.error('logoutToIndex', error);
  } finally {
    window.location.href = INDEX_PAGE;
  }
}


// ----------------- BINDINGS -----------------
function bindMonitor(supabaseClient) {
  if (bindDone) return;
  bindDone = true;

  // Auditoría (modal)
  qs('btnOpenAudit')?.addEventListener('click', () => openAuditModal(supabaseClient));
  qs('btnApplyAudit')?.addEventListener('click', () => applyAuditFilters());
  qs('btnResetAudit')?.addEventListener('click', () => resetAuditFilters());
  qs('f_depto')?.addEventListener('change', async () => { await fillAuditMunicipios(supabaseClient, qs('f_depto')?.value || null); });


  qs('btnFirst')?.addEventListener('click', () => gotoViewPos(0, supabaseClient));
  qs('btnPrev')?.addEventListener('click', () => gotoViewPos(viewPos() - 1, supabaseClient));
  qs('btnNext')?.addEventListener('click', () => gotoViewPos(viewPos() + 1, supabaseClient));
  qs('btnLast')?.addEventListener('click', () => gotoViewPos(state.viewIdxs.length - 1, supabaseClient));

  qs('btnAdd')?.addEventListener('click', () => addCase(supabaseClient));
  qs('btnDelete')?.addEventListener('click', () => deleteCase(supabaseClient));
  qs('btnSave')?.addEventListener('click', () => saveFechaEvento(supabaseClient));
  qs('btnLogoutToIndex')?.addEventListener('click', () => logoutToIndex(supabaseClient));
  qs('contextualType')?.addEventListener('change', () => updateContextualTypeAuto(supabaseClient));

  qs('selectMacrotipo')?.addEventListener('change', () => updateMacrotipoAuto(supabaseClient));

  // Actores
  qs('selectMacroactor')?.addEventListener('change', () => updateMacroactorAuto(supabaseClient));
  qs('btnAddMicroactor')?.addEventListener('click', () => addMicroactor(supabaseClient));
  qs('microactorNew')?.addEventListener('change', () => addMicroactor(supabaseClient));

  // Detalle autosave
  qs('detalle')?.addEventListener('input', () => {
    const cur = getCurrentCase();
    if (!cur) return;
    const expectedId = cur.id;
    clearTimeout(detalleDebounce);
    detalleDebounce = setTimeout(() => updateDetalleAuto(supabaseClient, expectedId), 600);
  });
  qs('detalle')?.addEventListener('blur', () => {
    const cur = getCurrentCase();
    if (!cur) return;
    updateDetalleAuto(supabaseClient, cur.id);
  });

  // Subtipos (modal)
  const modalEl = qs('modalSubtipos');
  if (modalEl) {
    modalEl.addEventListener('shown.bs.modal', () => renderSubtiposModal(supabaseClient));
  }
  qs('btnAddSubtipo')?.addEventListener('click', () => addSubtipo(supabaseClient));

  // Territorio (tabla puente)
  qs('btnAddLugar')?.addEventListener('click', () => addMunicipioToCaso(supabaseClient));

  // Desplazamiento (modal)
  qs('btnGestionarDesplazamiento')?.addEventListener('click', () => openDesplazamientoModal(supabaseClient));
  qs('btnSaveDesplazamiento')?.addEventListener('click', () => saveDesplazamiento(supabaseClient));
  qs('btnDeleteDesplazamiento')?.addEventListener('click', () => deleteDesplazamiento(supabaseClient));

  // Personas
  qs('btnAddPersona')?.addEventListener('click', () => openPersonaModal());
  qs('btnSavePersona')?.addEventListener('click', () => savePersona(supabaseClient));
  qs('btnDeletePersona')?.addEventListener('click', () => deletePersona(supabaseClient, qs('persona_id').value));

  // Pueblos
  qs('btnAddPueblo')?.addEventListener('click', () => addPueblo(supabaseClient));
  qs('puebloNew')?.addEventListener('change', () => addPueblo(supabaseClient));

  // detalle_lugar autosave
  const saveDetalleLugar = debounce(async () => {
    const cur = getCurrentCase();
    const ta = qs('detalleLugar');
    if (!cur || !ta) return;
    const val = ta.value || '';
    const { error } = await supabaseClient
      .from(TBL_CASOS)
      .update({ detalle_lugar: val })
      .eq('id', cur.id);
    if (error) {
      console.error('detalle_lugar update', error);
      showAlert('danger', error.message || 'No se pudo guardar detalle_lugar');
      return;
    }
    state.cases[state.idx].detalle_lugar = val;
  }, 700);
  qs('detalleLugar')?.addEventListener('input', saveDetalleLugar);

  // Población autosave
  const savePoblacion = debounce(async () => {
    const cur = getCurrentCase();
    if (!cur) return;

    const payload = {
      npersonas: readInt('npersonas'),
      nmujeres: readInt('nmujeres'),
      nhombres: readInt('nhombres'),
      nmenores: readInt('nmenores'),
    };

    const { error } = await supabaseClient
      .from(TBL_CASOS)
      .update(payload)
      .eq('id', cur.id);

    if (error) {
      console.error('poblacion update', error);
      const msg = [error.message, error.details, error.hint].filter(Boolean).join(' · ');
      showAlert('danger', msg || 'No se pudo guardar población');
      return;
    }

    updateCurrentCasePatch(payload);
  }, 650);

  ['npersonas', 'nmujeres', 'nhombres', 'nmenores'].forEach(id => {
    qs(id)?.addEventListener('input', savePoblacion);
  });
  // FORCE btnOpenFuente binding (abre enlace en nueva pestaña)
  const _btnFuente = qs('btnOpenFuente');
  if (_btnFuente) {
    _btnFuente.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFuenteInNewTab();
    });
  }
  qs('btnPaste')?.addEventListener('click', (e) => {
    e.preventDefault();
    pj_openModal();
  });
  qs('btnReadClipboardJson')?.addEventListener('click', () => pj_readClipboard());
  qs('pasteJsonText')?.addEventListener('input', () => pj_onChange());
  qs('btnInsertJsonCase')?.addEventListener('click', () => pj_insertFromJson(supabaseClient));
}


// ----------------- PERSONAS -----------------

function getGeneroClass(g) {
  if (!g) return 'text-bg-secondary';
  const val = g.toLowerCase();
  if (val.includes('hombre')) return 'text-bg-primary';
  if (val.includes('mujer')) return 'text-bg-danger';
  if (val.includes('lgbt') || val.includes('no binario')) return 'text-bg-warning';
  return 'text-bg-secondary';
}

async function loadPersonas(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) return renderPersonas([]);

  const { data, error } = await supabaseClient
    .from(TBL_PERSONAS)
    .select('*')
    .eq('caso_id', cur.id)
    .order('created_at');

  if (error) {
    console.error('loadPersonas', error);
    showAlert('danger', error.message || 'No se pudo cargar personas');
    renderPersonas([]);
    return;
  }

  renderPersonas(data || []);
}

function renderPersonas(list) {
  const host = qs('personasList');
  if (!host) return;
  host.innerHTML = '';

  if (!list.length) {
    host.innerHTML = '<span class="text-muted small">— Sin personas registradas —</span>';
    return;
  }

  list.forEach(p => {
    const badgeClass = getGeneroClass(p.genero);

    const card = el('div', { class: 'border rounded p-2 d-flex justify-content-between align-items-start' }, [
      el('div', {}, [
        el('span', { class: 'badge ' + badgeClass + ' me-2', text: p.genero || '—' }),
        el('div', { class: 'fw-semibold', text: p.nombres || '—' }),
        el('div', { class: 'small text-muted', text: (p.edad || '—') + ' años · ' + (p.cargo || '—') }),
        el('div', { class: 'small', text: p.documento || '' })
      ])
    ]);

    const actions = el('div', {}, [
      el('button', { class: 'btn btn-sm btn-outline-primary me-1', onclick: () => openPersonaModal(p) }, [el('i', { class: 'bi bi-pencil' })]),
      el('button', { class: 'btn btn-sm btn-outline-danger', onclick: () => deletePersona(state.supabase, p.id) }, [el('i', { class: 'bi bi-trash' })])
    ]);

    card.appendChild(actions);
    host.appendChild(card);
  });
}

function openPersonaModal(data = null) {
  qs('persona_id').value = data?.id || '';
  qs('per_nombres').value = data?.nombres || '';
  qs('per_documento').value = data?.documento || '';
  qs('per_edad').value = data?.edad || '';
  qs('per_genero').value = data?.genero || '';
  qs('per_cargo').value = data?.cargo || '';

  qs('btnDeletePersona').style.display = data ? 'inline-block' : 'none';

  bootstrap.Modal.getOrCreateInstance(qs('modalPersona')).show();
}

async function savePersona(supabaseClient) {
  const cur = getCurrentCase();
  if (!cur) return;

  const id = qs('persona_id').value;

  const payload = {
    caso_id: cur.id,
    nombres: qs('per_nombres').value.trim() || null,
    documento: qs('per_documento').value.trim() || null,
    edad: qs('per_edad').value ? parseInt(qs('per_edad').value) : null,
    genero: qs('per_genero').value || null,
    cargo: qs('per_cargo').value.trim() || null
  };

  if (id) {
    await supabaseClient.from(TBL_PERSONAS).update(payload).eq('id', id);
  } else {
    await supabaseClient.from(TBL_PERSONAS).insert(payload);
  }

  bootstrap.Modal.getInstance(qs('modalPersona')).hide();
  loadPersonas(supabaseClient);
}

async function deletePersona(supabaseClient, id) {
  if (!confirm('¿Eliminar persona?')) return;
  await supabaseClient.from(TBL_PERSONAS).delete().eq('id', id);
  loadPersonas(supabaseClient);
}
