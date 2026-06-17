/*
  public.js · Módulo público del Observatorio
  v2: corrige rutas de capas porque Public y SIG son carpetas hermanas.
  Lee datos públicos desde casos_2026 y sig_casos_public_2026 sin tocar datos personales.
*/
(function () {
  'use strict';

  const VERSION = '20260617-public-v2';
  const SUPABASE_URL = 'https://sjvuxlcgeswapbphsqkv.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_Ft_DEmGA6t0uOdu73wrvVg_-_Z8cnPg';
  const TABLA_CASOS = 'casos_2026';
  const VISTA_PUNTOS = 'sig_casos_public_2026';
  const ANIO_INICIO = 2016;
  const ANIO_ACTUAL = new Date().getFullYear();
  const BATCH_SIZE = 1000;

  const CORE_COLUMNS = [
    'id', 'id_old', 'fecha_evento', 'macrotipo', 'departamento', 'macroregion', 'pueblo',
    'npersonas', 'nmujeres', 'nhombres', 'nmenores', 'macroactor', 'fuente', 'fechafuente', 'enlace', 'contextual_type'
  ].join(',');

  // Columnas reales de la vista actual. No pedir detalle/fuente/enlace aquí.
  const POINT_COLUMNS = [
    'punto_id', 'caso_id', 'id_old', 'fecha_evento', 'anio', 'macrotipo', 'departamento', 'macroregion',
    'municipio', 'lat', 'lng', 'pueblo', 'npersonas', 'nmujeres', 'nhombres', 'nmenores', 'macroactor', 'contextual_type'
  ].join(',');

  const LAYERS = {
    tablero: '../SIG/Layers/001tablero.geojson',
    basemap: '../SIG/Layers/002basemap.geojson',
    departamentos: '../SIG/Layers/003departamentos.geojson',
    municipios: '../SIG/Layers/004municipios.geojson'
  };

  const HEAT_COLORS = ['#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0284c7', '#075985'];
  const NO_DATA_COLOR = '#f8fafc';

  const state = {
    client: null,
    core: [],
    points: [],
    pointsMerged: [],
    coreById: new Map(),
    currentYearRecords: [],
    historico: null,
    vigente: null,
    map: null,
    activeMode: 'departamentos',
    activeMetric: 'idr',
    mapLayers: [],
    geojsonCache: new Map(),
    legend: null,
    tablaTSV: ''
  };

  window.OBS_PUBLIC_VERSION = VERSION;

  function qs(id) { return document.getElementById(id); }
  function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }

  function setText(id, text) {
    const el = qs(id);
    if (el) el.textContent = text;
  }

  function setHTML(id, html) {
    const el = qs(id);
    if (el) el.innerHTML = html;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function fmt(value) {
    return new Intl.NumberFormat('es-CO').format(Number(value || 0));
  }

  function pct(value) {
    return `${Number(value || 0).toFixed(1)}%`;
  }

  function norm(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function formatDate(value) {
    if (!value) return 'Sin fecha';
    const p = String(value).split('-');
    if (p.length === 3) return `${p[2]}/${p[1]}/${p[0]}`;
    return String(value);
  }

  function yearOf(value) {
    const n = Number(String(value || '').slice(0, 4));
    return Number.isInteger(n) ? n : null;
  }

  function updateStatus(text) {
    setText('estadoPublico', text);
    setText('loadingText', text);
  }

  function hideLoading() {
    const loading = qs('loadingScreen');
    if (loading) loading.style.display = 'none';
  }

  function showError(message) {
    updateStatus(message);
    const loading = qs('loadingScreen');
    if (loading) {
      loading.innerHTML = `
        <div class="loading-card">
          <div class="d-flex align-items-start gap-3">
            <i class="bi bi-exclamation-triangle-fill text-danger fs-3"></i>
            <div>
              <div class="fw-bold">No se pudo cargar el módulo público</div>
              <div class="small text-muted mt-1">${escapeHtml(message)}</div>
              <button class="btn btn-sm btn-outline-primary mt-3" type="button" onclick="location.reload()">Reintentar</button>
            </div>
          </div>
        </div>`;
    }
  }

  function extraerTextosDesdeJson(value, out = []) {
    if (value === null || value === undefined || value === '') return out;
    if (typeof value === 'string' || typeof value === 'number') {
      const txt = String(value).trim();
      if (txt) out.push(txt);
      return out;
    }
    if (Array.isArray(value)) {
      value.forEach(x => extraerTextosDesdeJson(x, out));
      return out;
    }
    if (typeof value === 'object') {
      const prefer = ['nombre', 'pueblo', 'label', 'name', 'valor', 'value'];
      let used = false;
      prefer.forEach(k => {
        if (value[k] !== undefined && value[k] !== null) {
          used = true;
          extraerTextosDesdeJson(value[k], out);
        }
      });
      if (!used) Object.values(value).forEach(v => extraerTextosDesdeJson(v, out));
    }
    return out;
  }

  function pueblos(record) {
    const seen = new Set();
    return extraerTextosDesdeJson(record?.pueblo || [])
      .map(x => String(x).trim())
      .filter(x => {
        const key = norm(x);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function puebloPlano(record) {
    const list = pueblos(record);
    return list.length ? list.join(', ') : '';
  }

  function validCoord(record) {
    const lat = Number(record?.lat);
    const lng = normalizarLng(record?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function normalizarLng(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n > 0 && n <= 90 ? -Math.abs(n) : n;
  }

  async function fetchBatched(table, columns) {
    const rows = [];
    let from = 0;
    while (true) {
      const to = from + BATCH_SIZE - 1;
      let query = state.client.from(table).select(columns).range(from, to);
      if (columns.includes('fecha_evento')) query = query.order('fecha_evento', { ascending: false, nullsFirst: false });
      const { data, error } = await query;
      if (error) throw error;
      const batch = Array.isArray(data) ? data : [];
      rows.push(...batch);
      if (batch.length < BATCH_SIZE) break;
      from += BATCH_SIZE;
    }
    return rows;
  }

  function totals(records) {
    const unique = new Set();
    const out = { casos: 0, personas: 0, mujeres: 0, hombres: 0, menores: 0 };
    (records || []).forEach((r, i) => {
      const id = String(r.id || r.caso_id || r.id_old || i);
      if (unique.has(id)) return;
      unique.add(id);
      out.casos += 1;
      out.personas += Number(r.npersonas || 0);
      out.mujeres += Number(r.nmujeres || 0);
      out.hombres += Number(r.nhombres || 0);
      out.menores += Number(r.nmenores || 0);
    });
    return out;
  }

  function addToAgg(map, keyVisible, record) {
    const key = norm(keyVisible) || 'sin-dato';
    if (!map.has(key)) {
      map.set(key, {
        key,
        categoria: keyVisible || 'Sin dato',
        ids: new Set(),
        casos: 0,
        personas: 0,
        mujeres: 0,
        hombres: 0,
        menores: 0,
        idr: 0,
        rango: 'Sin registro',
        intensidadRaw: 0
      });
    }
    const item = map.get(key);
    const id = String(record.id || record.caso_id || record.id_old || `${key}-${item.casos}`);
    if (item.ids.has(id)) return;
    item.ids.add(id);
    item.casos += 1;
    item.personas += Number(record.npersonas || 0);
    item.mujeres += Number(record.nmujeres || 0);
    item.hombres += Number(record.nhombres || 0);
    item.menores += Number(record.nmenores || 0);
  }

  function aggregate(records, group) {
    const map = new Map();
    (records || []).forEach(record => {
      if (group === 'anio') addToAgg(map, String(yearOf(record.fecha_evento) || record.anio || 'Sin año'), record);
      else if (group === 'pueblo') {
        const list = pueblos(record);
        (list.length ? list : ['Sin pueblo']).forEach(p => addToAgg(map, p, record));
      } else if (group === 'municipio') addToAgg(map, record.municipio || 'Sin municipio', record);
      else addToAgg(map, record[group] || `Sin ${group}`, record);
    });
    return Array.from(map.values()).map(x => ({ ...x, ids: undefined }));
  }

  function percentile(values, p) {
    const arr = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!arr.length) return 0;
    if (arr.length === 1) return arr[0];
    const pos = (arr.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const w = pos - lo;
    return arr[lo] * (1 - w) + arr[hi] * w;
  }

  function applyIDR(rows, total) {
    const intensities = rows.map(r => r.casos > 0 ? r.personas / r.casos : 0);
    const p95 = percentile(intensities.filter(x => x > 0), 0.95) || Math.max(...intensities, 0) || 0;
    rows.forEach(r => {
      const exposure = total.casos > 0 ? r.casos / total.casos : 0;
      const impact = total.personas > 0 ? r.personas / total.personas : 0;
      r.intensidadRaw = r.casos > 0 ? r.personas / r.casos : 0;
      const intensity = p95 > 0 ? Math.min(r.intensidadRaw, p95) / p95 : 0;
      r.idr = 100 * (0.35 * exposure + 0.40 * impact + 0.25 * intensity);
      r.rango = r.idr >= 75 ? 'Muy alto' : r.idr >= 50 ? 'Alto' : r.idr >= 25 ? 'Medio' : r.idr > 0 ? 'Bajo' : 'Sin registro';
    });
    return rows;
  }

  function top(rows, n = 5, by = 'casos') {
    return [...(rows || [])]
      .sort((a, b) => Number(b[by] || 0) - Number(a[by] || 0) || Number(b.personas || 0) - Number(a.personas || 0))
      .slice(0, n);
  }

  function createSummary(records) {
    const total = totals(records);
    const deptos = applyIDR(aggregate(records, 'departamento'), total);
    const macrotipos = aggregate(records, 'macrotipo');
    const macroactores = aggregate(records, 'macroactor');
    const pueblosAgg = aggregate(records, 'pueblo');
    const anios = aggregate(records, 'anio').sort((a, b) => String(a.categoria).localeCompare(String(b.categoria)));
    return {
      total,
      deptos,
      macrotipos,
      macroactores,
      pueblos: pueblosAgg,
      anios,
      topDepto: top(deptos, 1)[0],
      topMacrotipo: top(macrotipos, 1)[0],
      topActor: top(macroactores, 1)[0],
      topPueblo: top(pueblosAgg, 1)[0],
      topAnio: top(anios, 1)[0]
    };
  }

  function makeMiniStats(items) {
    return items.map(item => `
      <div class="col-6 col-lg-3">
        <div class="mini-stat">
          <div class="value">${escapeHtml(item.value)}</div>
          <div class="label">${escapeHtml(item.label)}</div>
        </div>
      </div>
    `).join('');
  }

  function makeBars(rows, valueKey = 'casos') {
    const list = top(rows, 5, valueKey);
    const max = Math.max(...list.map(r => Number(r[valueKey] || 0)), 1);
    if (!list.length) return '<div class="text-muted small">Sin registros.</div>';
    return list.map(row => {
      const value = Number(row[valueKey] || 0);
      const w = Math.max(3, (value / max) * 100);
      return `
        <div class="bar-row">
          <div class="bar-head"><span class="bar-label" title="${escapeHtml(row.categoria)}">${escapeHtml(row.categoria)}</span><span class="bar-value">${fmt(value)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
        </div>
      `;
    }).join('');
  }

  function makeHighlights(summary) {
    const items = [
      ['Departamento', summary.topDepto?.categoria, summary.topDepto?.casos],
      ['Macrotipo', summary.topMacrotipo?.categoria, summary.topMacrotipo?.casos],
      ['Macroactor', summary.topActor?.categoria, summary.topActor?.casos],
      ['Pueblo', summary.topPueblo?.categoria, summary.topPueblo?.casos],
      ['Año', summary.topAnio?.categoria, summary.topAnio?.casos]
    ];
    return items.map(([label, value, count]) => `
      <div class="d-flex justify-content-between align-items-start gap-3 border-bottom py-2">
        <div>
          <div class="small text-muted">${escapeHtml(label)}</div>
          <div class="fw-bold">${escapeHtml(value || 'Sin dato')}</div>
        </div>
        <div class="badge rounded-pill text-bg-light border">${fmt(count || 0)} casos</div>
      </div>
    `).join('');
  }

  function buildNarrative(summary, scopeLabel) {
    const t = summary.total;
    const dept = summary.topDepto?.categoria || 'sin concentración territorial predominante';
    const macro = summary.topMacrotipo?.categoria || 'sin macrotipo predominante';
    const actor = summary.topActor?.categoria || 'sin macroactor predominante';
    const pueblo = summary.topPueblo?.categoria || 'sin pueblo predominante';
    const anio = summary.topAnio?.categoria || 'sin año predominante';
    return `Durante ${scopeLabel}, el Observatorio registra <strong>${fmt(t.casos)} casos</strong> asociados a <strong>${fmt(t.personas)} personas</strong>. La mayor concentración territorial se observa en <strong>${escapeHtml(dept)}</strong>. El macrotipo con mayor frecuencia corresponde a <strong>${escapeHtml(macro)}</strong>, mientras que el macroactor más recurrente es <strong>${escapeHtml(actor)}</strong>. En términos poblacionales, el mayor número de registros se concentra en <strong>${escapeHtml(pueblo)}</strong>. El año con mayor registro dentro del periodo es <strong>${escapeHtml(anio)}</strong>. Esta lectura permite identificar patrones descriptivos de concentración territorial, afectación colectiva y recurrencia de hechos en los datos públicos disponibles.`;
  }

  function renderDashboard() {
    const historico = state.historico;
    const vigente = state.vigente;

    setText('heroCasosHistorico', fmt(historico.total.casos));
    setText('heroPersonasHistorico', fmt(historico.total.personas));
    setText('heroCasosAnio', fmt(vigente.total.casos));
    setText('heroPersonasAnio', fmt(vigente.total.personas));
    setText('heroPeriodoHistorico', `${ANIO_INICIO} – ${ANIO_ACTUAL}`);
    setText('heroAnioLabel', `Año ${ANIO_ACTUAL}`);
    setText('tituloHistorico', `Consolidado histórico ${ANIO_INICIO} – ${ANIO_ACTUAL}`);
    setText('tituloAnioVigente', `Comportamiento del año ${ANIO_ACTUAL}`);
    setText('ultimaActualizacion', `Fuente: base pública del Observatorio · Última consulta: ${new Date().toLocaleString('es-CO')}`);

    setHTML('historicoMiniStats', makeMiniStats([
      { value: fmt(historico.total.casos), label: 'Casos acumulados' },
      { value: fmt(historico.total.personas), label: 'Personas acumuladas' },
      { value: historico.topDepto?.categoria || 'Sin dato', label: 'Departamento con mayor registro' },
      { value: historico.topMacrotipo?.categoria || 'Sin dato', label: 'Macrotipo más frecuente' }
    ]));

    setHTML('anioMiniStats', makeMiniStats([
      { value: fmt(vigente.total.casos), label: `Casos ${ANIO_ACTUAL}` },
      { value: fmt(vigente.total.personas), label: `Personas ${ANIO_ACTUAL}` },
      { value: vigente.topDepto?.categoria || 'Sin dato', label: 'Departamento del año' },
      { value: vigente.topMacrotipo?.categoria || 'Sin dato', label: 'Macrotipo del año' }
    ]));

    setHTML('microInformeHistorico', buildNarrative(historico, `el periodo ${ANIO_INICIO}–${ANIO_ACTUAL}`));
    setHTML('microInformeAnio', buildNarrative(vigente, `el año ${ANIO_ACTUAL}`));
    setHTML('destacadosHistoricos', makeHighlights(historico));

    setHTML('rankDeptosHist', makeBars(historico.deptos));
    setHTML('rankMacroHist', makeBars(historico.macrotipos));
    setHTML('rankActorHist', makeBars(historico.macroactores));
    setHTML('rankPuebloHist', makeBars(historico.pueblos));

    setHTML('rankDeptosAnio', makeBars(vigente.deptos));
    setHTML('rankMacroAnio', makeBars(vigente.macrotipos));
    setHTML('rankActorAnio', makeBars(vigente.macroactores));
    setHTML('rankPuebloAnio', makeBars(vigente.pueblos));

    const casosPct = historico.total.casos ? (vigente.total.casos / historico.total.casos) * 100 : 0;
    const personasPct = historico.total.personas ? (vigente.total.personas / historico.total.personas) * 100 : 0;
    setHTML('comparativoAnio', `
      <div class="mini-stat mb-3"><div class="value">${pct(casosPct)}</div><div class="label">Participación de los casos del año frente al acumulado histórico</div></div>
      <div class="mini-stat"><div class="value">${pct(personasPct)}</div><div class="label">Participación de personas del año frente al acumulado histórico</div></div>
    `);

    renderTablaTerritorial();
  }

  function renderTablaTerritorial() {
    const rows = top(state.historico.deptos, 1000, 'casos');
    const tbody = qs('tablaTerritorial')?.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="fw-semibold">${escapeHtml(r.categoria)}</td>
        <td class="text-end">${fmt(r.casos)}</td>
        <td class="text-end">${fmt(r.personas)}</td>
        <td class="text-end">${fmt(r.mujeres)}</td>
        <td class="text-end">${fmt(r.hombres)}</td>
        <td class="text-end">${fmt(r.menores)}</td>
        <td class="text-end">${Number(r.idr || 0).toFixed(2)}</td>
        <td>${escapeHtml(r.rango)}</td>
      </tr>
    `).join('') || '<tr><td colspan="9" class="text-muted">Sin registros.</td></tr>';

    const lines = [['Departamento', 'Casos', 'Personas', 'Mujeres', 'Hombres', 'Menores', 'IDR', 'Rango'].join('\t')];
    rows.forEach(r => lines.push([r.categoria, r.casos, r.personas, r.mujeres, r.hombres, r.menores, Number(r.idr || 0).toFixed(2), r.rango].join('\t')));
    state.tablaTSV = lines.join('\n');
  }

  async function copyTable() {
    if (!state.tablaTSV) return;
    try {
      await navigator.clipboard.writeText(state.tablaTSV);
      updateStatus('Tabla pública copiada. Puedes pegarla en Excel o Word.');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = state.tablaTSV;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      updateStatus('Tabla pública copiada.');
    }
  }

  async function fetchGeoJSON(key) {
    if (state.geojsonCache.has(key)) return state.geojsonCache.get(key);
    const url = LAYERS[key];
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo cargar ${url}`);
    const data = await res.json();
    state.geojsonCache.set(key, data);
    return data;
  }

  function clearMapLayers() {
    state.mapLayers.forEach(layer => {
      try { state.map.removeLayer(layer); } catch (_) {}
    });
    state.mapLayers = [];
    if (state.legend) {
      try { state.map.removeControl(state.legend); } catch (_) {}
      state.legend = null;
    }
  }

  function addLayer(layer) {
    layer.addTo(state.map);
    state.mapLayers.push(layer);
    return layer;
  }

  function baseStyle(type) {
    if (type === 'tablero') {
      return { color: '#94a3b8', weight: .7, opacity: .7, fillColor: '#f8fafc', fillOpacity: .55 };
    }
    if (type === 'basemap') {
      return { color: '#cbd5e1', weight: .8, opacity: .85, fillColor: '#ffffff', fillOpacity: .65 };
    }
    return { color: '#334155', weight: 1, opacity: 1, fillColor: '#e0f2fe', fillOpacity: .8 };
  }

  function propFlexible(props, fields) {
    const list = Array.isArray(fields) ? fields : [fields];
    const entries = Object.entries(props || {});
    for (const f of list) if (Object.prototype.hasOwnProperty.call(props || {}, f)) return props[f];
    for (const f of list) {
      const wanted = String(f).trim().toLowerCase();
      const found = entries.find(([k]) => String(k).trim().toLowerCase() === wanted);
      if (found) return found[1];
    }
    for (const f of list) {
      const wanted = norm(f).replace(/[^a-z0-9]/g, '');
      const found = entries.find(([k]) => norm(k).replace(/[^a-z0-9]/g, '') === wanted);
      if (found) return found[1];
    }
    return '';
  }

  function featureName(feature, mode) {
    const props = feature?.properties || {};
    if (mode === 'municipios') {
      const mun = propFlexible(props, ['MPIO_CNMBR', 'MUNICIPIO', 'NOMBRE_MPI', 'NOM_MPIO', 'NOMBRE', 'nombre']);
      const dep = propFlexible(props, ['DEPTO', 'DPTO_CNMBR', 'DEPARTAMENTO', 'DEPARTAMEN', 'departamento']);
      return { name: mun || 'Sin municipio', dep: dep || '', key: `${norm(dep)}|${norm(mun)}`, alt: norm(mun) };
    }
    const dep = propFlexible(props, ['DPTO_CNMBR', 'DPTO_NOMBRE', 'DEPARTAMEN', 'DEPTO', 'DEPARTAMENTO', 'NOMBRE_DPT', 'NOMBRE', 'nombre']);
    return { name: dep || 'Sin departamento', dep: dep || '', key: norm(dep), alt: norm(dep) };
  }

  function aggregateMunicipiosForHeat() {
    const map = new Map();
    const totalCases = new Set();
    let totalPersons = 0;
    state.pointsMerged.forEach(p => {
      if (!validCoord(p)) return;
      const dep = p.departamento || '';
      const mun = p.municipio || 'Sin municipio';
      const key = `${norm(dep)}|${norm(mun)}`;
      if (!map.has(key)) {
        map.set(key, { key, categoria: mun, departamento: dep, ids: new Set(), casos: 0, personas: 0, mujeres: 0, hombres: 0, menores: 0, idr: 0, rango: 'Sin registro' });
      }
      const id = String(p.caso_id || p.id || p.id_old || p.punto_id);
      const item = map.get(key);
      if (!item.ids.has(id)) {
        item.ids.add(id);
        item.casos += 1;
        item.personas += Number(p.npersonas || 0);
        item.mujeres += Number(p.nmujeres || 0);
        item.hombres += Number(p.nhombres || 0);
        item.menores += Number(p.nmenores || 0);
      }
      if (!totalCases.has(id)) {
        totalCases.add(id);
        totalPersons += Number(p.npersonas || 0);
      }
    });
    const rows = Array.from(map.values()).map(x => ({ ...x, ids: undefined }));
    return applyIDR(rows, { casos: totalCases.size, personas: totalPersons });
  }

  function heatData(mode) {
    if (mode === 'municipios') return aggregateMunicipiosForHeat();
    return state.historico.deptos;
  }

  function buildHeatIndex(mode) {
    const rows = heatData(mode);
    const byKey = new Map();
    const byName = new Map();
    rows.forEach(row => {
      if (mode === 'municipios') {
        byKey.set(`${norm(row.departamento)}|${norm(row.categoria)}`, row);
        byName.set(norm(row.categoria), row);
      } else {
        byKey.set(norm(row.categoria), row);
        byName.set(norm(row.categoria), row);
      }
    });
    return { rows, byKey, byName };
  }

  function buildRanges(rows, metric) {
    if (metric === 'idr') {
      const step = 100 / HEAT_COLORS.length;
      return HEAT_COLORS.map((color, i) => ({ min: i * step, max: (i + 1) * step, color, label: `${Math.round(i * step)} – ${Math.round((i + 1) * step)}` }));
    }
    const max = Math.max(...rows.map(r => Number(r[metric] || 0)), 0);
    if (max <= 0) return HEAT_COLORS.map((color, i) => ({ min: 0, max: 0, color, label: i === 0 ? '0' : 'Sin rango' }));
    const step = max / HEAT_COLORS.length;
    return HEAT_COLORS.map((color, i) => ({ min: i * step, max: i === HEAT_COLORS.length - 1 ? max : (i + 1) * step, color, label: `${fmt(Math.round(i * step))} – ${fmt(Math.ceil(i === HEAT_COLORS.length - 1 ? max : (i + 1) * step))}` }));
  }

  function colorFor(value, ranges) {
    const v = Number(value);
    if (!Number.isFinite(v)) return NO_DATA_COLOR;
    for (let i = 0; i < ranges.length; i += 1) {
      const r = ranges[i];
      if (i === ranges.length - 1 && v >= r.min && v <= r.max) return r.color;
      if (v >= r.min && v < r.max) return r.color;
    }
    return ranges[ranges.length - 1]?.color || NO_DATA_COLOR;
  }

  function metricLabel(metric) {
    if (metric === 'casos') return 'Casos';
    if (metric === 'personas') return 'Personas';
    return 'IDR';
  }

  function popupHeat(name, data, metric, mode) {
    if (!data) {
      return `<div><div class="popup-title">${escapeHtml(name)}</div><div class="text-muted small">Sin registros para esta unidad.</div></div>`;
    }
    const label = mode === 'municipios' ? 'Municipio' : 'Departamento';
    return `
      <div style="min-width:260px;max-width:390px">
        <div class="popup-title">${escapeHtml(data.categoria || name)}</div>
        <div class="small text-muted mb-2">${label} · ${metricLabel(metric)}</div>
        <table class="table table-sm popup-table"><tbody>
          <tr><th>Casos</th><td>${fmt(data.casos)}</td></tr>
          <tr><th>Personas</th><td>${fmt(data.personas)}</td></tr>
          <tr><th>Mujeres</th><td>${fmt(data.mujeres)}</td></tr>
          <tr><th>Hombres</th><td>${fmt(data.hombres)}</td></tr>
          <tr><th>Menores</th><td>${fmt(data.menores)}</td></tr>
          <tr><th>IDR</th><td>${Number(data.idr || 0).toFixed(2)} · ${escapeHtml(data.rango)}</td></tr>
        </tbody></table>
      </div>
    `;
  }

  function addLegend(mode, metric, ranges) {
    state.legend = L.control({ position: 'bottomright' });
    state.legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'legend-public leaflet-control');
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      const rows = [
        `<div class="legend-row"><span class="legend-box" style="background:${NO_DATA_COLOR}"></span><span>Sin registro</span></div>`,
        ...ranges.map(r => `<div class="legend-row"><span class="legend-box" style="background:${r.color}"></span><span>${escapeHtml(r.label)}</span></div>`)
      ].join('');
      div.innerHTML = `<div class="legend-title">${escapeHtml(mode === 'municipios' ? 'Municipios' : 'Departamentos')} · ${escapeHtml(metricLabel(metric))}</div>${rows}`;
      return div;
    };
    state.legend.addTo(state.map);
  }

  async function activateHeatMap(mode) {
    updateStatus(`Cargando mapa de calor por ${mode}...`);
    clearMapLayers();
    const tablero = await fetchGeoJSON('tablero').catch(() => null);
    if (tablero) addLayer(L.geoJSON(tablero, { style: baseStyle('tablero'), interactive: false }));

    const key = mode === 'municipios' ? 'municipios' : 'departamentos';
    const geo = await fetchGeoJSON(key);
    const idx = buildHeatIndex(mode);
    const ranges = buildRanges(idx.rows, state.activeMetric);

    const layer = L.geoJSON(geo, {
      interactive: true,
      style: feature => {
        const info = featureName(feature, mode);
        const data = idx.byKey.get(info.key) || idx.byName.get(info.alt);
        const value = data ? Number(data[state.activeMetric] || 0) : null;
        return {
          color: '#334155',
          weight: mode === 'municipios' ? .55 : 1,
          opacity: .95,
          fillColor: data ? colorFor(value, ranges) : NO_DATA_COLOR,
          fillOpacity: data ? .84 : .42
        };
      },
      onEachFeature: (feature, layer) => {
        const info = featureName(feature, mode);
        const data = idx.byKey.get(info.key) || idx.byName.get(info.alt);
        layer.bindPopup(() => popupHeat(info.name, data, state.activeMetric, mode), { maxWidth: 430, autoPan: true });
        layer.on('mouseover', () => {
          if (layer.setStyle) layer.setStyle({ weight: mode === 'municipios' ? 1.2 : 2, opacity: 1 });
          if (layer.bringToFront) layer.bringToFront();
        });
        layer.on('mouseout', () => {
          if (layer.setStyle) layer.setStyle({ weight: mode === 'municipios' ? .55 : 1, opacity: .95 });
        });
      }
    });
    addLayer(layer);
    addLegend(mode, state.activeMetric, ranges);
    try { state.map.fitBounds(layer.getBounds().pad(.05)); } catch (_) {}
    updateStatus(`Mapa de calor por ${mode} listo.`);
  }

  function popupPoint(record) {
    const enlace = record.enlace ? `<tr><th>Enlace</th><td><a href="${escapeHtml(record.enlace)}" target="_blank" rel="noopener">Abrir fuente</a></td></tr>` : '';
    return `
      <div style="min-width:260px;max-width:410px">
        <div class="popup-title">Caso ${escapeHtml(record.id_old || record.caso_id || '')}</div>
        <div class="small text-muted mb-2">Punto público municipal</div>
        <table class="table table-sm popup-table"><tbody>
          <tr><th>Fecha</th><td>${escapeHtml(formatDate(record.fecha_evento))}</td></tr>
          <tr><th>Departamento</th><td>${escapeHtml(record.departamento || '')}</td></tr>
          <tr><th>Municipio</th><td>${escapeHtml(record.municipio || '')}</td></tr>
          <tr><th>Macrotipo</th><td>${escapeHtml(record.macrotipo || '')}</td></tr>
          <tr><th>Pueblo</th><td>${escapeHtml(puebloPlano(record))}</td></tr>
          <tr><th>Macroactor</th><td>${escapeHtml(record.macroactor || '')}</td></tr>
          <tr><th>Personas</th><td>${fmt(record.npersonas)}</td></tr>
          <tr><th>Mujeres</th><td>${fmt(record.nmujeres)}</td></tr>
          <tr><th>Hombres</th><td>${fmt(record.nhombres)}</td></tr>
          <tr><th>Menores</th><td>${fmt(record.nmenores)}</td></tr>
          ${record.fuente ? `<tr><th>Fuente</th><td>${escapeHtml(record.fuente)}</td></tr>` : ''}
          ${record.fechafuente ? `<tr><th>Fecha fuente</th><td>${escapeHtml(formatDate(record.fechafuente))}</td></tr>` : ''}
          ${enlace}
        </tbody></table>
      </div>
    `;
  }

  async function activatePointsMap() {
    updateStatus('Cargando puntos públicos...');
    clearMapLayers();
    const basemap = await fetchGeoJSON('basemap').catch(() => null);
    if (basemap) addLayer(L.geoJSON(basemap, { style: baseStyle('basemap'), interactive: false }));

    const group = L.layerGroup();
    const bounds = L.latLngBounds([]);
    const renderer = L.canvas({ padding: .5 });
    let count = 0;
    state.pointsMerged.forEach(record => {
      if (!validCoord(record)) return;
      const lat = Number(record.lat);
      const lng = normalizarLng(record.lng);
      const marker = L.circleMarker([lat, lng], {
        renderer,
        radius: 5,
        color: '#082f49',
        weight: 1,
        opacity: .9,
        fillColor: '#0ea5e9',
        fillOpacity: .68
      });
      marker.bindPopup(() => popupPoint(record), { maxWidth: 430, autoPan: true });
      marker.addTo(group);
      bounds.extend([lat, lng]);
      count += 1;
    });
    addLayer(group);
    if (bounds.isValid()) state.map.fitBounds(bounds.pad(.12), { maxZoom: 9 });
    updateStatus(`Puntos públicos cargados: ${fmt(count)}.`);
  }

  async function switchMap(mode) {
    state.activeMode = mode;
    qsa('[data-map-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.mapMode === mode));
    const metric = qs('metricSelect');
    if (metric) metric.disabled = mode === 'puntos';
    if (!state.map) return;
    if (mode === 'puntos') await activatePointsMap();
    else await activateHeatMap(mode);
  }

  function initMap() {
    state.map = L.map('publicMap', { zoomControl: true, preferCanvas: true, minZoom: 4, maxZoom: 19 }).setView([4.5709, -74.2973], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(state.map);

    qsa('[data-map-mode]').forEach(btn => btn.addEventListener('click', () => switchMap(btn.dataset.mapMode)));
    qs('metricSelect')?.addEventListener('change', e => {
      state.activeMetric = e.target.value || 'idr';
      if (state.activeMode !== 'puntos') switchMap(state.activeMode);
    });
    setTimeout(() => state.map.invalidateSize(), 150);
  }

  function prepareData() {
    state.coreById = new Map(state.core.map(r => [String(r.id), r]));
    state.pointsMerged = state.points.map(p => {
      const core = state.coreById.get(String(p.caso_id)) || {};
      return {
        ...core,
        ...p,
        id: core.id || p.caso_id,
        caso_id: p.caso_id || core.id,
        fuente: core.fuente,
        fechafuente: core.fechafuente,
        enlace: core.enlace,
        lng: normalizarLng(p.lng)
      };
    });
    state.currentYearRecords = state.core.filter(r => yearOf(r.fecha_evento) === ANIO_ACTUAL);
    state.historico = createSummary(state.core);
    state.vigente = createSummary(state.currentYearRecords);
  }

  async function loadData() {
    if (!window.supabase?.createClient) throw new Error('No cargó la librería de Supabase.');
    state.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    updateStatus('Consultando casos públicos...');
    state.core = await fetchBatched(TABLA_CASOS, CORE_COLUMNS);

    updateStatus('Consultando puntos públicos...');
    state.points = await fetchBatched(VISTA_PUNTOS, POINT_COLUMNS);

    updateStatus('Procesando estadísticas públicas...');
    prepareData();
  }

  async function init() {
    try {
      updateStatus('Iniciando módulo público...');
      initMap();
      await loadData();
      renderDashboard();
      await switchMap('departamentos');
      qs('btnCopiarTabla')?.addEventListener('click', copyTable);
      window.addEventListener('resize', () => state.map?.invalidateSize());
      updateStatus(`Módulo público · ${fmt(state.historico.total.casos)} casos · ${fmt(state.historico.total.personas)} personas.`);
      hideLoading();
    } catch (err) {
      console.error(err);
      showError(err?.message || 'Error desconocido al cargar el módulo público.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
