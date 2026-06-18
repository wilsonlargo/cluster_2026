/* desplazamientosig.js · Rutas de desplazamiento para SIG Observatorio
   v5: edición, exportación, puntos arrastrables, búsqueda de coordenadas y pegado/validación de JSON. */
(function () {
  'use strict';

  const VERSION = '20260618-rutas-v5-portapapeles-validacion';
  const ID_PREFIX = 'ruta-desplazamiento-';
  const ARCHIVO_UNIFICADO = './Rutas_unificadas_II_configurado.json';

  const state = {
    mapa: null,
    grupo: null,
    registros: [],
    filtrados: [],
    seleccionadoId: null,
    marcando: null,
    capasPorId: new Map(),
    nombreArchivo: '',
    registrosPegados: []
  };

  window.SIG_RUTAS_DESPLAZAMIENTO_VERSION = VERSION;

  function qs(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function norm(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function fmt(value) {
    return new Intl.NumberFormat('es-CO').format(Number(value || 0));
  }

  function uniqueId() {
    return `ruta-manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function toNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function formatDate(value) {
    const s = String(value || '').trim();
    if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null') return 'Sin fecha';
    const p = s.slice(0, 10).split('-');
    if (p.length === 3 && p[0].length === 4) return `${p[2]}/${p[1]}/${p[0]}`;
    return s;
  }

  function setEstado(message, type = 'info') {
    const el = qs('estadoRutasDesplazamientos');
    if (!el) return;
    const cls = type === 'error' ? 'text-danger' : type === 'ok' ? 'text-success' : type === 'warn' ? 'text-warning-emphasis' : 'text-muted';
    el.innerHTML = `<span class="${cls}">${escapeHtml(message)}</span>`;
    if (typeof window.actualizarEstado === 'function') window.actualizarEstado(message);
  }

  function parseCoord(value) {
    if (value === null || value === undefined) return null;
    let s = String(value).replace(/^\uFEFF/, '').trim();
    if (!s || ['nan', 'null', 'undefined', '—', '-'].includes(s.toLowerCase())) return null;
    s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeLng(value) {
    const n = parseCoord(value);
    if (n === null) return null;
    return n > 0 && n <= 90 ? -Math.abs(n) : n;
  }

  function cleanStyleValue(value, fallback = '') {
    const s = String(value ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim();
    return s || fallback;
  }

  function parseColor(value) {
    const s = cleanStyleValue(value, '#be123c').toLowerCase();
    const named = {
      black: '#111827', purple: '#7e22ce', red: '#be123c', blue: '#0ea5e9', green: '#16a34a', orange: '#f97316'
    };
    return named[s] || s;
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') return obj[key];
    }
    const entries = Object.entries(obj);
    for (const key of keys) {
      const wanted = norm(key).replace(/[^a-z0-9]/g, '');
      const found = entries.find(([k, v]) => norm(k).replace(/[^a-z0-9]/g, '') === wanted && v !== null && v !== undefined && String(v).trim() !== '');
      if (found) return found[1];
    }
    return '';
  }

  function pickNested(obj, baseKeys, coordKeys) {
    for (const base of baseKeys) {
      const val = obj?.[base];
      if (val && typeof val === 'object') {
        const picked = pick(val, coordKeys);
        if (picked !== '') return picked;
      }
    }
    return '';
  }

  function parseDetalle(detalle) {
    const text = String(detalle || '').replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    const out = { detalle: text };
    let m = text.match(/(20\d{2}|19\d{2})/);
    if (m) out.anio = m[1];
    m = text.match(/Pueblo\s+(.+?)(?=,\s*Actor|,\s*Tipo|$)/i);
    if (m) out.pueblo = m[1].trim();
    m = text.match(/Actor\s+(.+?)(?=,\s*Tipo|$)/i);
    if (m) out.actor = m[1].trim();
    m = text.match(/Tipo\s+(.+?)(?=,\s*\d+(?:[\.,]\d+)?\s*personas|$)/i);
    if (m) out.tipo = m[1].trim();
    m = text.match(/(\d+(?:[\.,]\d+)?)\s*personas/i);
    if (m) {
      const n = Number(m[1].replace(',', '.'));
      if (Number.isFinite(n)) out.personas = Math.trunc(n);
    }
    return out;
  }

  function getOrigenLat(row) {
    return parseCoord(pick(row, ['lat_origen', 'origen_lat', 'lat_ori', 'ori_lat', 'latLugarOri', 'lat_lugar_ori', 'lat_lugar_origen', 'latitud_origen', 'origenLat']) || pickNested(row, ['origen', 'lugar_ori', 'lugar_origen'], ['lat', 'latitud']));
  }

  function getOrigenLng(row) {
    return normalizeLng(pick(row, ['lng_origen', 'lon_origen', 'origen_lng', 'origen_lon', 'lng_ori', 'lon_ori', 'lngLugarOri', 'lng_lugar_ori', 'lng_lugar_origen', 'longitud_origen', 'origenLng']) || pickNested(row, ['origen', 'lugar_ori', 'lugar_origen'], ['lng', 'lon', 'longitud']));
  }

  function getDestinoLat(row) {
    return parseCoord(pick(row, ['lat_destino', 'destino_lat', 'lat_des', 'des_lat', 'latLugarDes', 'lat_lugar_des', 'lat_lugar_destino', 'latitud_destino', 'destinoLat']) || pickNested(row, ['destino', 'lugar_des', 'lugar_destino'], ['lat', 'latitud']));
  }

  function getDestinoLng(row) {
    return normalizeLng(pick(row, ['lng_destino', 'lon_destino', 'destino_lng', 'destino_lon', 'lng_des', 'lon_des', 'lngLugarDes', 'lng_lugar_des', 'lng_lugar_destino', 'longitud_destino', 'destinoLng']) || pickNested(row, ['destino', 'lugar_des', 'lugar_destino'], ['lng', 'lon', 'longitud']));
  }

  function validLatLng(lat, lng) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
    if (Math.abs(la) > 90 || Math.abs(ln) > 180) return false;
    // En este módulo, 0,0 se trata como coordenada vacía para evitar puntos falsos en el Golfo de Guinea.
    if (la === 0 && ln === 0) return false;
    return true;
  }

  function coordTexto(lat, lng) {
    return validLatLng(lat, lng) ? `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}` : 'Sin coordenada';
  }

  function normalizarRegistroUnificado(row, index) {
    const line = row?.line || {};
    const coord = line.coord || {};
    const places = line.places || {};
    const format = line.format_line || {};
    const info = line.info || {};
    const detalleInfo = String(info.detalle || '').trim();
    const parsed = parseDetalle(detalleInfo);
    const id = String(row?._key || row?.id || `${ID_PREFIX}${index + 1}`).trim();

    return {
      _id: id,
      _orden: index + 1,
      id,
      caso_id: '',
      anio: parsed.anio || '',
      pueblo: parsed.pueblo || '',
      actor: parsed.actor || '',
      personas: Number(parsed.personas || 0),
      tipo: parsed.tipo || 'Desplazamiento',
      fecha_des: '',
      fecha_ori: '',
      lugar_des: String(places.end_mun || '').trim(),
      lugar_ori: String(places.ini_mun || '').trim(),
      departamento_des: String(places.end_dep || '').trim(),
      departamento_ori: String(places.ini_dep || '').trim(),
      entorno_des: '',
      entorno_ori: '',
      detalle: parsed.detalle || detalleInfo,
      created_at: '',
      lat_origen: parseCoord(coord.ini_lat),
      lng_origen: normalizeLng(coord.ini_lng),
      lat_destino: parseCoord(coord.end_lat),
      lng_destino: normalizeLng(coord.end_lng),
      color: parseColor(format.color),
      weight: Number(format.weight || 3),
      opacity: Number(format.opacity || 1),
      dashArray: cleanStyleValue(format.dashArray, ''),
      _raw: row
    };
  }

  function normalizarRegistroPlano(row, index) {
    const origenLat = getOrigenLat(row);
    const origenLng = getOrigenLng(row);
    const destinoLat = getDestinoLat(row);
    const destinoLng = getDestinoLng(row);
    const detalle = String(pick(row, ['detalle', 'descripcion', 'observacion', 'info']) || '').trim();
    const parsed = parseDetalle(detalle);

    const id = String(pick(row, ['id', 'uuid', 'desplazamiento_id']) || `${ID_PREFIX}${index + 1}`).trim();
    const origenNombre = String(pick(row, ['lugar_ori', 'lugar_origen', 'origen', 'origen_nombre', 'sitio_origen', 'ini_mun']) || '').trim();
    const destinoNombre = String(pick(row, ['lugar_des', 'lugar_destino', 'destino', 'destino_nombre', 'sitio_destino', 'end_mun']) || '').trim();

    return {
      _id: id || `${ID_PREFIX}${index + 1}`,
      _orden: Number(pick(row, ['orden']) || index + 1),
      id,
      caso_id: String(pick(row, ['caso_id', 'casoId', 'caso', 'id_caso']) || '').trim(),
      anio: String(pick(row, ['anio', 'año', 'year']) || parsed.anio || '').trim(),
      pueblo: String(pick(row, ['pueblo', 'pueblos']) || parsed.pueblo || '').trim(),
      actor: String(pick(row, ['actor', 'macroactor', 'actores']) || parsed.actor || '').trim(),
      personas: Number(pick(row, ['personas', 'npersonas', 'n_personas']) || parsed.personas || 0),
      tipo: String(pick(row, ['tipo', 'tipo_desplazamiento', 'clase']) || parsed.tipo || 'Sin tipo').trim(),
      fecha_des: String(pick(row, ['fecha_des', 'fecha_destino', 'fecha_desplazamiento']) || '').trim(),
      fecha_ori: String(pick(row, ['fecha_ori', 'fecha_origen']) || '').trim(),
      lugar_des: destinoNombre,
      lugar_ori: origenNombre,
      departamento_des: String(pick(row, ['departamento_des', 'depto_des', 'end_dep', 'dep_destino']) || '').trim(),
      departamento_ori: String(pick(row, ['departamento_ori', 'depto_ori', 'ini_dep', 'dep_origen']) || '').trim(),
      entorno_des: String(pick(row, ['entorno_des', 'entorno_destino']) || '').trim(),
      entorno_ori: String(pick(row, ['entorno_ori', 'entorno_origen']) || '').trim(),
      detalle: detalle || parsed.detalle || '',
      created_at: String(pick(row, ['created_at', 'creado', 'fecha_registro']) || '').trim(),
      lat_origen: origenLat,
      lng_origen: origenLng,
      lat_destino: destinoLat,
      lng_destino: destinoLng,
      color: parseColor(pick(row, ['color', 'line_color']) || '#be123c'),
      weight: Number(pick(row, ['weight', 'grosor']) || 4),
      opacity: Number(pick(row, ['opacity', 'opacidad']) || .82),
      dashArray: cleanStyleValue(pick(row, ['dashArray', 'dash_array']) || ''),
      _raw: row
    };
  }

  function normalizarRegistro(row, index) {
    if (row?.line?.coord || row?.line?.places) return normalizarRegistroUnificado(row, index);
    return normalizarRegistroPlano(row, index);
  }

  function crearRegistroVacio() {
    const id = uniqueId();
    return {
      _id: id,
      _orden: state.registros.length + 1,
      id,
      caso_id: '',
      anio: String(new Date().getFullYear()),
      pueblo: '',
      actor: '',
      personas: 0,
      tipo: 'Desplazamiento',
      fecha_des: '',
      fecha_ori: '',
      lugar_des: '',
      lugar_ori: '',
      departamento_des: '',
      departamento_ori: '',
      entorno_des: '',
      entorno_ori: '',
      detalle: '',
      created_at: new Date().toISOString(),
      lat_origen: null,
      lng_origen: null,
      lat_destino: null,
      lng_destino: null,
      color: '#be123c',
      weight: 4,
      opacity: .85,
      dashArray: '',
      _manual: true,
      _raw: null
    };
  }

  function reordenarRegistros() {
    state.registros.forEach((r, idx) => { r._orden = idx + 1; });
  }

  function estadoCoords(registro) {
    const tieneOrigen = validLatLng(registro.lat_origen, registro.lng_origen);
    const tieneDestino = validLatLng(registro.lat_destino, registro.lng_destino);
    if (tieneOrigen && tieneDestino) return 'completa';
    if (tieneOrigen || tieneDestino) return 'parcial';
    return 'sin-coordenadas';
  }

  function buildSearchText(registro) {
    return norm([
      registro.id, registro.caso_id, registro.anio, registro.tipo, registro.pueblo, registro.actor, registro.personas,
      registro.fecha_des, registro.fecha_ori, registro.lugar_des, registro.lugar_ori,
      registro.departamento_des, registro.departamento_ori, registro.entorno_des, registro.entorno_ori, registro.detalle
    ].join(' '));
  }

  function parseCSV(text) {
    const clean = String(text || '').replace(/^\uFEFF/, '');
    const firstLine = clean.split(/\r?\n/).find(line => line.trim()) || '';
    const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < clean.length; i += 1) {
      const ch = clean[i];
      const next = clean[i + 1];
      if (ch === '"') {
        if (inQuotes && next === '"') { cur += '"'; i += 1; }
        else inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) {
        row.push(cur); cur = '';
      } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
        if (ch === '\r' && next === '\n') i += 1;
        row.push(cur);
        if (row.some(cell => String(cell).trim() !== '')) rows.push(row);
        row = []; cur = '';
      } else cur += ch;
    }
    if (cur !== '' || row.length) {
      row.push(cur);
      if (row.some(cell => String(cell).trim() !== '')) rows.push(row);
    }
    if (!rows.length) return [];
    const headers = rows.shift().map(h => String(h || '').trim());
    return rows.map(cells => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] !== undefined ? String(cells[i]).trim() : ''; });
      return obj;
    });
  }

  function pareceRutaIndividual(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value?.line?.coord || value?.line?.places) return true;
    const keys = Object.keys(value).map(k => norm(k));
    const tieneCoords = keys.some(k => ['lat_origen', 'origen_lat', 'lat_ori', 'ini_lat', 'lat_destino', 'destino_lat', 'end_lat'].includes(k));
    const tieneLugar = keys.some(k => ['lugar_ori', 'lugar_origen', 'origen', 'ini_mun', 'lugar_des', 'lugar_destino', 'destino', 'end_mun'].includes(k));
    return tieneCoords || tieneLugar;
  }

  function rowsFromJSON(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.desplazamientos)) return value.desplazamientos;
    if (Array.isArray(value?.rutas)) return value.rutas;
    if (Array.isArray(value?.data)) return value.data;
    if (Array.isArray(value?.records)) return value.records;
    if (pareceRutaIndividual(value)) return [value];
    if (value && typeof value === 'object') {
      return Object.entries(value)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([key, v]) => ({ ...v, _key: key }));
    }
    return [];
  }

  async function cargarArchivo(file) {
    if (!file) return;
    try {
      const text = await file.text();
      let rows = [];
      if (/\.csv$/i.test(file.name) || /^\s*id\s*[,;]/i.test(text)) rows = parseCSV(text);
      else rows = rowsFromJSON(JSON.parse(text));
      const registros = (rows || []).map(normalizarRegistro).filter(r => r._id);
      state.nombreArchivo = file.name;
      cargarRegistros(registros);
      setEstado(`Archivo cargado: ${file.name} · ${fmt(registros.length)} desplazamientos.`, 'ok');
    } catch (error) {
      console.error('cargarArchivo desplazamientos', error);
      setEstado(error?.message || 'No se pudo leer el archivo de desplazamientos.', 'error');
    }
  }

  async function cargarArchivoUrl(url, nombre = 'Rutas unificadas') {
    try {
      setEstado(`Cargando ${nombre}...`);
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`No se pudo cargar ${url}`);
      const rows = rowsFromJSON(await res.json());
      const registros = (rows || []).map(normalizarRegistro).filter(r => r._id);
      state.nombreArchivo = nombre;
      cargarRegistros(registros);
      setEstado(`${nombre} cargado · ${fmt(registros.length)} desplazamientos.`, 'ok');
    } catch (error) {
      console.error('cargarArchivoUrl desplazamientos', error);
      setEstado(error?.message || 'No se pudo cargar el archivo configurado.', 'error');
    }
  }

  function validarRegistrosImportados(registros) {
    const errores = [];
    const advertencias = [];
    const ids = new Set();
    let completas = 0;
    let parciales = 0;
    let sinCoords = 0;

    (registros || []).forEach((r, i) => {
      const label = `Registro ${i + 1}`;
      if (!r || typeof r !== 'object') {
        errores.push(`${label}: no es un objeto válido.`);
        return;
      }
      if (!r._id) errores.push(`${label}: no tiene identificador interno.`);
      const idKey = String(r._id || '').trim();
      if (idKey && ids.has(idKey)) advertencias.push(`${label}: el identificador ${idKey} está repetido; si se agrega al listado será renombrado.`);
      if (idKey) ids.add(idKey);

      const tieneContenido = [r.anio, r.pueblo, r.actor, r.tipo, r.personas, r.detalle, r.lugar_ori, r.lugar_des, r.departamento_ori, r.departamento_des]
        .some(v => String(v ?? '').trim() !== '' && String(v ?? '').trim() !== '0');
      if (!tieneContenido) advertencias.push(`${label}: no tiene información descriptiva suficiente.`);

      if (!String(r.lugar_ori || '').trim()) advertencias.push(`${label}: falta lugar de origen.`);
      if (!String(r.lugar_des || '').trim()) advertencias.push(`${label}: falta lugar de destino.`);

      const origenTieneAlguna = r.lat_origen !== null || r.lng_origen !== null;
      const destinoTieneAlguna = r.lat_destino !== null || r.lng_destino !== null;
      const origenOk = validLatLng(r.lat_origen, r.lng_origen);
      const destinoOk = validLatLng(r.lat_destino, r.lng_destino);

      if (origenTieneAlguna && !origenOk) advertencias.push(`${label}: coordenada de origen inválida o incompleta.`);
      if (destinoTieneAlguna && !destinoOk) advertencias.push(`${label}: coordenada de destino inválida o incompleta.`);

      if (origenOk && destinoOk) completas += 1;
      else if (origenOk || destinoOk) parciales += 1;
      else sinCoords += 1;
    });

    return {
      ok: (registros || []).length > 0 && errores.length === 0,
      total: (registros || []).length,
      completas,
      parciales,
      sinCoords,
      errores,
      advertencias
    };
  }

  function parsearTextoRutasJSON(texto) {
    const clean = String(texto || '').replace(/^\uFEFF/, '').trim();
    if (!clean) throw new Error('Pega primero un JSON de rutas.');
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (error) {
      throw new Error(`JSON inválido: ${error.message || 'revisa llaves, comillas y comas'}.`);
    }
    const rows = rowsFromJSON(parsed);
    const registros = (rows || []).map(normalizarRegistro).filter(r => r._id);
    const validacion = validarRegistrosImportados(registros);
    if (!rows.length) throw new Error('El JSON es válido, pero no se encontraron rutas reconocibles.');
    return { registros, validacion };
  }

  function renderResultadoValidacion(resultado, origen = 'texto pegado') {
    const host = qs('resultadoValidacionRutasJson');
    if (!host) return;
    const { validacion, registros } = resultado;
    const errores = validacion.errores || [];
    const advertencias = validacion.advertencias || [];
    const preview = (registros || []).slice(0, 6).map((r, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${escapeHtml(r.anio || '—')}</td>
        <td>${escapeHtml(r.pueblo || '—')}</td>
        <td>${escapeHtml(labelOrigen(r))}</td>
        <td>${escapeHtml(labelDestino(r))}</td>
        <td>${escapeHtml(estadoCoords(r))}</td>
      </tr>`).join('');

    host.innerHTML = `
      <div class="alert ${validacion.ok ? 'alert-success' : 'alert-warning'} py-2">
        <div class="fw-bold mb-1">Validación de ${escapeHtml(origen)}</div>
        <div class="small">
          ${fmt(validacion.total)} rutas reconocidas · ${fmt(validacion.completas)} trazadas · ${fmt(validacion.parciales)} parciales · ${fmt(validacion.sinCoords)} sin coordenadas.
        </div>
      </div>
      ${errores.length ? `<div class="alert alert-danger py-2 small"><strong>Errores:</strong><ul class="mb-0">${errores.slice(0, 12).map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : ''}
      ${advertencias.length ? `<div class="alert alert-warning py-2 small"><strong>Advertencias:</strong><ul class="mb-0">${advertencias.slice(0, 14).map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>${advertencias.length > 14 ? `<div class="mt-1">Hay ${fmt(advertencias.length - 14)} advertencias adicionales.</div>` : ''}</div>` : ''}
      <div class="table-responsive border rounded">
        <table class="table table-sm mb-0 align-middle">
          <thead class="table-light"><tr><th>#</th><th>Año</th><th>Pueblo</th><th>Origen</th><th>Destino</th><th>Coordenadas</th></tr></thead>
          <tbody>${preview || '<tr><td colspan="6" class="text-muted">Sin vista previa.</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  function setBotonesPegado(enabled) {
    const agregar = qs('btnAgregarJsonPegadoRutas');
    const reemplazar = qs('btnReemplazarJsonPegadoRutas');
    if (agregar) agregar.disabled = !enabled;
    if (reemplazar) reemplazar.disabled = !enabled;
  }

  function validarTextoPegadoRutas() {
    try {
      const result = parsearTextoRutasJSON(qs('textoRutasJsonPegado')?.value || '');
      state.registrosPegados = result.registros;
      renderResultadoValidacion(result, 'JSON pegado');
      setBotonesPegado(result.validacion.ok);
      setEstado(`JSON validado: ${fmt(result.validacion.total)} rutas reconocidas.`, result.validacion.ok ? 'ok' : 'warn');
      return result;
    } catch (error) {
      state.registrosPegados = [];
      setBotonesPegado(false);
      const host = qs('resultadoValidacionRutasJson');
      if (host) host.innerHTML = `<div class="alert alert-danger py-2 mb-0"><strong>No se pudo validar:</strong> ${escapeHtml(error.message || error)}</div>`;
      setEstado(error?.message || 'No se pudo validar el JSON pegado.', 'error');
      return null;
    }
  }

  async function leerPortapapelesRutas() {
    const textarea = qs('textoRutasJsonPegado');
    if (!textarea) return;
    try {
      const texto = await navigator.clipboard.readText();
      if (!texto || !texto.trim()) {
        setEstado('El portapapeles está vacío.', 'warn');
        return;
      }
      textarea.value = texto.trim();
      validarTextoPegadoRutas();
    } catch (error) {
      console.error('leerPortapapelesRutas', error);
      setEstado('No se pudo leer el portapapeles. Pega manualmente el JSON en el cuadro de texto.', 'warn');
      textarea.focus();
    }
  }

  function clonarRegistro(r) {
    return JSON.parse(JSON.stringify(r));
  }

  function asegurarIdsUnicos(registros, existentes = new Set()) {
    return (registros || []).map(registro => {
      const r = clonarRegistro(registro);
      let base = String(r._id || r.id || uniqueId()).trim();
      let candidate = base;
      let n = 2;
      while (existentes.has(candidate)) {
        candidate = `${base}-${n}`;
        n += 1;
      }
      existentes.add(candidate);
      r._id = candidate;
      if (!r.id || r.id === base) r.id = candidate;
      return r;
    });
  }

  function aplicarRegistrosPegados(modo) {
    const result = validarTextoPegadoRutas();
    if (!result?.validacion?.ok) return;
    const nuevos = asegurarIdsUnicos(result.registros, modo === 'agregar' ? new Set(state.registros.map(r => r._id)) : new Set());
    if (modo === 'reemplazar') {
      state.nombreArchivo = 'JSON pegado desde portapapeles';
      cargarRegistros(nuevos);
      setEstado(`Listado reemplazado con ${fmt(nuevos.length)} rutas pegadas.`, 'ok');
    } else {
      state.registros = [...state.registros, ...nuevos];
      state.nombreArchivo = state.nombreArchivo || 'JSON pegado desde portapapeles';
      reordenarRegistros();
      state.seleccionadoId = nuevos[0]?._id || state.seleccionadoId;
      aplicarFiltro();
      dibujarRutas();
      renderTodo();
      setEstado(`${fmt(nuevos.length)} rutas agregadas desde JSON pegado. Exporta el archivo para conservarlas.`, 'ok');
    }
    const modalEl = qs('modalPegarRutasJson');
    const modal = modalEl ? bootstrap.Modal.getInstance(modalEl) : null;
    if (modal) modal.hide();
  }

  function abrirModalPegarRutas() {
    const modalEl = qs('modalPegarRutasJson');
    if (!modalEl) return;
    state.registrosPegados = [];
    setBotonesPegado(false);
    const host = qs('resultadoValidacionRutasJson');
    if (host) host.innerHTML = '';
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
    setTimeout(() => qs('textoRutasJsonPegado')?.focus(), 250);
  }

  function cargarRegistros(registros) {
    state.registros = registros || [];
    reordenarRegistros();
    state.seleccionadoId = state.registros[0]?._id || null;
    aplicarFiltro();
    dibujarRutas();
    renderTodo();
    setTimeout(() => ajustarTodas(), 80);
  }

  function labelOrigen(registro) {
    return [registro.lugar_ori, registro.departamento_ori].filter(Boolean).join(' · ') || 'Sin lugar de origen';
  }

  function labelDestino(registro) {
    return [registro.lugar_des, registro.departamento_des].filter(Boolean).join(' · ') || 'Sin lugar de destino';
  }

  function crearPopupRuta(registro) {
    const coordsEstado = estadoCoords(registro);
    return `
      <div style="min-width:300px;max-width:480px">
        <div class="ruta-popup-title">Ruta de desplazamiento</div>
        <div class="small text-muted mb-2">${escapeHtml(registro.detalle || '')}</div>
        <table class="table table-sm ruta-popup-table"><tbody>
          <tr><th>Año</th><td>${escapeHtml(registro.anio || '—')}</td></tr>
          <tr><th>Pueblo</th><td>${escapeHtml(registro.pueblo || '—')}</td></tr>
          <tr><th>Actor</th><td>${escapeHtml(registro.actor || '—')}</td></tr>
          <tr><th>Tipo</th><td>${escapeHtml(registro.tipo || '—')}</td></tr>
          <tr><th>Personas</th><td>${registro.personas ? fmt(registro.personas) : '—'}</td></tr>
          <tr><th>Origen</th><td>${escapeHtml(labelOrigen(registro))}</td></tr>
          <tr><th>Destino</th><td>${escapeHtml(labelDestino(registro))}</td></tr>
          <tr><th>Estado cartográfico</th><td>${escapeHtml(coordsEstado)}</td></tr>
          <tr><th>Coord. origen</th><td>${escapeHtml(coordTexto(registro.lat_origen, registro.lng_origen))}</td></tr>
          <tr><th>Coord. destino</th><td>${escapeHtml(coordTexto(registro.lat_destino, registro.lng_destino))}</td></tr>
        </tbody></table>
      </div>`;
  }

  function crearIconoMarker(tipo) {
    const className = tipo === 'origen' ? 'ruta-marker-origen' : 'ruta-marker-destino';
    return L.divIcon({ className, iconSize: [15, 15], iconAnchor: [7, 7], popupAnchor: [0, -8] });
  }

  function dibujarRutas() {
    if (!state.grupo || !state.mapa) return;
    state.grupo.clearLayers();
    state.capasPorId.clear();

    state.registros.forEach(registro => {
      const layers = [];
      const tieneOrigen = validLatLng(registro.lat_origen, registro.lng_origen);
      const tieneDestino = validLatLng(registro.lat_destino, registro.lng_destino);

      if (tieneOrigen) {
        const mOrigen = L.marker([Number(registro.lat_origen), Number(registro.lng_origen)], {
          icon: crearIconoMarker('origen'),
          title: 'Origen · arrastra para ajustar',
          draggable: true,
          autoPan: true
        }).bindPopup(crearPopupRuta(registro), { pane: 'panePopupsTop', maxWidth: 480 });
        mOrigen.on('click', () => seleccionarRegistro(registro._id, { fit: false }));
        mOrigen.on('dragend', event => actualizarPuntoDesdeLatLng(registro._id, 'origen', event.target.getLatLng(), {
          fit: false,
          mensaje: 'Origen movido. Exporta el JSON para conservar la nueva coordenada.'
        }));
        mOrigen.addTo(state.grupo);
        layers.push(mOrigen);
      }

      if (tieneDestino) {
        const mDestino = L.marker([Number(registro.lat_destino), Number(registro.lng_destino)], {
          icon: crearIconoMarker('destino'),
          title: 'Destino · arrastra para ajustar',
          draggable: true,
          autoPan: true
        }).bindPopup(crearPopupRuta(registro), { pane: 'panePopupsTop', maxWidth: 480 });
        mDestino.on('click', () => seleccionarRegistro(registro._id, { fit: false }));
        mDestino.on('dragend', event => actualizarPuntoDesdeLatLng(registro._id, 'destino', event.target.getLatLng(), {
          fit: false,
          mensaje: 'Destino movido. Exporta el JSON para conservar la nueva coordenada.'
        }));
        mDestino.addTo(state.grupo);
        layers.push(mDestino);
      }

      if (tieneOrigen && tieneDestino) {
        const line = L.polyline(
          [[Number(registro.lat_origen), Number(registro.lng_origen)], [Number(registro.lat_destino), Number(registro.lng_destino)]],
          {
            color: registro.color || '#be123c',
            weight: Number.isFinite(Number(registro.weight)) ? Number(registro.weight) : 4,
            opacity: Number.isFinite(Number(registro.opacity)) ? Number(registro.opacity) : .82,
            dashArray: registro.dashArray || null,
            lineCap: 'round',
            lineJoin: 'round',
            pane: 'pane8'
          }
        ).bindPopup(crearPopupRuta(registro), { pane: 'panePopupsTop', maxWidth: 480 });
        line.on('click', () => seleccionarRegistro(registro._id, { fit: false }));
        line.addTo(state.grupo);
        layers.push(line);
      }

      state.capasPorId.set(registro._id, layers);
    });

    if (window.SIG_STATE) window.SIG_STATE.rutasDesplazamientos = state;
  }

  function boundsRegistro(registro) {
    const pts = [];
    if (validLatLng(registro.lat_origen, registro.lng_origen)) pts.push([Number(registro.lat_origen), Number(registro.lng_origen)]);
    if (validLatLng(registro.lat_destino, registro.lng_destino)) pts.push([Number(registro.lat_destino), Number(registro.lng_destino)]);
    if (!pts.length) return null;
    return L.latLngBounds(pts);
  }

  function ajustarRegistro(registro) {
    if (!state.mapa || !registro) return;
    const b = boundsRegistro(registro);
    if (!b) return;
    state.mapa.fitBounds(b.pad(.35), { maxZoom: 13 });
  }

  function ajustarTodas() {
    if (!state.mapa || !state.registros.length) return;
    const bounds = L.latLngBounds([]);
    state.registros.forEach(r => {
      const b = boundsRegistro(r);
      if (b) bounds.extend(b);
    });
    if (bounds.isValid()) state.mapa.fitBounds(bounds.pad(.2), { maxZoom: 9 });
    else setEstado('Los desplazamientos cargados todavía no tienen coordenadas para ajustar el mapa.', 'warn');
  }

  function aplicarFiltro() {
    const q = norm(qs('buscarRutasDesplazamientos')?.value || '');
    state.filtrados = q ? state.registros.filter(r => buildSearchText(r).includes(q)) : [...state.registros];
  }

  function resumen() {
    const total = state.registros.length;
    let completas = 0;
    let parciales = 0;
    state.registros.forEach(r => {
      const e = estadoCoords(r);
      if (e === 'completa') completas += 1;
      if (e === 'parcial') parciales += 1;
    });
    return { total, completas, parciales };
  }

  function renderResumen() {
    const host = qs('resumenRutasDesplazamientos');
    if (!host) return;
    const s = resumen();
    host.innerHTML = `
      <div class="rutas-stat"><div class="value">${fmt(s.total)}</div><div class="label">Registros</div></div>
      <div class="rutas-stat"><div class="value">${fmt(s.completas)}</div><div class="label">Rutas trazadas</div></div>
      <div class="rutas-stat"><div class="value">${fmt(s.parciales)}</div><div class="label">Con punto parcial</div></div>`;
  }

  function renderDetalle() {
    const host = qs('detalleRutaDesplazamiento');
    if (!host) return;
    const registro = state.registros.find(r => r._id === state.seleccionadoId);
    if (!registro) {
      host.innerHTML = 'Selecciona un desplazamiento de la lista para ver el detalle, editarlo o marcar puntos.';
      return;
    }
    const estado = estadoCoords(registro);
    host.innerHTML = `
      <div class="fw-bold text-primary-emphasis mb-1">${escapeHtml(registro.anio || 'Sin año')} · ${escapeHtml(registro.tipo || 'Desplazamiento')}</div>
      <div><strong>Pueblo:</strong> ${escapeHtml(registro.pueblo || '—')}</div>
      <div><strong>Actor:</strong> ${escapeHtml(registro.actor || '—')}</div>
      <div><strong>Personas:</strong> ${registro.personas ? fmt(registro.personas) : '—'}</div>
      <div><strong>Origen:</strong> ${escapeHtml(labelOrigen(registro))}</div>
      <div><strong>Destino:</strong> ${escapeHtml(labelDestino(registro))}</div>
      <div><strong>Coordenadas:</strong> ${escapeHtml(estado)}</div>
      <div class="small text-muted mt-1">${escapeHtml(registro.detalle || '')}</div>
      <div class="ruta-item-actions mt-2">
        <button class="btn btn-outline-primary btn-sm" type="button" data-ruta-action="origen" data-ruta-id="${escapeHtml(registro._id)}"><i class="bi bi-crosshair me-1"></i>Marcar origen</button>
        <button class="btn btn-outline-danger btn-sm" type="button" data-ruta-action="destino" data-ruta-id="${escapeHtml(registro._id)}"><i class="bi bi-crosshair me-1"></i>Marcar destino</button>
        <button class="btn btn-outline-info btn-sm" type="button" data-ruta-action="buscar-origen" data-ruta-id="${escapeHtml(registro._id)}"><i class="bi bi-search-heart me-1"></i>Buscar origen</button>
        <button class="btn btn-outline-info btn-sm" type="button" data-ruta-action="buscar-destino" data-ruta-id="${escapeHtml(registro._id)}"><i class="bi bi-search-heart me-1"></i>Buscar destino</button>
        <button class="btn btn-outline-secondary btn-sm" type="button" data-ruta-action="ver" data-ruta-id="${escapeHtml(registro._id)}"><i class="bi bi-search me-1"></i>Ver</button>
      </div>
      <div class="small text-muted mt-2">Los puntos pueden ajustarse con clic sobre el mapa, búsqueda por lugar o arrastrando el marcador ya dibujado.</div>

      <form class="ruta-edit-form" id="formEditarRutaDesplazamiento">
        <div class="row g-2">
          <div class="col-6 col-md-4">
            <label class="form-label" for="rutaEditAnio">Año</label>
            <input class="form-control" id="rutaEditAnio" type="number" min="1900" max="2100" value="${escapeHtml(registro.anio || '')}">
          </div>
          <div class="col-6 col-md-4">
            <label class="form-label" for="rutaEditPersonas">Personas</label>
            <input class="form-control" id="rutaEditPersonas" type="number" min="0" step="1" value="${escapeHtml(registro.personas || 0)}">
          </div>
          <div class="col-12 col-md-4">
            <label class="form-label" for="rutaEditTipo">Tipo</label>
            <input class="form-control" id="rutaEditTipo" value="${escapeHtml(registro.tipo || '')}" placeholder="Masivo, familiar, etc.">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label" for="rutaEditPueblo">Pueblo</label>
            <input class="form-control" id="rutaEditPueblo" value="${escapeHtml(registro.pueblo || '')}">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label" for="rutaEditActor">Actor</label>
            <input class="form-control" id="rutaEditActor" value="${escapeHtml(registro.actor || '')}">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label" for="rutaEditLugarOri">Lugar origen</label>
            <input class="form-control" id="rutaEditLugarOri" value="${escapeHtml(registro.lugar_ori || '')}">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label" for="rutaEditDeptoOri">Departamento origen</label>
            <input class="form-control" id="rutaEditDeptoOri" value="${escapeHtml(registro.departamento_ori || '')}">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label" for="rutaEditLatOri">Lat. origen</label>
            <input class="form-control" id="rutaEditLatOri" value="${validLatLng(registro.lat_origen, registro.lng_origen) ? escapeHtml(Number(registro.lat_origen).toFixed(8)) : ''}" placeholder="ej. 4.60971">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label" for="rutaEditLngOri">Lng. origen</label>
            <input class="form-control" id="rutaEditLngOri" value="${validLatLng(registro.lat_origen, registro.lng_origen) ? escapeHtml(Number(registro.lng_origen).toFixed(8)) : ''}" placeholder="ej. -74.08175">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label" for="rutaEditLugarDes">Lugar destino</label>
            <input class="form-control" id="rutaEditLugarDes" value="${escapeHtml(registro.lugar_des || '')}">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label" for="rutaEditDeptoDes">Departamento destino</label>
            <input class="form-control" id="rutaEditDeptoDes" value="${escapeHtml(registro.departamento_des || '')}">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label" for="rutaEditLatDes">Lat. destino</label>
            <input class="form-control" id="rutaEditLatDes" value="${validLatLng(registro.lat_destino, registro.lng_destino) ? escapeHtml(Number(registro.lat_destino).toFixed(8)) : ''}" placeholder="ej. 4.60971">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label" for="rutaEditLngDes">Lng. destino</label>
            <input class="form-control" id="rutaEditLngDes" value="${validLatLng(registro.lat_destino, registro.lng_destino) ? escapeHtml(Number(registro.lng_destino).toFixed(8)) : ''}" placeholder="ej. -74.08175">
          </div>
          <div class="col-6 col-md-4">
            <label class="form-label" for="rutaEditColor">Color línea</label>
            <input class="form-control" id="rutaEditColor" value="${escapeHtml(registro.color || '#be123c')}" placeholder="#be123c">
          </div>
          <div class="col-6 col-md-4">
            <label class="form-label" for="rutaEditWeight">Grosor</label>
            <input class="form-control" id="rutaEditWeight" type="number" min="1" max="12" step="1" value="${escapeHtml(registro.weight || 4)}">
          </div>
          <div class="col-12 col-md-4">
            <label class="form-label" for="rutaEditDash">Trazo</label>
            <select class="form-select" id="rutaEditDash">
              <option value="" ${!registro.dashArray ? 'selected' : ''}>Continuo</option>
              <option value="8 6" ${registro.dashArray === '8 6' ? 'selected' : ''}>Punteado largo</option>
              <option value="3 6" ${registro.dashArray === '3 6' ? 'selected' : ''}>Punteado corto</option>
            </select>
          </div>
          <div class="col-12">
            <label class="form-label" for="rutaEditDetalle">Detalle</label>
            <textarea class="form-control" id="rutaEditDetalle" rows="3" placeholder="Detalle del desplazamiento">${escapeHtml(registro.detalle || '')}</textarea>
          </div>
        </div>
        <div class="ruta-item-actions mt-2">
          <button class="btn btn-success btn-sm" type="submit"><i class="bi bi-check2-circle me-1"></i>Guardar cambios</button>
          <button class="btn btn-outline-danger btn-sm" type="button" id="btnEliminarRutaDetalle"><i class="bi bi-trash me-1"></i>Eliminar esta ruta</button>
        </div>
        <div class="small text-muted mt-2">Los cambios quedan en esta sesión del mapa. Puedes escribir coordenadas manuales, buscar por nombre, hacer clic en el mapa o arrastrar los puntos. Usa “Exportar JSON” para descargar el archivo actualizado.</div>
      </form>`;

    host.querySelectorAll('[data-ruta-action]').forEach(btn => btn.addEventListener('click', onRutaAction));
    qs('formEditarRutaDesplazamiento')?.addEventListener('submit', guardarEdicionSeleccionada);
    qs('btnEliminarRutaDetalle')?.addEventListener('click', eliminarRutaSeleccionada);
  }

  function leerValor(id) {
    return qs(id)?.value?.trim?.() || '';
  }

  function guardarEdicionSeleccionada(event) {
    if (event) event.preventDefault();
    const registro = state.registros.find(r => r._id === state.seleccionadoId);
    if (!registro) return;

    registro.anio = leerValor('rutaEditAnio');
    registro.personas = Math.max(0, Math.trunc(Number(leerValor('rutaEditPersonas') || 0)) || 0);
    registro.tipo = leerValor('rutaEditTipo') || 'Desplazamiento';
    registro.pueblo = leerValor('rutaEditPueblo');
    registro.actor = leerValor('rutaEditActor');
    registro.lugar_ori = leerValor('rutaEditLugarOri');
    registro.departamento_ori = leerValor('rutaEditDeptoOri');
    registro.lugar_des = leerValor('rutaEditLugarDes');
    registro.departamento_des = leerValor('rutaEditDeptoDes');

    const latOriManual = parseCoord(leerValor('rutaEditLatOri'));
    const lngOriManual = normalizeLng(leerValor('rutaEditLngOri'));
    const latDesManual = parseCoord(leerValor('rutaEditLatDes'));
    const lngDesManual = normalizeLng(leerValor('rutaEditLngDes'));

    registro.lat_origen = validLatLng(latOriManual, lngOriManual) ? latOriManual : null;
    registro.lng_origen = validLatLng(latOriManual, lngOriManual) ? lngOriManual : null;
    registro.lat_destino = validLatLng(latDesManual, lngDesManual) ? latDesManual : null;
    registro.lng_destino = validLatLng(latDesManual, lngDesManual) ? lngDesManual : null;

    registro.color = parseColor(leerValor('rutaEditColor') || registro.color || '#be123c');
    registro.weight = Math.max(1, Number(leerValor('rutaEditWeight') || registro.weight || 4));
    registro.dashArray = leerValor('rutaEditDash');
    registro.detalle = leerValor('rutaEditDetalle');

    aplicarFiltro();
    dibujarRutas();
    renderTodo();
    setEstado('Cambios guardados en la sesión. Exporta el JSON para conservarlos.', 'ok');
  }

  function renderLista() {
    const host = qs('listaRutasDesplazamientos');
    if (!host) return;
    host.innerHTML = '';
    if (!state.registros.length) {
      host.innerHTML = '<div class="rutas-status">No hay desplazamientos cargados.</div>';
      return;
    }
    if (!state.filtrados.length) {
      host.innerHTML = '<div class="rutas-status">No hay desplazamientos con ese filtro.</div>';
      return;
    }

    state.filtrados.forEach(registro => {
      const e = estadoCoords(registro);
      const dotClass = e === 'completa' ? 'ok' : e === 'parcial' ? 'warn' : 'empty';
      const item = document.createElement('div');
      item.className = `ruta-item ${registro._id === state.seleccionadoId ? 'active' : ''}`;
      item.dataset.rutaId = registro._id;
      item.innerHTML = `
        <div class="d-flex justify-content-between gap-2 align-items-start">
          <div class="ruta-item-title"><span class="ruta-dot ${dotClass}"></span>${escapeHtml(registro.anio || '—')} · ${escapeHtml(registro.pueblo || 'Pueblo sin dato')}</div>
          <span class="badge text-bg-light border">${fmt(registro._orden)}</span>
        </div>
        <div class="ruta-item-meta">${escapeHtml(registro.tipo || '—')} · ${registro.personas ? fmt(registro.personas) + ' personas' : 'personas —'} · ${escapeHtml(registro.actor || 'actor —')}</div>
        <div class="ruta-item-place"><strong>Origen:</strong> ${escapeHtml(labelOrigen(registro))}</div>
        <div class="ruta-item-place"><strong>Destino:</strong> ${escapeHtml(labelDestino(registro))}</div>
        <div class="ruta-item-actions">
          <button class="btn btn-outline-primary btn-sm" type="button" data-ruta-action="origen" data-ruta-id="${escapeHtml(registro._id)}">Origen</button>
          <button class="btn btn-outline-danger btn-sm" type="button" data-ruta-action="destino" data-ruta-id="${escapeHtml(registro._id)}">Destino</button>
          <button class="btn btn-outline-info btn-sm" type="button" data-ruta-action="buscar-origen" data-ruta-id="${escapeHtml(registro._id)}">Buscar O</button>
          <button class="btn btn-outline-info btn-sm" type="button" data-ruta-action="buscar-destino" data-ruta-id="${escapeHtml(registro._id)}">Buscar D</button>
          <button class="btn btn-outline-secondary btn-sm" type="button" data-ruta-action="ver" data-ruta-id="${escapeHtml(registro._id)}">Ver</button>
        </div>`;
      item.addEventListener('click', event => {
        if (event.target?.closest?.('button')) return;
        seleccionarRegistro(registro._id, { fit: true });
      });
      item.querySelectorAll('[data-ruta-action]').forEach(btn => btn.addEventListener('click', onRutaAction));
      host.appendChild(item);
    });
  }

  function renderTodo() {
    renderResumen();
    renderDetalle();
    renderLista();
  }

  function seleccionarRegistro(id, opts = {}) {
    state.seleccionadoId = id;
    const registro = state.registros.find(r => r._id === id);
    renderTodo();
    if (opts.fit && registro) ajustarRegistro(registro);
  }

  function onRutaAction(event) {
    event.preventDefault();
    event.stopPropagation();
    const id = event.currentTarget.dataset.rutaId;
    const action = event.currentTarget.dataset.rutaAction;
    const registro = state.registros.find(r => r._id === id);
    if (!registro) return;
    seleccionarRegistro(id, { fit: action === 'ver' });
    if (action === 'origen' || action === 'destino') iniciarMarcado(id, action);
    if (action === 'buscar-origen') buscarCoordenadaSeleccionada('origen');
    if (action === 'buscar-destino') buscarCoordenadaSeleccionada('destino');
  }

  function iniciarMarcado(id, tipo) {
    if (!state.mapa) return;
    const registro = state.registros.find(r => r._id === id);
    if (!registro) return;
    state.marcando = { id, tipo };
    setEstado(`Haz clic sobre el mapa para marcar el punto de ${tipo} del desplazamiento seleccionado.`, 'warn');
    state.mapa.once('click', event => {
      if (!state.marcando || state.marcando.id !== id || state.marcando.tipo !== tipo) return;
      asignarPunto(id, tipo, event.latlng);
      state.marcando = null;
    });
  }

  function actualizarPuntoDesdeLatLng(id, tipo, latlng, opts = {}) {
    const registro = state.registros.find(r => r._id === id);
    if (!registro || !latlng) return;
    const lat = Number(latlng.lat);
    const lng = Number(latlng.lng);
    if (!validLatLng(lat, lng)) {
      setEstado('La coordenada capturada no es válida. Intenta nuevamente sobre el mapa.', 'warn');
      return;
    }
    if (tipo === 'origen') {
      registro.lat_origen = lat;
      registro.lng_origen = lng;
    } else {
      registro.lat_destino = lat;
      registro.lng_destino = lng;
    }
    dibujarRutas();
    renderTodo();
    if (opts.fit) ajustarRegistro(registro);
    setEstado(opts.mensaje || `Punto de ${tipo} actualizado. Puedes exportar el JSON para conservar las coordenadas.`, 'ok');
  }

  function asignarPunto(id, tipo, latlng) {
    actualizarPuntoDesdeLatLng(id, tipo, latlng, { fit: true });
  }

  function construirConsultaBusqueda(registro, tipo) {
    if (!registro) return '';
    const lugar = tipo === 'origen' ? registro.lugar_ori : registro.lugar_des;
    const departamento = tipo === 'origen' ? registro.departamento_ori : registro.departamento_des;
    return [lugar, departamento, 'Colombia'].filter(x => String(x || '').trim()).join(', ');
  }

  async function buscarCoordenadaSeleccionada(tipo) {
    const registro = state.registros.find(r => r._id === state.seleccionadoId);
    if (!registro) {
      setEstado('Selecciona una ruta para buscar coordenadas.', 'warn');
      return;
    }
    guardarEdicionSeleccionada();
    const actualizado = state.registros.find(r => r._id === state.seleccionadoId) || registro;
    const consulta = construirConsultaBusqueda(actualizado, tipo);
    if (!consulta || consulta === 'Colombia') {
      setEstado(`Escribe primero el lugar y departamento de ${tipo} para buscar coordenadas.`, 'warn');
      return;
    }

    try {
      setEstado(`Buscando coordenada de ${tipo}: ${consulta}...`, 'warn');
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=co&q=${encodeURIComponent(consulta)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('No se pudo completar la búsqueda de coordenadas.');
      const data = await res.json();
      const item = Array.isArray(data) ? data[0] : null;
      if (!item) {
        setEstado(`No se encontró coordenada para ${consulta}. Puedes marcar el punto con clic o escribir latitud/longitud.`, 'warn');
        return;
      }
      const lat = parseCoord(item.lat);
      const lng = normalizeLng(item.lon ?? item.lng);
      if (!validLatLng(lat, lng)) {
        setEstado('La búsqueda devolvió una coordenada no válida. Marca el punto manualmente.', 'warn');
        return;
      }
      actualizarPuntoDesdeLatLng(actualizado._id, tipo, { lat, lng }, {
        fit: true,
        mensaje: `Coordenada de ${tipo} encontrada y aplicada. Revisa el punto; si no es exacto, arrástralo y exporta el JSON.`
      });
    } catch (error) {
      console.error('buscarCoordenadaSeleccionada', error);
      setEstado('No se pudo buscar la coordenada. Puedes marcar el punto con clic sobre el mapa o escribir lat/lng manualmente.', 'error');
    }
  }

  function crearNuevaRuta() {
    const registro = crearRegistroVacio();
    state.registros.unshift(registro);
    reordenarRegistros();
    state.seleccionadoId = registro._id;
    aplicarFiltro();
    dibujarRutas();
    renderTodo();
    setEstado('Nueva ruta creada. Completa sus datos, marca origen/destino y exporta el JSON actualizado.', 'ok');
  }

  function eliminarRutaSeleccionada() {
    const registro = state.registros.find(r => r._id === state.seleccionadoId);
    if (!registro) {
      setEstado('Selecciona una ruta para eliminar.', 'warn');
      return;
    }
    const label = `${registro.anio || 'Sin año'} · ${registro.pueblo || registro.tipo || registro._id}`;
    if (!confirm(`¿Eliminar esta ruta de desplazamiento?\n${label}`)) return;
    state.registros = state.registros.filter(r => r._id !== registro._id);
    reordenarRegistros();
    state.seleccionadoId = state.registros[0]?._id || null;
    aplicarFiltro();
    dibujarRutas();
    renderTodo();
    setEstado('Ruta eliminada de la sesión. Exporta el JSON para guardar el cambio.', 'ok');
  }

  function exportarJSON() {
    if (!state.registros.length) {
      setEstado('No hay desplazamientos para exportar.', 'warn');
      return;
    }
    const payload = {
      tipo_archivo: 'rutas_desplazamientos_observatorio',
      version: VERSION,
      generado_en: new Date().toISOString(),
      fuente: state.nombreArchivo || 'archivo externo',
      desplazamientos: state.registros.map(r => ({
        id: r.id || r._id,
        orden: r._orden,
        caso_id: r.caso_id || null,
        anio: r.anio || null,
        pueblo: r.pueblo || null,
        actor: r.actor || null,
        tipo: r.tipo || null,
        personas: Number(r.personas || 0),
        detalle: r.detalle || null,
        fecha_ori: r.fecha_ori || null,
        lugar_ori: r.lugar_ori || null,
        departamento_ori: r.departamento_ori || null,
        entorno_ori: r.entorno_ori || null,
        fecha_des: r.fecha_des || null,
        lugar_des: r.lugar_des || null,
        departamento_des: r.departamento_des || null,
        entorno_des: r.entorno_des || null,
        lat_origen: validLatLng(r.lat_origen, r.lng_origen) ? Number(r.lat_origen) : null,
        lng_origen: validLatLng(r.lat_origen, r.lng_origen) ? Number(r.lng_origen) : null,
        lat_destino: validLatLng(r.lat_destino, r.lng_destino) ? Number(r.lat_destino) : null,
        lng_destino: validLatLng(r.lat_destino, r.lng_destino) ? Number(r.lng_destino) : null,
        color: r.color || null,
        weight: r.weight || null,
        opacity: r.opacity || null,
        dashArray: r.dashArray || ''
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rutas_desplazamientos_observatorio.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setEstado('JSON exportado con las coordenadas disponibles.', 'ok');
  }

  function limpiar() {
    state.registros = [];
    state.filtrados = [];
    state.seleccionadoId = null;
    state.marcando = null;
    state.nombreArchivo = '';
    if (state.grupo) state.grupo.clearLayers();
    state.capasPorId.clear();
    if (qs('archivoRutasDesplazamientos')) qs('archivoRutasDesplazamientos').value = '';
    if (qs('buscarRutasDesplazamientos')) qs('buscarRutasDesplazamientos').value = '';
    renderTodo();
    setEstado('Rutas de desplazamiento limpiadas.');
  }

  function bindUI() {
    qs('btnCargarRutasUnificadas')?.addEventListener('click', () => cargarArchivoUrl(ARCHIVO_UNIFICADO, 'Rutas unificadas II'));
    qs('btnCargarRutasDesplazamientos')?.addEventListener('click', () => qs('archivoRutasDesplazamientos')?.click());
    qs('archivoRutasDesplazamientos')?.addEventListener('change', event => cargarArchivo(event.target.files?.[0]));
    qs('btnAbrirPegarRutasJson')?.addEventListener('click', abrirModalPegarRutas);
    qs('btnLeerPortapapelesRutas')?.addEventListener('click', leerPortapapelesRutas);
    qs('btnValidarTextoRutas')?.addEventListener('click', validarTextoPegadoRutas);
    qs('btnLimpiarTextoRutas')?.addEventListener('click', () => {
      if (qs('textoRutasJsonPegado')) qs('textoRutasJsonPegado').value = '';
      state.registrosPegados = [];
      setBotonesPegado(false);
      if (qs('resultadoValidacionRutasJson')) qs('resultadoValidacionRutasJson').innerHTML = '';
    });
    qs('textoRutasJsonPegado')?.addEventListener('input', () => {
      state.registrosPegados = [];
      setBotonesPegado(false);
    });
    qs('btnAgregarJsonPegadoRutas')?.addEventListener('click', () => aplicarRegistrosPegados('agregar'));
    qs('btnReemplazarJsonPegadoRutas')?.addEventListener('click', () => aplicarRegistrosPegados('reemplazar'));
    qs('btnNuevaRutaDesplazamiento')?.addEventListener('click', crearNuevaRuta);
    qs('btnEliminarRutaDesplazamiento')?.addEventListener('click', eliminarRutaSeleccionada);
    qs('btnLimpiarRutasDesplazamientos')?.addEventListener('click', limpiar);
    qs('btnAjustarRutasDesplazamientos')?.addEventListener('click', ajustarTodas);
    qs('btnExportarRutasDesplazamientos')?.addEventListener('click', exportarJSON);
    qs('buscarRutasDesplazamientos')?.addEventListener('input', () => {
      aplicarFiltro();
      renderLista();
    });
  }

  function initWhenMapReady() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const mapa = window.SIG_STATE?.mapa;
      if (mapa) {
        clearInterval(timer);
        state.mapa = mapa;
        state.grupo = L.layerGroup().addTo(mapa);
        if (window.SIG_STATE) window.SIG_STATE.rutasDesplazamientos = state;
        bindUI();
        renderTodo();
        setEstado('Funcionalidad lista. Puedes cargar rutas, pegar JSON desde portapapeles, validar estructura, crear rutas, buscar coordenadas, mover puntos y exportar el JSON actualizado.');
      } else if (tries > 80) {
        clearInterval(timer);
        setEstado('No se pudo iniciar rutas de desplazamiento porque el mapa aún no está disponible.', 'error');
      }
    }, 100);
  }

  document.addEventListener('DOMContentLoaded', initWhenMapReady);
})();
