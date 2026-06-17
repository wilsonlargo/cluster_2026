/*
  consolasig.js
  Consola inferior tipo terminal para el SIG.
  - Acceso con Supabase Auth.
  - Items de consulta por líneas de comando.
  - No ejecuta SQL libre desde el navegador.
  - Filtra en cliente sobre casos_2026 y, cuando se requiere municipio, cruza con sig_casos_public_2026.
*/
(function () {
  'use strict';

  const VERSION = '20260617-console-terminal-v6-view-compatible';
  const LIMITE_DEFECTO = 80;
  const STORAGE_KEY_COMANDOS = 'sig_consola_terminal_comandos_v6';
  const PALETA_CONSOLA = ['#22d3ee', '#a78bfa', '#f472b6', '#fb923c', '#84cc16', '#60a5fa', '#facc15', '#34d399', '#f87171', '#c084fc'];
  const CAMPOS_CORE = [
    'id', 'id_old', 'fecha_evento', 'macrotipo', 'departamento', 'macroregion',
    'pueblo', 'npersonas', 'nmujeres', 'nhombres', 'nmenores', 'macroactor',
    'contextual_type', 'contextual_info', 'detalle', 'detalle_lugar', 'fuente', 'fechafuente', 'enlace'
  ].join(',');
  const CAMPOS_PUNTOS = [
    'punto_id', 'caso_id', 'id_old', 'fecha_evento', 'anio', 'macrotipo', 'departamento',
    'macroregion', 'municipio', 'lat', 'lng', 'pueblo', 'npersonas', 'nmujeres',
    'nhombres', 'nmenores', 'macroactor', 'contextual_type'
  ].join(',');

  const estado = {
    cliente: null,
    session: null,
    items: [],
    contador: 0,
    iniciado: false,
    visible: false,
    mapaLayers: new Map()
  };

  window.SIG_CONSOLA_VERSION = VERSION;

  function qs(id) { return document.getElementById(id); }

  function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatoNumero(valor) {
    return new Intl.NumberFormat('es-CO').format(Number(valor || 0));
  }

  function normTxt(valor) {
    return String(valor ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function boolValue(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value == null) return false;
    return ['true', '1', 'si', 'sí', 'yes', 'contextual'].includes(normTxt(value));
  }

  function anioDeFecha(fecha) {
    const n = Number(String(fecha || '').slice(0, 4));
    return Number.isInteger(n) ? n : null;
  }

  function extraerTextosDesdeJson(valor, salida = []) {
    if (valor === null || valor === undefined || valor === '') return salida;
    if (typeof valor === 'string' || typeof valor === 'number') {
      const texto = String(valor).trim();
      if (texto) salida.push(texto);
      return salida;
    }
    if (Array.isArray(valor)) {
      valor.forEach(item => extraerTextosDesdeJson(item, salida));
      return salida;
    }
    if (typeof valor === 'object') {
      const preferidas = ['nombre', 'pueblo', 'label', 'name', 'valor', 'value'];
      let usado = false;
      preferidas.forEach(k => {
        if (valor[k] !== undefined && valor[k] !== null) {
          usado = true;
          extraerTextosDesdeJson(valor[k], salida);
        }
      });
      if (!usado) {
        Object.values(valor).forEach(item => extraerTextosDesdeJson(item, salida));
      }
    }
    return salida;
  }

  function valoresPueblo(registro) {
    const vistos = new Set();
    return extraerTextosDesdeJson(registro?.pueblo || [])
      .map(x => String(x).trim())
      .filter(x => {
        const k = normTxt(x);
        if (!k || vistos.has(k)) return false;
        vistos.add(k);
        return true;
      });
  }

  function valorPlano(valor) {
    const textos = extraerTextosDesdeJson(valor || []);
    return textos.length ? textos.join(', ') : String(valor ?? '').trim();
  }


  function urlSeguroConsola(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://${raw}`;
  }

  function recortarTextoConsola(texto, max = 520) {
    const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
    if (!limpio) return '';
    return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
  }

  function actualizarEstadoGlobal(texto) {
    const node = qs('estadoSIG');
    if (node) node.textContent = texto;
  }

  function obtenerCliente() {
    if (estado.cliente) return estado.cliente;
    if (window.SIG_STATE?.supabaseClient) {
      estado.cliente = window.SIG_STATE.supabaseClient;
      return estado.cliente;
    }
    const cfg = window.SIG_CONFIG?.supabase || {};
    const clave = cfg.clavePublica || cfg.publishableKey || cfg.anonKey;
    if (!window.supabase?.createClient || !cfg.url || !clave) return null;
    estado.cliente = window.supabase.createClient(cfg.url, clave);
    if (window.SIG_STATE) window.SIG_STATE.supabaseClient = estado.cliente;
    return estado.cliente;
  }

  async function obtenerSession() {
    const cliente = obtenerCliente();
    if (!cliente?.auth?.getSession) return null;
    const { data } = await cliente.auth.getSession();
    estado.session = data?.session || null;
    return estado.session;
  }

  async function loginConsola() {
    const cliente = obtenerCliente();
    const email = qs('consolaEmail')?.value?.trim();
    const password = qs('consolaPassword')?.value || '';
    if (!cliente || !email || !password) {
      setMensaje('Escribe usuario/correo y contraseña.', 'warn');
      return;
    }
    setMensaje('Validando acceso...', 'info');
    const { data, error } = await cliente.auth.signInWithPassword({ email, password });
    if (error) {
      setMensaje(error.message || 'No se pudo iniciar sesión.', 'error');
      return;
    }
    estado.session = data?.session || null;
    if (qs('consolaPassword')) qs('consolaPassword').value = '';
    pintarAuth();
    setMensaje('Sesión activa. Ya puedes ejecutar consultas.', 'ok');
  }

  async function logoutConsola() {
    const cliente = obtenerCliente();
    await cliente?.auth?.signOut?.();
    estado.session = null;
    pintarAuth();
    setMensaje('Sesión cerrada.', 'info');
  }

  function setMensaje(texto, tipo = 'info') {
    const node = qs('consolaMensaje');
    if (!node) return;
    node.className = `sig-console-msg sig-console-msg-${tipo}`;
    node.textContent = texto || '';
  }

  function pintarAuth() {
    const host = qs('consolaAuthZona');
    if (!host) return;
    const user = estado.session?.user?.email || '';
    if (user) {
      host.innerHTML = `
        <span class="sig-console-user">${escapeHtml(user)}</span>
        <button class="sig-console-btn" id="btnConsolaLogout" type="button">Salir</button>
      `;
      qs('btnConsolaLogout')?.addEventListener('click', logoutConsola);
    } else {
      host.innerHTML = `
        <input id="consolaEmail" class="sig-console-input" type="email" autocomplete="username" placeholder="usuario/correo" />
        <input id="consolaPassword" class="sig-console-input" type="password" autocomplete="current-password" placeholder="contraseña" />
        <button class="sig-console-btn sig-console-btn-primary" id="btnConsolaLogin" type="button">Acceder</button>
      `;
      qs('btnConsolaLogin')?.addEventListener('click', loginConsola);
      qs('consolaPassword')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') loginConsola();
      });
    }
  }

  async function fetchBatched(cliente, tabla, columnas, opciones = {}) {
    const cfg = window.SIG_CONFIG?.supabase || {};
    const batchSize = Number(cfg.batchCasosCore || 1000);
    const registros = [];
    let desde = 0;
    while (true) {
      const hasta = desde + batchSize - 1;
      let q = cliente.from(tabla).select(columnas).range(desde, hasta);
      if (opciones.ordenFecha !== false && columnas.includes('fecha_evento')) {
        q = q.order('fecha_evento', { ascending: false, nullsFirst: false });
      }
      const { data, error } = await q;
      if (error) throw error;
      const lote = Array.isArray(data) ? data : [];
      registros.push(...lote);
      if (lote.length < batchSize) break;
      desde += batchSize;
    }
    return registros;
  }

  async function obtenerCore({ refrescar = false } = {}) {
    const state = window.SIG_STATE || {};
    if (!refrescar && Array.isArray(state.consolaCoreRegistros)) return state.consolaCoreRegistros;
    const cliente = obtenerCliente();
    const tabla = window.SIG_CONFIG?.supabase?.tablaCasos || 'casos_2026';
    const registros = await fetchBatched(cliente, tabla, CAMPOS_CORE);
    state.consolaCoreRegistros = registros;
    return registros;
  }

  async function obtenerPuntos({ refrescar = false } = {}) {
    const state = window.SIG_STATE || {};
    if (!refrescar && Array.isArray(state.consolaPuntosRegistros)) return state.consolaPuntosRegistros;
    const cliente = obtenerCliente();
    const vista = window.SIG_CONFIG?.supabase?.vistaCasos || 'sig_casos_public_2026';
    const registros = await fetchBatched(cliente, vista, CAMPOS_PUNTOS);
    state.consolaPuntosRegistros = registros;
    return registros;
  }



  function obtenerColorItem(index = 0) {
    return PALETA_CONSOLA[Math.abs(Number(index || 0)) % PALETA_CONSOLA.length] || '#22d3ee';
  }

  function normalizarLng(lng) {
    const n = Number(lng);
    if (!Number.isFinite(n)) return null;
    return n > 0 && n <= 90 ? -Math.abs(n) : n;
  }

  function coordenadaValida(registro) {
    const lat = Number(registro?.lat);
    const lng = normalizarLng(registro?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  async function obtenerPuntosConCore({ refrescar = false } = {}) {
    const core = await obtenerCore({ refrescar });
    const puntos = await obtenerPuntos({ refrescar });
    const coreById = new Map(core.map(r => [String(r.id), r]));
    return (puntos || []).map(p => {
      const base = coreById.get(String(p.caso_id)) || {};
      return {
        ...base,
        ...p,
        id: base.id || p.caso_id,
        caso_id: p.caso_id || base.id,
        detalle: base.detalle ?? p.detalle,
        detalle_lugar: base.detalle_lugar ?? p.detalle_lugar,
        fuente: base.fuente ?? p.fuente,
        fechafuente: base.fechafuente ?? p.fechafuente,
        enlace: base.enlace ?? p.enlace,
        contextual_info: base.contextual_info ?? p.contextual_info,
        lng: normalizarLng(p.lng)
      };
    });
  }

  function asegurarCapaConsolaMapa() {
    const state = window.SIG_STATE;
    const mapa = state?.mapa;
    if (!mapa || !window.L) return null;
    if (!state.capaConsolaSIG) {
      state.capaConsolaSIG = L.layerGroup().addTo(mapa);
    }
    const pane = mapa.getPane('paneCasosTop') || mapa.getPane('pane9');
    if (pane) {
      pane.style.zIndex = '1000';
      pane.style.pointerEvents = 'auto';
    }
    const popupPane = mapa.getPane('panePopupsTop') || mapa.createPane?.('panePopupsTop');
    if (popupPane) {
      popupPane.style.zIndex = '1300';
      popupPane.style.pointerEvents = 'auto';
    }
    return state.capaConsolaSIG;
  }

  function crearPopupMarcadorConsola(registro, item, parsed) {
    const enlaceUrl = urlSeguroConsola(registro.enlace);
    const detalle = recortarTextoConsola(registro.detalle, 620);
    const detalleLugar = recortarTextoConsola(registro.detalle_lugar, 260);
    const contexto = recortarTextoConsola(registro.contextual_info, 420);
    const filas = [
      ['Consulta', item?.comando || parsed?.raw || ''],
      ['Caso', registro.id_old || registro.caso_id || registro.id || ''],
      ['Fecha evento', registro.fecha_evento || ''],
      ['Departamento', registro.departamento || ''],
      ['Municipio', registro.municipio || ''],
      ['Macrotipo', registro.macrotipo || ''],
      ['Pueblo', valorPlano(registro.pueblo)],
      ['Macroactor', registro.macroactor || ''],
      ['Fuente', registro.fuente || ''],
      ['Fecha fuente', registro.fechafuente || ''],
      ['Personas', formatoNumero(registro.npersonas)],
      ['Mujeres', formatoNumero(registro.nmujeres)],
      ['Hombres', formatoNumero(registro.nhombres)],
      ['Menores', formatoNumero(registro.nmenores)]
    ].filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '' && String(v).trim() !== '0')
      .map(([k, v]) => `<tr><th class="text-muted pe-2">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
      .join('');

    const bloqueDetalleLugar = detalleLugar
      ? `<div class="mt-2"><div class="fw-semibold small text-muted">Detalle lugar</div><div class="small">${escapeHtml(detalleLugar)}</div></div>`
      : '';
    const bloqueDetalle = detalle
      ? `<div class="mt-2"><div class="fw-semibold small text-muted">Detalle del caso</div><div class="small">${escapeHtml(detalle)}</div></div>`
      : '';
    const bloqueContexto = contexto
      ? `<div class="mt-2"><div class="fw-semibold small text-muted">Información contextual</div><div class="small">${escapeHtml(contexto)}</div></div>`
      : '';
    const enlace = enlaceUrl
      ? `<div class="mt-2"><a href="${escapeHtml(enlaceUrl)}" target="_blank" rel="noopener noreferrer">Abrir enlace fuente</a></div>`
      : '';

    return `
      <div style="min-width:300px; max-width:480px">
        <div class="fw-bold mb-1"><span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${escapeHtml(item?.color || '#22d3ee')};border:1px solid #fff;margin-right:6px"></span>Marcador de consola</div>
        <div class="small text-muted mb-2">Punto acumulado por línea de consulta</div>
        <table class="table table-sm mb-0"><tbody>${filas}</tbody></table>
        ${bloqueDetalleLugar}
        ${bloqueDetalle}
        ${bloqueContexto}
        ${enlace}
      </div>
    `;
  }

  function limpiarMarcadoresItem(item) {
    if (!item) return;
    const state = window.SIG_STATE;
    if (item.markerLayer && state?.mapa) {
      try { state.mapa.removeLayer(item.markerLayer); } catch (_) {}
    }
    if (item.markerLayer && window.SIG_STATE?.capaConsolaSIG?.removeLayer) {
      try { window.SIG_STATE.capaConsolaSIG.removeLayer(item.markerLayer); } catch (_) {}
    }
    if (item.id && estado.mapaLayers?.has(item.id)) estado.mapaLayers.delete(item.id);
    item.markerLayer = null;
    item.markerCount = 0;
  }

  function limpiarTodosMarcadoresConsola() {
    (estado.items || []).forEach(item => limpiarMarcadoresItem(item));
    if (window.SIG_STATE?.capaConsolaSIG?.clearLayers) window.SIG_STATE.capaConsolaSIG.clearLayers();
    estado.mapaLayers = new Map();
  }

  async function pintarMarcadoresConsulta(item, parsed, puntosFiltrados) {
    const contenedor = asegurarCapaConsolaMapa();
    const mapa = window.SIG_STATE?.mapa;
    if (!contenedor || !mapa || !window.L || !item) return 0;

    limpiarMarcadoresItem(item);

    const color = item.color || obtenerColorItem(estado.items.indexOf(item));
    const grupo = L.layerGroup();
    const bounds = L.latLngBounds([]);
    let count = 0;
    const renderer = L.canvas({ padding: 0.5, pane: 'paneCasosTop' });

    (puntosFiltrados || []).forEach(registro => {
      if (!coordenadaValida(registro)) return;
      const lat = Number(registro.lat);
      const lng = normalizarLng(registro.lng);
      const marker = L.circleMarker([lat, lng], {
        pane: 'paneCasosTop',
        renderer,
        radius: 6,
        color: '#ffffff',
        weight: 1.2,
        opacity: 0.95,
        fillColor: color,
        fillOpacity: 0.78,
        bubblingMouseEvents: false
      });
      marker._sigConsolaItemId = item.id;
      marker._sigRegistro = registro;
      marker.bindPopup(() => crearPopupMarcadorConsola(registro, item, parsed), {
        pane: 'panePopupsTop',
        maxWidth: 480,
        autoPan: true,
        closeButton: true
      });
      marker.on('click', event => {
        if (event?.originalEvent) {
          L.DomEvent.stopPropagation(event.originalEvent);
          L.DomEvent.preventDefault(event.originalEvent);
        }
        L.popup({ pane: 'panePopupsTop', maxWidth: 500, autoPan: true, closeButton: true })
          .setLatLng(event.latlng)
          .setContent(crearPopupMarcadorConsola(registro, item, parsed))
          .openOn(mapa);
      });
      marker.addTo(grupo);
      if (marker.bringToFront) marker.bringToFront();
      bounds.extend([lat, lng]);
      count += 1;
    });

    if (contenedor.addLayer) contenedor.addLayer(grupo);
    else grupo.addTo(mapa);
    item.markerLayer = grupo;
    item.markerCount = count;
    estado.mapaLayers.set(item.id, grupo);

    if (bounds.isValid()) {
      mapa.fitBounds(bounds.pad(0.15), { maxZoom: 9 });
    }
    return count;
  }

  function requierePuntos(parsed) {
    if (normTxt(parsed.grupo) === 'municipio') return true;
    return (parsed.filtros || []).some(f => ['municipio', 'lat', 'lng'].includes(f.campo));
  }

  async function obtenerBase(parsed, { refrescar = false } = {}) {
    const core = await obtenerCore({ refrescar });
    if (!requierePuntos(parsed)) return core;

    const puntos = await obtenerPuntos({ refrescar });
    const coreById = new Map(core.map(r => [String(r.id), r]));
    return (puntos || []).map(p => {
      const base = coreById.get(String(p.caso_id)) || {};
      return {
        ...base,
        ...p,
        id: base.id || p.caso_id,
        caso_id: p.caso_id || base.id,
        detalle: base.detalle ?? p.detalle,
        detalle_lugar: base.detalle_lugar ?? p.detalle_lugar,
        fuente: base.fuente ?? p.fuente,
        fechafuente: base.fechafuente ?? p.fechafuente,
        enlace: base.enlace ?? p.enlace,
        contextual_info: base.contextual_info ?? p.contextual_info
      };
    });
  }

  function tokenizarComando(texto) {
    const tokens = [];
    const re = /([^\s:"'=!<>~]+)\s*(>=|<=|!=|=|:|>|<|~)\s*("[^"]*"|'[^']*'|[^\s]+)/g;
    let m;
    while ((m = re.exec(texto || '')) !== null) {
      let valor = String(m[3] || '').trim();
      if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
        valor = valor.slice(1, -1);
      }
      tokens.push({ key: m[1], op: m[2], value: valor });
    }
    return tokens;
  }

  function normalizarCampo(campo) {
    const c = normTxt(campo).replace(/-/g, '_');
    const alias = {
      ano: 'anio', año: 'anio', anio: 'anio', year: 'anio',
      grupo: 'grupo', agrupar: 'grupo', por: 'grupo', group: 'grupo',
      limite: 'limite', limit: 'limite', top: 'limite',
      ordenar: 'ordenar', orden: 'ordenar', order: 'ordenar',
      personas: 'npersonas', victimas: 'npersonas', victimas_total: 'npersonas',
      mujeres: 'nmujeres', hombres: 'nhombres', menores: 'nmenores',
      fecha: 'fecha_evento', fechafuente: 'fechafuente', fecha_fuente: 'fechafuente',
      detallelugar: 'detalle_lugar', lugar_detalle: 'detalle_lugar',
      contexto: 'contextual_info', contextualinfo: 'contextual_info',
      contextual: 'contextual_type', caso_contextual: 'contextual_type',
      depto: 'departamento', dpto: 'departamento', municipio: 'municipio',
      pueblo: 'pueblo', macrotipo: 'macrotipo', macroactor: 'macroactor',
      fuente: 'fuente', enlace: 'enlace', texto: 'texto', buscar: 'texto', q: 'texto',
      refrescar: 'refrescar'
    };
    return alias[c] || c;
  }

  function esOperadorMultiValor(op) {
    return [':', '=', '~'].includes(op || ':');
  }

  function dividirValoresMultiples(valor, op) {
    const texto = String(valor ?? '').trim();
    if (!texto) return [];
    if (!esOperadorMultiValor(op)) return [texto];

    // Permite escribir: año:2025,2026 / departamento:Cauca|Chocó
    // Si el valor está entre comillas y contiene coma, se conserva como frase literal.
    if (!/[|,]/.test(texto)) return [texto];
    return texto
      .split(/[|,]/g)
      .map(x => x.trim())
      .filter(Boolean);
  }

  function parseCommand(comando) {
    const parsed = {
      raw: comando || '',
      grupo: 'departamento',
      ordenar: 'casos',
      limite: LIMITE_DEFECTO,
      refrescar: false,
      filtros: []
    };
    const tokens = tokenizarComando(comando);
    for (const t of tokens) {
      const campo = normalizarCampo(t.key);
      const valor = String(t.value ?? '').trim();
      if (!campo || !valor) continue;
      if (campo === 'grupo') parsed.grupo = normTxt(valor) || 'departamento';
      else if (campo === 'ordenar') parsed.ordenar = normTxt(valor) || 'casos';
      else if (campo === 'limite') parsed.limite = Math.max(1, Math.min(1000, Number(valor) || LIMITE_DEFECTO));
      else if (campo === 'refrescar') parsed.refrescar = boolValue(valor);
      else {
        dividirValoresMultiples(valor, t.op).forEach(v => {
          parsed.filtros.push({ campo, op: t.op, valor: v });
        });
      }
    }
    return parsed;
  }

  function idCaso(registro) {
    return String(registro.id || registro.caso_id || registro.id_old || registro.punto_id || '');
  }

  function valorCampo(registro, campo) {
    if (campo === 'anio') return anioDeFecha(registro.fecha_evento) || Number(registro.anio || 0) || '';
    if (campo === 'pueblo') return valoresPueblo(registro).join(' | ');
    if (campo === 'contextual_type') return boolValue(registro.contextual_type) ? 'true' : 'false';
    if (campo === 'texto') {
      return [
        registro.id_old, registro.fecha_evento, registro.macrotipo, registro.departamento, registro.macroregion,
        registro.municipio, registro.macroactor, registro.fuente, registro.fechafuente, registro.enlace,
        registro.detalle, registro.detalle_lugar, registro.contextual_info, valorPlano(registro.pueblo)
      ].join(' ');
    }
    return registro?.[campo];
  }

  function comparar(valorRegistro, filtro) {
    const op = filtro.op || ':';
    const valorFiltro = filtro.valor;

    const nReg = Number(valorRegistro);
    const nFil = Number(valorFiltro);
    const ambosNumericos = Number.isFinite(nReg) && Number.isFinite(nFil) && String(valorFiltro).trim() !== '';

    if (ambosNumericos && ['>', '<', '>=', '<=', '=', '!=', ':'].includes(op)) {
      if (op === '>') return nReg > nFil;
      if (op === '<') return nReg < nFil;
      if (op === '>=') return nReg >= nFil;
      if (op === '<=') return nReg <= nFil;
      if (op === '!=') return nReg !== nFil;
      return nReg === nFil;
    }

    const a = normTxt(valorRegistro);
    const b = normTxt(valorFiltro);
    if (op === '!=') return !a.includes(b);
    if (op === '=' ) return a === b;
    if (op === '~' || op === ':') return a.includes(b);
    if (op === '>') return String(valorRegistro || '') > String(valorFiltro || '');
    if (op === '<') return String(valorRegistro || '') < String(valorFiltro || '');
    if (op === '>=') return String(valorRegistro || '') >= String(valorFiltro || '');
    if (op === '<=') return String(valorRegistro || '') <= String(valorFiltro || '');
    return a.includes(b);
  }

  function esFiltroOrRepetible(filtro) {
    // Repetir un mismo campo con operadores de coincidencia se interpreta como OR.
    // Ejemplo: año:2025 año:2026 equivale a año 2025 O 2026.
    // En cambio personas>100 personas<500 sigue siendo AND para permitir rangos.
    return esOperadorMultiValor(filtro?.op);
  }

  function coincideRegistro(registro, parsed) {
    const filtros = parsed.filtros || [];
    const gruposOr = new Map();

    for (const filtro of filtros) {
      const campo = filtro.campo;

      if (esFiltroOrRepetible(filtro)) {
        const key = `${campo}__${filtro.op || ':'}`;
        if (!gruposOr.has(key)) gruposOr.set(key, []);
        gruposOr.get(key).push(filtro);
        continue;
      }

      const valor = valorCampo(registro, campo);
      if (!comparar(valor, filtro)) return false;
    }

    for (const grupo of gruposOr.values()) {
      if (!grupo.length) continue;
      const campo = grupo[0].campo;
      const valor = valorCampo(registro, campo);
      if (!grupo.some(filtro => comparar(valor, filtro))) return false;
    }

    return true;
  }

  function clavesAgrupacion(registro, grupoRaw) {
    const grupo = normalizarCampo(grupoRaw || 'departamento');
    if (grupo === 'total') return ['Total filtrado'];
    if (grupo === 'anio') return [String(anioDeFecha(registro.fecha_evento) || registro.anio || 'Sin año')];
    if (grupo === 'pueblo') {
      const pueblos = valoresPueblo(registro);
      return pueblos.length ? pueblos : ['Sin pueblo'];
    }
    if (grupo === 'contextual_type' || grupo === 'contextual') return [boolValue(registro.contextual_type) ? 'Contextual' : 'No contextual'];
    const valor = valorCampo(registro, grupo);
    if (Array.isArray(valor)) return valor.length ? valor : ['Sin categoría'];
    const txt = String(valor ?? '').trim();
    if (!txt) return [`Sin ${grupoRaw || 'categoría'}`];
    if (grupo === 'detalle' || grupo === 'contextual_info') return [txt.length > 90 ? `${txt.slice(0, 90)}…` : txt];
    return [txt];
  }

  function agregarAGrupo(mapa, claveVisible, registro) {
    const key = normTxt(claveVisible) || 'sin-categoria';
    if (!mapa.has(key)) {
      mapa.set(key, {
        key,
        categoria: claveVisible || 'Sin categoría',
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
    const g = mapa.get(key);
    const id = idCaso(registro) || `${g.key}-${g.casos}`;
    if (g.ids.has(id)) return;
    g.ids.add(id);
    g.casos += 1;
    g.personas += Number(registro.npersonas || 0);
    g.mujeres += Number(registro.nmujeres || 0);
    g.hombres += Number(registro.nhombres || 0);
    g.menores += Number(registro.nmenores || 0);
  }

  function resumenUnico(registros) {
    const vistos = new Set();
    const r = { casos: 0, personas: 0, mujeres: 0, hombres: 0, menores: 0 };
    (registros || []).forEach(registro => {
      const id = idCaso(registro) || JSON.stringify(registro).slice(0, 80);
      if (vistos.has(id)) return;
      vistos.add(id);
      r.casos += 1;
      r.personas += Number(registro.npersonas || 0);
      r.mujeres += Number(registro.nmujeres || 0);
      r.hombres += Number(registro.nhombres || 0);
      r.menores += Number(registro.nmenores || 0);
    });
    return r;
  }

  function percentil(lista, p) {
    const valores = (lista || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!valores.length) return 0;
    if (valores.length === 1) return valores[0];
    const idx = (valores.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const peso = idx - lo;
    return valores[lo] * (1 - peso) + valores[hi] * peso;
  }

  function calcularIDR(rows, totales) {
    const intensidades = rows.map(r => r.casos > 0 ? r.personas / r.casos : 0);
    const p95 = percentil(intensidades, 0.95) || Math.max(...intensidades, 0) || 0;
    rows.forEach(r => {
      const exposicion = totales.casos > 0 ? r.casos / totales.casos : 0;
      const impacto = totales.personas > 0 ? r.personas / totales.personas : 0;
      r.intensidadRaw = r.casos > 0 ? r.personas / r.casos : 0;
      const intensidadNormalizada = p95 > 0 ? Math.min(r.intensidadRaw, p95) / p95 : 0;
      r.idr = 100 * (0.35 * exposicion + 0.40 * impacto + 0.25 * intensidadNormalizada);
      r.rango = r.idr >= 75 ? 'Muy alto' : r.idr >= 50 ? 'Alto' : r.idr >= 25 ? 'Medio' : r.idr > 0 ? 'Bajo' : 'Sin registro';
    });
    return rows;
  }

  async function ejecutarItem(item) {
    if (!estado.session) {
      setMensaje('Inicia sesión para ejecutar consultas.', 'warn');
      return;
    }
    const result = qs(`${item.id}-resultado`);
    const btn = qs(`${item.id}-ejecutar`);
    const textarea = qs(`${item.id}-cmd`);
    if (!result || !textarea) return;

    item.comando = textarea.value || '';
    const parsed = parseCommand(item.comando);
    result.innerHTML = '<div class="sig-console-loading">Procesando consulta y dibujando puntos...</div>';
    item.resultHtml = result.innerHTML;
    const old = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '...';
    }

    try {
      const base = await obtenerBase(parsed, { refrescar: parsed.refrescar });
      const filtrados = (base || []).filter(r => coincideRegistro(r, parsed));
      const totales = resumenUnico(filtrados);
      const grupos = new Map();
      filtrados.forEach(registro => {
        clavesAgrupacion(registro, parsed.grupo).forEach(clave => agregarAGrupo(grupos, clave, registro));
      });

      let rows = calcularIDR(Array.from(grupos.values()).map(g => ({ ...g, ids: undefined })), totales);
      rows.sort((a, b) => {
        const orden = parsed.ordenar || 'casos';
        if (orden === 'personas') return b.personas - a.personas || b.casos - a.casos;
        if (orden === 'idr') return b.idr - a.idr || b.casos - a.casos;
        if (orden === 'categoria') return a.categoria.localeCompare(b.categoria, 'es', { sensitivity: 'base' });
        if (orden === 'mujeres') return b.mujeres - a.mujeres || b.casos - a.casos;
        if (orden === 'hombres') return b.hombres - a.hombres || b.casos - a.casos;
        if (orden === 'menores') return b.menores - a.menores || b.casos - a.casos;
        return b.casos - a.casos || b.personas - a.personas;
      });
      rows = rows.slice(0, parsed.limite || LIMITE_DEFECTO);

      // Los marcadores se calculan siempre desde la vista municipal con coordenadas,
      // pero se cruzan con casos_2026 para que funcionen detalle, fuente, contexto, etc.
      let puntosFiltrados = [];
      try {
        const puntosBase = await obtenerPuntosConCore({ refrescar: parsed.refrescar });
        puntosFiltrados = (puntosBase || []).filter(r => coincideRegistro(r, parsed));
      } catch (e) {
        console.warn('No se pudieron cargar puntos de consola:', e);
      }
      const puntosMapa = await pintarMarcadoresConsulta(item, parsed, puntosFiltrados);

      item.rows = rows;
      item.totales = totales;
      item.tsv = crearTSVResultado({ parsed, rows, totales, puntos: puntosMapa });
      item.resultHtml = renderResultado({ parsed, rows, totales, totalRegistros: filtrados.length, puntos: puntosMapa, fecha: new Date() });
      result.innerHTML = item.resultHtml;

      setMensaje(`Consulta ejecutada · ${formatoNumero(totales.casos)} casos · ${formatoNumero(totales.personas)} personas · ${formatoNumero(puntosMapa)} puntos`, 'ok');
      actualizarEstadoGlobal(`Consola · ${formatoNumero(totales.casos)} casos · ${formatoNumero(puntosMapa)} puntos`);
    } catch (err) {
      item.resultHtml = `<div class="sig-console-error">${escapeHtml(err?.message || 'Error al ejecutar consulta.')}</div>`;
      result.innerHTML = item.resultHtml;
      setMensaje(err?.message || 'Error al ejecutar consulta.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = old || '➜';
      }
    }
  }


  function crearTSVResultado(res) {
    const rows = res.rows || [];
    const headers = ['#', 'Categoria', 'Casos', 'Personas', 'Mujeres', 'Hombres', 'Menores', 'IDR', 'Rango'];
    const lines = [];
    lines.push(`Consulta\t${res.parsed?.raw || ''}`);
    lines.push(`Grupo\t${res.parsed?.grupo || ''}`);
    lines.push(`Total casos\t${res.totales?.casos || 0}`);
    lines.push(`Total personas\t${res.totales?.personas || 0}`);
    lines.push(`Puntos mapa\t${res.puntos || 0}`);
    lines.push('');
    lines.push(headers.join('\t'));
    rows.forEach((r, i) => {
      lines.push([
        i + 1,
        String(r.categoria || '').replace(/\t/g, ' '),
        r.casos || 0,
        r.personas || 0,
        r.mujeres || 0,
        r.hombres || 0,
        r.menores || 0,
        Number(r.idr || 0).toFixed(2),
        r.rango || ''
      ].join('\t'));
    });
    return lines.join('\n');
  }

  async function copiarTablaItem(item) {
    if (!item) return;
    const texto = item.tsv || crearTSVResultado({ parsed: parseCommand(item.comando || ''), rows: item.rows || [], totales: item.totales || {}, puntos: item.markerCount || 0 });
    if (!texto.trim()) {
      setMensaje('No hay tabla para copiar. Ejecuta primero la consulta.', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(texto);
      setMensaje('Tabla copiada en formato tabulado. Puedes pegarla en Excel o Word.', 'ok');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = texto;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setMensaje('Tabla copiada.', 'ok');
    }
  }

  function renderResultado(res) {
    const rows = res.rows || [];
    const filas = rows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="sig-console-cat">${escapeHtml(r.categoria)}</td>
        <td class="text-end">${formatoNumero(r.casos)}</td>
        <td class="text-end">${formatoNumero(r.personas)}</td>
        <td class="text-end">${formatoNumero(r.mujeres)}</td>
        <td class="text-end">${formatoNumero(r.hombres)}</td>
        <td class="text-end">${formatoNumero(r.menores)}</td>
        <td class="text-end">${Number(r.idr || 0).toFixed(2)}</td>
        <td>${escapeHtml(r.rango)}</td>
      </tr>
    `).join('');

    return `
      <div class="sig-console-summary">
        <span>grupo:${escapeHtml(res.parsed.grupo)}</span>
        <span>casos:${formatoNumero(res.totales.casos)}</span>
        <span>personas:${formatoNumero(res.totales.personas)}</span>
        <span>filas:${formatoNumero(rows.length)}</span>
        <span class="sig-console-map-pill">puntos:${formatoNumero(res.puntos || 0)}</span>
        <span>${escapeHtml(res.fecha.toLocaleString('es-CO'))}</span>
      </div>
      <div class="sig-console-table-wrap">
        <table class="sig-console-table">
          <thead>
            <tr>
              <th>#</th><th>Categoría</th><th>Casos</th><th>Personas</th><th>Mujeres</th><th>Hombres</th><th>Menores</th><th>IDR</th><th>Rango</th>
            </tr>
          </thead>
          <tbody>${filas || '<tr><td colspan="9" class="sig-console-empty-cell">Sin resultados</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  function crearItem(comando) {
    estado.contador += 1;
    const id = `cmd-${Date.now()}-${estado.contador}`;
    const item = { id, comando: comando || '', color: obtenerColorItem(estado.contador - 1), resultHtml: '', rows: [], totales: null, tsv: '', markerLayer: null, markerCount: 0 };
    estado.items.push(item);
    renderItems();
    const ta = qs(`${id}-cmd`);
    if (ta) ta.focus();
    return item;
  }

  function renderItems() {
    const host = qs('consolaItems');
    if (!host) return;
    host.innerHTML = '';
    if (!estado.items.length) {
      host.innerHTML = '<div class="sig-console-empty">Agrega una línea de consulta. Ejemplo: <code>grupo:departamento año:2025 año:2026 detalle:"amenaza" personas&gt;100</code></div>';
      return;
    }

    estado.items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'sig-console-item';
      row.innerHTML = `
        <div class="sig-console-line">
          <span class="sig-console-prompt"><span class="sig-console-marker-dot" style="background:${escapeHtml(item.color || obtenerColorItem(index))}"></span>${index + 1} &gt;</span>
          <textarea id="${item.id}-cmd" class="sig-console-textarea" spellcheck="false">${escapeHtml(item.comando)}</textarea>
          <button id="${item.id}-ejecutar" class="sig-console-icon sig-console-run" title="Ejecutar y dibujar puntos" type="button">➜</button>
          <button id="${item.id}-copiar" class="sig-console-icon sig-console-copy" title="Copiar tabla" type="button">⧉</button>
          <button id="${item.id}-limpiar" class="sig-console-icon sig-console-clear" title="Limpiar resultado y marcadores de esta línea" type="button">×</button>
          <button id="${item.id}-borrar" class="sig-console-icon sig-console-delete" title="Eliminar item" type="button">⌧</button>
        </div>
        <div id="${item.id}-resultado" class="sig-console-result">${item.resultHtml || ''}</div>
      `;
      host.appendChild(row);
      qs(`${item.id}-ejecutar`)?.addEventListener('click', () => ejecutarItem(item));
      qs(`${item.id}-copiar`)?.addEventListener('click', () => copiarTablaItem(item));
      qs(`${item.id}-limpiar`)?.addEventListener('click', () => {
        limpiarMarcadoresItem(item);
        item.resultHtml = '';
        item.rows = [];
        item.totales = null;
        item.tsv = '';
        const res = qs(`${item.id}-resultado`);
        if (res) res.innerHTML = '';
        setMensaje('Resultado y marcadores de la línea limpiados.', 'info');
      });
      qs(`${item.id}-borrar`)?.addEventListener('click', () => {
        limpiarMarcadoresItem(item);
        estado.items = estado.items.filter(x => x.id !== item.id);
        renderItems();
      });
      qs(`${item.id}-cmd`)?.addEventListener('input', e => { item.comando = e.target.value || ''; });
      qs(`${item.id}-cmd`)?.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') ejecutarItem(item);
      });
    });
  }

  function agregarDesdeInput() {
    const input = qs('consolaComando');
    const preset = qs('consolaPreset')?.value || '';
    const comando = (input?.value || '').trim() || preset || 'grupo:departamento año:2026';
    crearItem(comando);
    if (input) input.value = '';
  }



  function sincronizarComandosDesdeTextareas() {
    (estado.items || []).forEach(item => {
      const ta = qs(`${item.id}-cmd`);
      if (ta) item.comando = ta.value || '';
    });
  }

  function payloadListaComandos() {
    sincronizarComandosDesdeTextareas();
    return {
      version: VERSION,
      fecha: new Date().toISOString(),
      comandos: (estado.items || []).map(item => ({ comando: item.comando || '', color: item.color || null })).filter(x => String(x.comando || '').trim())
    };
  }

  function guardarListaComandos() {
    const payload = payloadListaComandos();
    if (!payload.comandos.length) {
      setMensaje('No hay comandos para guardar.', 'warn');
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY_COMANDOS, JSON.stringify(payload));
    } catch (_) {}

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sig-comandos-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setMensaje(`Lista guardada · ${payload.comandos.length} comandos.`, 'ok');
  }

  function cargarComandosDesdePayload(payload, { reemplazar = true } = {}) {
    let lista = [];
    if (Array.isArray(payload)) lista = payload;
    else if (Array.isArray(payload?.comandos)) lista = payload.comandos;
    else if (typeof payload?.comando === 'string') lista = [payload];

    const comandos = lista.map(x => typeof x === 'string' ? { comando: x } : x)
      .map(x => ({ comando: String(x.comando || '').trim(), color: x.color || null }))
      .filter(x => x.comando);

    if (!comandos.length) {
      setMensaje('El archivo no trae comandos válidos.', 'warn');
      return;
    }

    if (reemplazar) {
      limpiarTodosMarcadoresConsola();
      estado.items = [];
    }

    comandos.forEach((x, i) => {
      const item = crearItem(x.comando);
      if (x.color) item.color = x.color;
    });
    renderItems();
    setMensaje(`Lista cargada · ${comandos.length} comandos.`, 'ok');
  }

  function abrirCargaLista() {
    qs('archivoConsolaLista')?.click();
  }

  async function procesarArchivoLista(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
      const txt = await file.text();
      const payload = JSON.parse(txt);
      cargarComandosDesdePayload(payload, { reemplazar: true });
    } catch (e) {
      setMensaje('No se pudo leer la lista de comandos. Revisa que sea JSON válido.', 'error');
    } finally {
      if (event?.target) event.target.value = '';
    }
  }

  function cargarUltimaListaLocal() {
    try {
      const txt = localStorage.getItem(STORAGE_KEY_COMANDOS);
      if (!txt) return false;
      cargarComandosDesdePayload(JSON.parse(txt), { reemplazar: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function ejecutarTodo() {
    for (const item of [...estado.items]) {
      await ejecutarItem(item);
    }
  }

  function limpiarTodo() {
    limpiarTodosMarcadoresConsola();
    estado.items = [];
    renderItems();
    setMensaje('Consola limpia. También se retiraron los marcadores de consola.', 'info');
  }

  function mostrarConsola() {
    const dock = qs('consolaSIGDock');
    if (!dock) return;
    dock.classList.remove('collapsed');
    estado.visible = true;
    setTimeout(() => qs('consolaComando')?.focus(), 80);
  }

  function ocultarConsola() {
    const dock = qs('consolaSIGDock');
    if (!dock) return;
    dock.classList.add('collapsed');
    estado.visible = false;
  }

  function toggleConsola() {
    if (estado.visible) ocultarConsola();
    else mostrarConsola();
  }

  function renderInicial() {
    const dock = qs('consolaSIGDock');
    if (!dock) return;
    pintarAuth();
    renderItems();
    setMensaje('Sintaxis: campo:valor, año:2025 año:2026, campo="valor exacto", personas>100. Cada ejecución dibuja sus puntos; × limpia solo esa línea. ⧉ copia tabla.', 'info');
  }

  async function inicializar() {
    if (estado.iniciado) return;
    estado.iniciado = true;
    obtenerCliente();
    await obtenerSession();
    renderInicial();

    qs('btnToggleConsolaSIG')?.addEventListener('click', e => {
      e.preventDefault();
      toggleConsola();
    });
    qs('btnCerrarConsolaSIG')?.addEventListener('click', ocultarConsola);
    qs('btnConsolaAgregar')?.addEventListener('click', agregarDesdeInput);
    qs('btnConsolaEjecutarTodo')?.addEventListener('click', ejecutarTodo);
    qs('btnConsolaGuardarLista')?.addEventListener('click', guardarListaComandos);
    qs('btnConsolaCargarLista')?.addEventListener('click', abrirCargaLista);
    qs('archivoConsolaLista')?.addEventListener('change', procesarArchivoLista);
    qs('btnConsolaLimpiarTodo')?.addEventListener('click', limpiarTodo);
    qs('consolaComando')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        agregarDesdeInput();
      }
    });
    qs('consolaPreset')?.addEventListener('change', () => {
      const val = qs('consolaPreset')?.value || '';
      if (val && qs('consolaComando')) qs('consolaComando').value = val;
    });
  }

  window.SIG_CONSOLA = { inicializar, toggleConsola, mostrarConsola, ocultarConsola, parseCommand };
  document.addEventListener('DOMContentLoaded', inicializar);
})();
