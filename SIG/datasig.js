/*
  datasig.js
  Reconstrucción controlada del módulo SIG.

  Esta versión agrega filtros combinados sobre casos_2026: año, departamento,
  macrotipo, pueblo, macroactor y filtro poblacional. Los resúmenes se calculan
  siempre desde casos_2026, aunque el caso no tenga municipio, lugar o coordenada.
  El mapa solo dibuja los puntos disponibles en sig_casos_public_2026, que toma
  municipio, lat y lng desde caso_municipio_2026.

  No usa RPC, no usa tablas ligeras antiguas, no consulta lugares y no incorpora consola avanzada.
*/
(function () {
  'use strict';

  const VERSION = '20260615-sig-panel-filtros-blanco-v2';
  const ANIO_INICIO = 2016;

  const CAMPOS_CORE_SIG = [
    'id',
    'id_old',
    'fecha_evento',
    'macrotipo',
    'departamento',
    'macroregion',
    'pueblo',
    'npersonas',
    'nmujeres',
    'nhombres',
    'nmenores',
    'macroactor',
    'contextual_type'
  ].join(',');

  const CAMPOS_VISTA_SIG = [
    'punto_id',
    'caso_id',
    'id_old',
    'fecha_evento',
    'anio',
    'macrotipo',
    'departamento',
    'macroregion',
    'municipio',
    'lat',
    'lng',
    'pueblo',
    'npersonas',
    'nmujeres',
    'nhombres',
    'nmenores',
    'macroactor',
    'contextual_type'
  ].join(',');

  window.SIG_DATOS_VERSION = VERSION;

  function qs(id) {
    return document.getElementById(id);
  }

  function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, caracter => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[caracter]));
  }

  function actualizarEstado(texto) {
    const estado = qs('estadoSIG');
    if (estado) estado.textContent = texto;
  }

  function formatoNumero(valor) {
    const numero = Number(valor || 0);
    return new Intl.NumberFormat('es-CO').format(numero);
  }

  function formatoFecha(fecha) {
    if (!fecha) return 'Sin fecha';
    const partes = String(fecha).split('-');
    if (partes.length === 3) return `${partes[2]}/${partes[1]}/${partes[0]}`;
    return String(fecha);
  }

  function normTxt(valor) {
    return String(valor ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function limpiarValorFiltro(valor) {
    const limpio = String(valor ?? '').trim();
    return limpio ? limpio : null;
  }

  function anioActual() {
    return new Date().getFullYear();
  }

  function normalizarAnio(valor) {
    const anio = Number(valor);
    if (!Number.isInteger(anio)) return null;
    if (anio < ANIO_INICIO || anio > anioActual()) return null;
    return anio;
  }

  function anioDeFecha(fecha) {
    if (!fecha) return null;
    const anio = Number(String(fecha).slice(0, 4));
    return Number.isInteger(anio) ? anio : null;
  }

  function crearOpcionesAnio(anioSeleccionado = null) {
    const actual = anioActual();
    const seleccionado = normalizarAnio(anioSeleccionado);
    const opciones = ['<option value="">Todos los años</option>'];
    for (let anio = actual; anio >= ANIO_INICIO; anio -= 1) {
      opciones.push(`<option value="${anio}" ${anio === seleccionado ? 'selected' : ''}>${anio}</option>`);
    }
    return opciones.join('');
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
      const llavesPreferidas = ['nombre', 'pueblo', 'label', 'name', 'valor', 'value'];
      llavesPreferidas.forEach(llave => {
        if (valor[llave] !== undefined && valor[llave] !== null) extraerTextosDesdeJson(valor[llave], salida);
      });

      if (!llavesPreferidas.some(llave => valor[llave] !== undefined && valor[llave] !== null)) {
        Object.values(valor).forEach(item => {
          if (typeof item === 'string' || typeof item === 'number' || Array.isArray(item)) {
            extraerTextosDesdeJson(item, salida);
          }
        });
      }
    }

    return salida;
  }

  function valoresPueblo(registro) {
    const valores = extraerTextosDesdeJson(registro?.pueblo || []);
    const vistos = new Set();
    return valores
      .map(valor => String(valor).trim())
      .filter(valor => {
        const clave = normTxt(valor);
        if (!clave || vistos.has(clave)) return false;
        vistos.add(clave);
        return true;
      });
  }

  function valorPlano(valor) {
    const textos = extraerTextosDesdeJson(valor);
    if (textos.length) return textos.join(', ');
    if (valor === null || valor === undefined || valor === '') return '';
    return String(valor);
  }

  function textoFiltroPoblacional(valor) {
    const mapa = {
      mujeres: 'con mujeres',
      hombres: 'con hombres',
      menores: 'con menores'
    };
    return mapa[valor] || '';
  }

  function filtrosVacios(filtros = {}) {
    return !normalizarAnio(filtros.anio) &&
      !limpiarValorFiltro(filtros.departamento) &&
      !limpiarValorFiltro(filtros.macrotipo) &&
      !limpiarValorFiltro(filtros.pueblo) &&
      !limpiarValorFiltro(filtros.macroactor) &&
      !limpiarValorFiltro(filtros.poblacional);
  }

  function textoFiltrosActivos(filtros = {}) {
    const partes = [];
    const anio = normalizarAnio(filtros.anio);
    if (anio) partes.push(`Año ${anio}`);
    if (limpiarValorFiltro(filtros.departamento)) partes.push(`Departamento: ${filtros.departamento}`);
    if (limpiarValorFiltro(filtros.macrotipo)) partes.push(`Macrotipo: ${filtros.macrotipo}`);
    if (limpiarValorFiltro(filtros.pueblo)) partes.push(`Pueblo: ${filtros.pueblo}`);
    if (limpiarValorFiltro(filtros.macroactor)) partes.push(`Macroactor: ${filtros.macroactor}`);
    if (limpiarValorFiltro(filtros.poblacional)) partes.push(`Poblacional: ${textoFiltroPoblacional(filtros.poblacional)}`);
    return partes.length ? partes.join(' · ') : 'Sin filtro aplicado.';
  }

  function filtroActivo() {
    const filtros = window.SIG_STATE?.filtrosActivos || {};
    return filtrosVacios(filtros) ? {} : { ...filtros };
  }

  function claveFiltro(filtros = {}) {
    const limpio = {
      anio: normalizarAnio(filtros.anio) || '',
      departamento: normTxt(filtros.departamento || ''),
      macrotipo: normTxt(filtros.macrotipo || ''),
      pueblo: normTxt(filtros.pueblo || ''),
      macroactor: normTxt(filtros.macroactor || ''),
      poblacional: normTxt(filtros.poblacional || '')
    };
    return JSON.stringify(limpio);
  }

  function coincideFiltroPoblacional(registro, filtro) {
    const valor = limpiarValorFiltro(filtro);
    if (!valor) return true;
    if (valor === 'mujeres') return Number(registro?.nmujeres || 0) > 0;
    if (valor === 'hombres') return Number(registro?.nhombres || 0) > 0;
    if (valor === 'menores') return Number(registro?.nmenores || 0) > 0;
    return true;
  }

  function registroCumpleFiltros(registro, filtros = {}) {
    const anio = normalizarAnio(filtros.anio);
    if (anio && anioDeFecha(registro?.fecha_evento) !== anio && Number(registro?.anio) !== anio) return false;

    const departamento = limpiarValorFiltro(filtros.departamento);
    if (departamento && normTxt(registro?.departamento) !== normTxt(departamento)) return false;

    const macrotipo = limpiarValorFiltro(filtros.macrotipo);
    if (macrotipo && normTxt(registro?.macrotipo) !== normTxt(macrotipo)) return false;

    const macroactor = limpiarValorFiltro(filtros.macroactor);
    if (macroactor && normTxt(registro?.macroactor) !== normTxt(macroactor)) return false;

    const pueblo = limpiarValorFiltro(filtros.pueblo);
    if (pueblo) {
      const puebloNorm = normTxt(pueblo);
      const pueblos = valoresPueblo(registro).map(normTxt);
      if (!pueblos.includes(puebloNorm)) return false;
    }

    if (!coincideFiltroPoblacional(registro, filtros.poblacional)) return false;

    return true;
  }

  function filtrarRegistros(registros = [], filtros = {}) {
    if (filtrosVacios(filtros)) return Array.isArray(registros) ? [...registros] : [];
    return (registros || []).filter(registro => registroCumpleFiltros(registro, filtros));
  }

  function calcularResumenDesdeRegistros(registros = []) {
    const lote = Array.isArray(registros) ? registros : [];
    return {
      totalCasos: lote.length,
      totalPersonas: lote.reduce((suma, registro) => suma + Number(registro?.npersonas || 0), 0),
      totalMujeres: lote.reduce((suma, registro) => suma + Number(registro?.nmujeres || 0), 0),
      totalHombres: lote.reduce((suma, registro) => suma + Number(registro?.nhombres || 0), 0),
      totalMenores: lote.reduce((suma, registro) => suma + Number(registro?.nmenores || 0), 0)
    };
  }

  function opcionesUnicas(registros = [], obtenerValores) {
    const mapa = new Map();
    (registros || []).forEach(registro => {
      const valores = obtenerValores(registro);
      (Array.isArray(valores) ? valores : [valores]).forEach(valor => {
        const texto = String(valor ?? '').trim();
        const clave = normTxt(texto);
        if (!clave || mapa.has(clave)) return;
        mapa.set(clave, texto);
      });
    });
    return Array.from(mapa.values()).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  }

  function crearOpcionesSelect(lista = [], seleccionado = null, etiquetaTodos = 'Todos') {
    const seleccionadoNorm = normTxt(seleccionado || '');
    const opciones = [`<option value="">${escapeHtml(etiquetaTodos)}</option>`];
    lista.forEach(valor => {
      const texto = String(valor ?? '').trim();
      if (!texto) return;
      opciones.push(`<option value="${escapeHtml(texto)}" ${normTxt(texto) === seleccionadoNorm ? 'selected' : ''}>${escapeHtml(texto)}</option>`);
    });
    return opciones.join('');
  }

  function leerFiltrosDesdePanel() {
    return {
      anio: normalizarAnio(qs('selectAnioFiltroSIG')?.value),
      departamento: limpiarValorFiltro(qs('selectDepartamentoFiltroSIG')?.value),
      macrotipo: limpiarValorFiltro(qs('selectMacrotipoFiltroSIG')?.value),
      pueblo: limpiarValorFiltro(qs('selectPuebloFiltroSIG')?.value),
      macroactor: limpiarValorFiltro(qs('selectMacroactorFiltroSIG')?.value),
      poblacional: limpiarValorFiltro(qs('selectPoblacionalFiltroSIG')?.value)
    };
  }

  function pintarPanelCarga(tipo, titulo, mensaje) {
    const panel = qs('panelFiltrosContenido');
    if (!panel) return;

    const iconos = {
      cargando: 'bi-arrow-repeat',
      exito: 'bi-check-circle-fill',
      error: 'bi-exclamation-triangle-fill'
    };

    const clases = {
      cargando: 'alert-primary',
      exito: 'alert-success',
      error: 'alert-danger'
    };

    panel.dataset.estado = tipo === 'exito' ? 'datos-core-cargados' : 'datos-core-pendientes';
    panel.innerHTML = `
      <div class="filter-block">
        <div class="alert ${clases[tipo] || clases.cargando} mb-0" role="status">
          <div class="d-flex align-items-start gap-2">
            <i class="bi ${iconos[tipo] || iconos.cargando} mt-1"></i>
            <div>
              <div class="fw-bold">${escapeHtml(titulo)}</div>
              <div>${escapeHtml(mensaje)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function crearClienteSupabaseSIG() {
    const cfg = window.SIG_CONFIG?.supabase;
    const clavePublica = cfg?.clavePublica || cfg?.publishableKey || cfg?.anonKey;

    if (!window.supabase?.createClient) {
      return { cliente: null, error: 'No cargó la librería de Supabase en sigindex.html.' };
    }

    if (!cfg?.url || !clavePublica) {
      return { cliente: null, error: 'Falta configurar url o clave pública de Supabase en configlayers.js.' };
    }

    return {
      cliente: window.supabase.createClient(cfg.url, clavePublica),
      error: null
    };
  }

  function conTimeout(promesa, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`La consulta superó ${ms / 1000} segundos.`)), ms);
    });

    return Promise.race([promesa, timeout]).finally(() => window.clearTimeout(timer));
  }

  async function cargarCasosCoreRegistros(cliente, tabla) {
    const state = window.SIG_STATE || {};
    if (Array.isArray(state.casosCoreRegistros)) return state.casosCoreRegistros;

    const cfg = window.SIG_CONFIG?.supabase || {};
    const timeoutMs = Number(cfg.timeoutConsultaMs || 15000);
    const batchSize = Number(cfg.batchCasosCore || 1000);
    const registros = [];
    let desde = 0;

    while (true) {
      const hasta = desde + batchSize - 1;
      const consulta = cliente
        .from(tabla)
        .select(CAMPOS_CORE_SIG)
        .order('fecha_evento', { ascending: false, nullsFirst: false })
        .range(desde, hasta);

      const { data, error } = await conTimeout(consulta, timeoutMs);
      if (error) throw error;

      const lote = Array.isArray(data) ? data : [];
      registros.push(...lote);
      if (lote.length < batchSize) break;
      desde += batchSize;
    }

    state.casosCoreRegistros = registros;
    return registros;
  }

  async function cargarResumenCasosCore(cliente, tabla, filtros = {}) {
    const registros = await cargarCasosCoreRegistros(cliente, tabla);
    const filtrados = filtrarRegistros(registros, filtros);
    return calcularResumenDesdeRegistros(filtrados);
  }

  function obtenerCfgCasos() {
    const cfg = window.SIG_CONFIG || {};
    cfg.casos = cfg.casos || {};
    cfg.casos.estiloPunto = cfg.casos.estiloPunto || {};
    const estilo = cfg.casos.estiloPunto;

    return {
      pane: cfg.casos.pane || 'paneCasosTop',
      zoomMaximoAjuste: Number(cfg.casos.zoomMaximoAjuste || 9),
      radio: Number(estilo.radio ?? 5),
      colorRelleno: estilo.colorRelleno || '#0d6efd',
      colorLinea: estilo.colorLinea || '#052c65',
      grosorLinea: Number(estilo.grosorLinea ?? 1),
      opacidadRelleno: Number(estilo.opacidadRelleno ?? 0.65),
      opacidadLinea: Number(estilo.opacidadLinea ?? 0.9)
    };
  }

  function asegurarPaneCasosSuperior() {
    const state = window.SIG_STATE;
    const mapa = state?.mapa;
    const paneId = obtenerCfgCasos().pane;
    const pane = mapa?.getPane(paneId);
    if (pane) {
      pane.style.zIndex = '1000';
      pane.style.pointerEvents = 'auto';
    }

    const panePopup = mapa?.getPane('panePopupsTop') || mapa?.createPane?.('panePopupsTop');
    if (panePopup) {
      panePopup.style.zIndex = '1300';
      panePopup.style.pointerEvents = 'auto';
    }
  }

  function guardarCfgCasos(nuevosValores) {
    const cfg = window.SIG_CONFIG;
    if (!cfg?.casos?.estiloPunto) return;
    Object.assign(cfg.casos.estiloPunto, nuevosValores);
  }

  function obtenerEstiloCircleMarker() {
    const cfg = obtenerCfgCasos();
    return {
      pane: cfg.pane,
      radius: cfg.radio,
      color: cfg.colorLinea,
      weight: cfg.grosorLinea,
      opacity: cfg.opacidadLinea,
      fillColor: cfg.colorRelleno,
      fillOpacity: cfg.opacidadRelleno,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: true
    };
  }

  function copiarEstiloCircleMarker(estilo = obtenerEstiloCircleMarker()) {
    return { ...estilo };
  }

  function modoAcumulativoActivo() {
    const check = qs('checkAcumularFiltrosSIG');
    if (check) return !!check.checked;
    return !!window.SIG_STATE?.modoAcumularFiltrosMapa;
  }

  function crearIdCapaAcumulada() {
    const state = window.SIG_STATE || {};
    state.contadorCapasAcumuladas = Number(state.contadorCapasAcumuladas || 0) + 1;
    window.SIG_STATE.contadorCapasAcumuladas = state.contadorCapasAcumuladas;
    return `filtro-acumulado-${Date.now()}-${state.contadorCapasAcumuladas}`;
  }

  function asegurarControlLeyendaFiltros() {
    const state = window.SIG_STATE;
    if (!state?.mapa || !window.L) return null;

    if (!state.controlLeyendaFiltros) {
      state.controlLeyendaFiltros = L.control({ position: 'bottomright' });
      state.controlLeyendaFiltros.onAdd = function () {
        const div = L.DomUtil.create('div', 'sig-legend-filtros leaflet-control');
        div.id = 'leyendaFiltrosSIG';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
      };
      state.controlLeyendaFiltros.addTo(state.mapa);
    }

    return qs('leyendaFiltrosSIG');
  }

  function actualizarLeyendaFiltrosAcumulados() {
    const state = window.SIG_STATE;
    const entradas = Array.isArray(state?.leyendasFiltrosAcumulados) ? state.leyendasFiltrosAcumulados : [];

    if (!entradas.length) {
      if (state?.controlLeyendaFiltros && state?.mapa) {
        state.mapa.removeControl(state.controlLeyendaFiltros);
        state.controlLeyendaFiltros = null;
      }
      return;
    }

    const contenedor = asegurarControlLeyendaFiltros();
    if (!contenedor) return;

    const items = entradas.map((entrada, indice) => {
      const estilo = entrada.estilo || {};
      const color = estilo.fillColor || estilo.color || '#0d6efd';
      const borde = estilo.color || '#052c65';
      return `
        <div class="sig-legend-filtros-item">
          <span class="sig-legend-color-dot" style="background:${escapeHtml(color)}; border-color:${escapeHtml(borde)}"></span>
          <div>
            <div class="sig-legend-filtro-texto">${escapeHtml(entrada.texto || `Filtro ${indice + 1}`)}</div>
            <div class="sig-legend-filtro-meta">
              ${formatoNumero(entrada.casos || 0)} casos · ${formatoNumero(entrada.personas || 0)} personas · ${formatoNumero(entrada.puntos || 0)} puntos
            </div>
          </div>
        </div>
      `;
    }).join('');

    contenedor.innerHTML = `
      <div class="sig-legend-filtros-title"><i class="bi bi-map"></i>Leyenda de filtros</div>
      <div class="sig-legend-filtros-list">${items}</div>
    `;
  }

  function limpiarLeyendaFiltrosAcumulados() {
    const state = window.SIG_STATE;
    if (!state) return;
    state.leyendasFiltrosAcumulados = [];
    actualizarLeyendaFiltrosAcumulados();
  }

  function registrarLeyendaFiltroAcumulado(entrada) {
    const state = window.SIG_STATE;
    if (!state) return;
    state.leyendasFiltrosAcumulados = Array.isArray(state.leyendasFiltrosAcumulados) ? state.leyendasFiltrosAcumulados : [];
    state.leyendasFiltrosAcumulados.push(entrada);
    actualizarLeyendaFiltrosAcumulados();
  }

  function actualizarVistaPreviaMarcador() {
    const preview = qs('previewMarcadorCasos');
    if (!preview) return;
    const cfg = obtenerCfgCasos();
    const diametro = Math.max(8, cfg.radio * 2);
    preview.style.width = `${diametro}px`;
    preview.style.height = `${diametro}px`;
    preview.style.background = cfg.colorRelleno;
    preview.style.borderColor = cfg.colorLinea;
    preview.style.borderWidth = `${Math.max(1, cfg.grosorLinea)}px`;
    preview.style.opacity = String(Math.max(cfg.opacidadRelleno, 0.15));
  }

  function refrescarEstiloMarcadores() {
    const state = window.SIG_STATE;
    const estilo = obtenerEstiloCircleMarker();
    if (modoAcumulativoActivo()) {
      actualizarVistaPreviaMarcador();
      return;
    }
    if (!state?.capaCasos) return;

    state.capaCasos.eachLayer(layer => {
      if (layer?.setStyle) layer.setStyle(estilo);
      if (layer?.setRadius) layer.setRadius(estilo.radius);
      if (layer?.bringToFront) layer.bringToFront();
    });
    asegurarPaneCasosSuperior();
    actualizarVistaPreviaMarcador();
  }

  function resumenPanelActual() {
    const state = window.SIG_STATE || {};
    const filtros = state.filtrosActivos || {};
    return {
      casos: Number(state.totalCasosPanel ?? state.totalCasosCore ?? 0),
      personas: Number(state.totalPersonasPanel ?? state.totalPersonasCore ?? 0),
      mujeres: Number(state.totalMujeresPanel ?? state.totalMujeresCore ?? 0),
      hombres: Number(state.totalHombresPanel ?? state.totalHombresCore ?? 0),
      menores: Number(state.totalMenoresPanel ?? state.totalMenoresCore ?? 0),
      filtros
    };
  }

  function construirOpcionesFiltros() {
    const state = window.SIG_STATE || {};
    const registros = state.casosCoreRegistros || [];
    return {
      departamentos: opcionesUnicas(registros, registro => registro.departamento),
      macrotipos: opcionesUnicas(registros, registro => registro.macrotipo),
      pueblos: opcionesUnicas(registros, registro => valoresPueblo(registro)),
      macroactores: opcionesUnicas(registros, registro => registro.macroactor)
    };
  }

  function pintarPanelPrincipal() {
    const panel = qs('panelFiltrosContenido');
    const state = window.SIG_STATE || {};
    if (!panel) return;

    const resumen = resumenPanelActual();
    const filtros = resumen.filtros || {};
    const hayFiltros = !filtrosVacios(filtros);
    const textoFiltros = textoFiltrosActivos(filtros);
    const opciones = construirOpcionesFiltros();
    const cfg = obtenerCfgCasos();

    panel.dataset.estado = 'datos-core-cargados';
    panel.innerHTML = `
      <div class="filter-block">
        <div class="alert alert-success mb-0" role="status">
          <div class="d-flex align-items-start gap-2">
            <i class="bi bi-check-circle-fill mt-1"></i>
            <div>
              <div class="fw-bold">Datos cargados correctamente</div>
              <div>La información base de casos_2026 está disponible.</div>
            </div>
          </div>
        </div>
      </div>

      <div class="filter-block">
        <div class="filter-block-title" id="tituloResumenSIG"><i class="bi bi-bar-chart-line"></i>${hayFiltros ? 'Resumen filtrado' : 'Resumen general'}</div>
        <div class="small text-muted mb-2" id="estadoResumenSIG">${escapeHtml(textoFiltros)}</div>
        <div class="row g-2">
          <div class="col-6">
            <div class="filter-stat stat-compact stat-focus">
              <div class="number" id="statCasosCore">${formatoNumero(resumen.casos)}</div>
              <div class="label">Casos</div>
            </div>
          </div>
          <div class="col-6">
            <div class="filter-stat stat-compact">
              <div class="number" id="statPersonasCore">${formatoNumero(resumen.personas)}</div>
              <div class="label">Personas</div>
            </div>
          </div>
          <div class="col-4">
            <div class="filter-stat stat-compact">
              <div class="number" id="statMujeresCore">${formatoNumero(resumen.mujeres)}</div>
              <div class="label">Mujeres</div>
            </div>
          </div>
          <div class="col-4">
            <div class="filter-stat stat-compact">
              <div class="number" id="statHombresCore">${formatoNumero(resumen.hombres)}</div>
              <div class="label">Hombres</div>
            </div>
          </div>
          <div class="col-4">
            <div class="filter-stat stat-compact">
              <div class="number" id="statMenoresCore">${formatoNumero(resumen.menores)}</div>
              <div class="label">Menores</div>
            </div>
          </div>
        </div>
      </div>

      <div class="filter-block">
        <div class="filter-block-title"><i class="bi bi-funnel"></i>Filtros combinados</div>

        <div class="row g-2">
          <div class="col-6">
            <label class="form-label fw-semibold small" for="selectAnioFiltroSIG">Año</label>
            <select class="form-select form-select-sm" id="selectAnioFiltroSIG">
              ${crearOpcionesAnio(filtros.anio)}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label fw-semibold small" for="selectDepartamentoFiltroSIG">Departamento</label>
            <select class="form-select form-select-sm" id="selectDepartamentoFiltroSIG">
              ${crearOpcionesSelect(opciones.departamentos, filtros.departamento, 'Todos')}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label fw-semibold small" for="selectMacrotipoFiltroSIG">Macrotipo</label>
            <select class="form-select form-select-sm" id="selectMacrotipoFiltroSIG">
              ${crearOpcionesSelect(opciones.macrotipos, filtros.macrotipo, 'Todos')}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label fw-semibold small" for="selectPuebloFiltroSIG">Pueblo</label>
            <select class="form-select form-select-sm" id="selectPuebloFiltroSIG">
              ${crearOpcionesSelect(opciones.pueblos, filtros.pueblo, 'Todos')}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label fw-semibold small" for="selectMacroactorFiltroSIG">Macroactor</label>
            <select class="form-select form-select-sm" id="selectMacroactorFiltroSIG">
              ${crearOpcionesSelect(opciones.macroactores, filtros.macroactor, 'Todos')}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label fw-semibold small" for="selectPoblacionalFiltroSIG">Poblacional</label>
            <select class="form-select form-select-sm" id="selectPoblacionalFiltroSIG">
              <option value="" ${!filtros.poblacional ? 'selected' : ''}>Todos</option>
              <option value="mujeres" ${filtros.poblacional === 'mujeres' ? 'selected' : ''}>Con mujeres</option>
              <option value="hombres" ${filtros.poblacional === 'hombres' ? 'selected' : ''}>Con hombres</option>
              <option value="menores" ${filtros.poblacional === 'menores' ? 'selected' : ''}>Con menores</option>
            </select>
          </div>
        </div>

        <div class="d-grid gap-2 mt-3">
          <button class="btn btn-primary filter-action-btn" id="btnAplicarFiltrosSIG" type="button">
            <i class="bi bi-funnel me-1"></i>Aplicar filtro
          </button>
          <button class="btn btn-outline-secondary filter-action-btn" id="btnLimpiarFiltrosSIG" type="button">
            <i class="bi bi-arrow-counterclockwise me-1"></i>Limpiar filtro
          </button>
        </div>

        <div class="form-check form-switch mt-3">
          <input class="form-check-input" id="checkAcumularFiltrosSIG" type="checkbox">
          <label class="form-check-label small fw-semibold" for="checkAcumularFiltrosSIG">Acumular marcadores filtrados</label>
        </div>
        <div class="small text-muted mt-1">Desactivado por defecto. Actívalo antes de aplicar un filtro para conservar los marcadores anteriores y crear una leyenda con el color actual.</div>
        <div class="small text-muted mt-2" id="estadoFiltrosSIG">${escapeHtml(textoFiltros)}</div>
      </div>

      <div class="filter-block">
        <div class="filter-block-title"><i class="bi bi-geo-alt"></i>Mapa</div>
        <div class="small text-muted mb-2">Los puntos se dibujan encima de todas las capas. El mapa usa los filtros aplicados.</div>
        <div class="d-grid gap-2">
          <button class="btn btn-primary filter-action-btn" id="btnMostrarTodosCasos" type="button">
            <i class="bi bi-eye me-1"></i>Mostrar casos en mapa
          </button>
          <button class="btn btn-outline-secondary filter-action-btn" id="btnLimpiarCasosMapa" type="button">
            <i class="bi bi-eraser me-1"></i>Limpiar casos del mapa
          </button>
        </div>
      </div>

      <div class="filter-block">
        <button class="btn btn-light border w-100 d-flex justify-content-between align-items-center" type="button" data-bs-toggle="collapse" data-bs-target="#configMarcadoresCasos" aria-expanded="false" aria-controls="configMarcadoresCasos">
          <span class="fw-semibold"><i class="bi bi-sliders me-1"></i>Configurar marcador circular</span>
          <i class="bi bi-chevron-down"></i>
        </button>
        <div class="collapse mt-3" id="configMarcadoresCasos">
          <div class="marker-preview-wrap mb-3">
            <span class="marker-preview" id="previewMarcadorCasos"></span>
          </div>

          <div class="row g-3">
            <div class="col-6">
              <label class="form-label fw-semibold small" for="colorRellenoCasos">Color</label>
              <input class="form-control form-control-color w-100" id="colorRellenoCasos" type="color" value="${escapeHtml(cfg.colorRelleno)}" title="Color del punto">
            </div>
            <div class="col-6">
              <label class="form-label fw-semibold small" for="colorLineaCasos">Línea</label>
              <input class="form-control form-control-color w-100" id="colorLineaCasos" type="color" value="${escapeHtml(cfg.colorLinea)}" title="Color de línea">
            </div>
            <div class="col-12">
              <label class="form-label fw-semibold small" for="radioCasos">Tamaño del punto: <span id="valorRadioCasos">${cfg.radio}</span></label>
              <input class="form-range" id="radioCasos" type="range" min="2" max="18" step="1" value="${cfg.radio}">
            </div>
            <div class="col-12">
              <label class="form-label fw-semibold small" for="grosorLineaCasos">Grosor de línea: <span id="valorGrosorCasos">${cfg.grosorLinea}</span></label>
              <input class="form-range" id="grosorLineaCasos" type="range" min="0" max="8" step="1" value="${cfg.grosorLinea}">
            </div>
            <div class="col-12">
              <label class="form-label fw-semibold small" for="opacidadRellenoCasos">Opacidad del color: <span id="valorOpacidadRellenoCasos">${Math.round(cfg.opacidadRelleno * 100)}%</span></label>
              <input class="form-range" id="opacidadRellenoCasos" type="range" min="0" max="100" step="5" value="${Math.round(cfg.opacidadRelleno * 100)}">
            </div>
            <div class="col-12">
              <label class="form-label fw-semibold small" for="opacidadLineaCasos">Opacidad de línea: <span id="valorOpacidadLineaCasos">${Math.round(cfg.opacidadLinea * 100)}%</span></label>
              <input class="form-range" id="opacidadLineaCasos" type="range" min="0" max="100" step="5" value="${Math.round(cfg.opacidadLinea * 100)}">
            </div>
          </div>
        </div>
      </div>
    `;

    enlazarControlesPanel();
    actualizarVistaPreviaMarcador();
  }

  function actualizarStatsPanel() {
    const resumen = resumenPanelActual();
    const filtros = resumen.filtros || {};
    const hayFiltros = !filtrosVacios(filtros);
    const textoFiltros = textoFiltrosActivos(filtros);

    const statCasosCore = qs('statCasosCore');
    const statPersonasCore = qs('statPersonasCore');
    const statMujeresCore = qs('statMujeresCore');
    const statHombresCore = qs('statHombresCore');
    const statMenoresCore = qs('statMenoresCore');
    const tituloResumen = qs('tituloResumenSIG');
    const estadoResumen = qs('estadoResumenSIG');
    const estadoFiltros = qs('estadoFiltrosSIG');

    if (statCasosCore) statCasosCore.textContent = formatoNumero(resumen.casos);
    if (statPersonasCore) statPersonasCore.textContent = formatoNumero(resumen.personas);
    if (statMujeresCore) statMujeresCore.textContent = formatoNumero(resumen.mujeres);
    if (statHombresCore) statHombresCore.textContent = formatoNumero(resumen.hombres);
    if (statMenoresCore) statMenoresCore.textContent = formatoNumero(resumen.menores);
    if (tituloResumen) tituloResumen.innerHTML = `<i class="bi bi-bar-chart-line"></i>${hayFiltros ? 'Resumen filtrado' : 'Resumen general'}`;
    if (estadoResumen) estadoResumen.textContent = textoFiltros;
    if (estadoFiltros) estadoFiltros.textContent = textoFiltros;
  }

  function enlazarControlesPanel() {
    qs('btnMostrarTodosCasos')?.addEventListener('click', () => mostrarTodosLosRegistros());
    qs('btnLimpiarCasosMapa')?.addEventListener('click', () => limpiarRegistrosMapa());
    qs('btnAplicarFiltrosSIG')?.addEventListener('click', () => aplicarFiltrosCombinadosSIG());
    qs('btnLimpiarFiltrosSIG')?.addEventListener('click', () => limpiarFiltrosCombinadosSIG());

    const checkAcumular = qs('checkAcumularFiltrosSIG');
    if (checkAcumular) {
      checkAcumular.checked = false;
      checkAcumular.addEventListener('change', () => {
        const state = window.SIG_STATE;
        if (state) state.modoAcumularFiltrosMapa = !!checkAcumular.checked;
        actualizarEstado(checkAcumular.checked ? 'Modo acumulativo activo · los próximos filtros se sumarán al mapa' : 'Modo acumulativo desactivado · el próximo filtro reemplazará los marcadores');
      });
    }

    const colorRelleno = qs('colorRellenoCasos');
    const colorLinea = qs('colorLineaCasos');
    const radio = qs('radioCasos');
    const grosor = qs('grosorLineaCasos');
    const opacidadRelleno = qs('opacidadRellenoCasos');
    const opacidadLinea = qs('opacidadLineaCasos');

    colorRelleno?.addEventListener('input', () => {
      guardarCfgCasos({ colorRelleno: colorRelleno.value });
      refrescarEstiloMarcadores();
    });

    colorLinea?.addEventListener('input', () => {
      guardarCfgCasos({ colorLinea: colorLinea.value });
      refrescarEstiloMarcadores();
    });

    radio?.addEventListener('input', () => {
      guardarCfgCasos({ radio: Number(radio.value) });
      const label = qs('valorRadioCasos');
      if (label) label.textContent = radio.value;
      refrescarEstiloMarcadores();
    });

    grosor?.addEventListener('input', () => {
      guardarCfgCasos({ grosorLinea: Number(grosor.value) });
      const label = qs('valorGrosorCasos');
      if (label) label.textContent = grosor.value;
      refrescarEstiloMarcadores();
    });

    opacidadRelleno?.addEventListener('input', () => {
      const valor = Number(opacidadRelleno.value) / 100;
      guardarCfgCasos({ opacidadRelleno: valor });
      const label = qs('valorOpacidadRellenoCasos');
      if (label) label.textContent = `${opacidadRelleno.value}%`;
      refrescarEstiloMarcadores();
    });

    opacidadLinea?.addEventListener('input', () => {
      const valor = Number(opacidadLinea.value) / 100;
      guardarCfgCasos({ opacidadLinea: valor });
      const label = qs('valorOpacidadLineaCasos');
      if (label) label.textContent = `${opacidadLinea.value}%`;
      refrescarEstiloMarcadores();
    });
  }

  function coordenadaValida(registro) {
    const lat = Number(registro?.lat);
    const lng = Number(registro?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function crearPopupCaso(registro) {
    const pueblo = valorPlano(registro.pueblo);
    const filas = [
      ['Fecha', formatoFecha(registro.fecha_evento)],
      ['Macrotipo', registro.macrotipo],
      ['Departamento', registro.departamento],
      ['Municipio', registro.municipio],
      ['Pueblo', pueblo],
      ['Macroactor', registro.macroactor],
      ['Personas', formatoNumero(registro.npersonas)],
      ['Mujeres', formatoNumero(registro.nmujeres)],
      ['Hombres', formatoNumero(registro.nhombres)],
      ['Menores', formatoNumero(registro.nmenores)]
    ]
      .filter(([, valor]) => valor !== null && valor !== undefined && String(valor).trim() !== '')
      .map(([clave, valor]) => `<tr><th class="text-muted pe-2">${escapeHtml(clave)}</th><td>${escapeHtml(valor)}</td></tr>`)
      .join('');

    return `
      <div style="min-width:240px; max-width:360px">
        <div class="fw-bold mb-1">Caso ${escapeHtml(registro.id_old || registro.caso_id || '')}</div>
        <div class="small text-muted mb-2">Fuente municipal: caso_municipio_2026</div>
        <table class="table table-sm mb-0"><tbody>${filas}</tbody></table>
      </div>
    `;
  }

  async function cargarTodosLosPuntosCasos(cliente) {
    const state = window.SIG_STATE;
    if (Array.isArray(state.todosPuntosCasosSIG)) return state.todosPuntosCasosSIG;

    const cfg = window.SIG_CONFIG?.supabase || {};
    const vista = cfg.vistaCasos || 'sig_casos_public_2026';
    const timeoutMs = Number(cfg.timeoutConsultaMs || 15000);
    const batchSize = Number(cfg.batchPuntosMapa || 1000);
    const registros = [];
    let desde = 0;

    actualizarEstado('Cargando puntos de casos...');

    while (true) {
      const hasta = desde + batchSize - 1;
      const consulta = cliente
        .from(vista)
        .select(CAMPOS_VISTA_SIG)
        .not('lat', 'is', null)
        .not('lng', 'is', null)
        .order('fecha_evento', { ascending: false, nullsFirst: false })
        .range(desde, hasta);

      const { data, error } = await conTimeout(consulta, timeoutMs);
      if (error) throw error;

      const lote = Array.isArray(data) ? data : [];
      registros.push(...lote);
      if (lote.length < batchSize) break;
      desde += batchSize;
    }

    state.todosPuntosCasosSIG = registros;
    return registros;
  }

  async function cargarPuntosCasos(cliente, filtros = {}) {
    const state = window.SIG_STATE;
    const cacheKey = claveFiltro(filtros);
    state.casosPuntosCachePorFiltro = state.casosPuntosCachePorFiltro || {};

    if (Array.isArray(state.casosPuntosCachePorFiltro[cacheKey])) {
      return state.casosPuntosCachePorFiltro[cacheKey];
    }

    const todos = await cargarTodosLosPuntosCasos(cliente);
    const filtrados = filtrarRegistros(todos, filtros);
    state.casosPuntosCachePorFiltro[cacheKey] = filtrados;
    return filtrados;
  }

  function pintarRegistrosEnMapa(registros, opciones = {}) {
    const state = window.SIG_STATE;
    if (!state?.mapa || !window.L) return;

    asegurarPaneCasosSuperior();

    if (!state.capaCasos) {
      state.capaCasos = L.layerGroup().addTo(state.mapa);
    }

    const acumular = opciones.acumular === true;
    if (!acumular) {
      state.capaCasos.clearLayers();
      state.capasFiltrosAcumulados = [];
      limpiarLeyendaFiltrosAcumulados();
    }

    const estilo = copiarEstiloCircleMarker(opciones.estilo || obtenerEstiloCircleMarker());
    const rendererPane = estilo.pane;
    if (!state.rendererCasos || state.rendererCasos?.options?.pane !== rendererPane) {
      state.rendererCasos = L.canvas({ padding: 0.5, pane: rendererPane });
    }
    const renderer = state.rendererCasos;
    const bounds = L.latLngBounds([]);
    const registrosValidos = [];
    const grupoDestino = acumular ? L.layerGroup() : state.capaCasos;

    (registros || []).forEach(registro => {
      if (!coordenadaValida(registro)) return;
      const lat = Number(registro.lat);
      const lng = Number(registro.lng);
      const marker = L.circleMarker([lat, lng], {
        ...estilo,
        renderer,
        bubblingMouseEvents: false
      });
      marker._sigRegistro = registro;
      marker.bindPopup(() => crearPopupCaso(registro), {
        pane: 'panePopupsTop',
        maxWidth: 420,
        autoPan: true
      });
      marker.addTo(grupoDestino);
      if (marker.bringToFront) marker.bringToFront();
      bounds.extend([lat, lng]);
      registrosValidos.push(registro);
    });

    if (acumular) {
      const idCapa = crearIdCapaAcumulada();
      grupoDestino._sigFiltroAcumulado = idCapa;
      grupoDestino.addTo(state.capaCasos);
      state.capasFiltrosAcumulados = Array.isArray(state.capasFiltrosAcumulados) ? state.capasFiltrosAcumulados : [];
      state.capasFiltrosAcumulados.push(grupoDestino);

      const resumen = opciones.resumen || calcularResumenDesdeRegistros(registrosValidos);
      registrarLeyendaFiltroAcumulado({
        id: idCapa,
        texto: textoFiltrosActivos(opciones.filtros || state.filtrosActivos || {}),
        estilo,
        casos: resumen.totalCasos ?? registrosValidos.length,
        personas: resumen.totalPersonas ?? 0,
        puntos: registrosValidos.length
      });
    }

    state.casosConsultados = registrosValidos;
    state.puntosVisibles = registrosValidos.length;
    actualizarStatsPanel();
    asegurarPaneCasosSuperior();

    if (bounds.isValid() && opciones.ajustarVista !== false) {
      const zoomMaximo = obtenerCfgCasos().zoomMaximoAjuste;
      state.mapa.fitBounds(bounds.pad(0.15), { maxZoom: zoomMaximo });
    }

    const texto = textoFiltrosActivos(opciones.filtros || state.filtrosActivos || {});
    if (acumular) {
      actualizarEstado(`Filtro acumulado en mapa · ${texto}`);
    } else {
      actualizarEstado(filtrosVacios(opciones.filtros || state.filtrosActivos || {}) ? 'SIG listo · casos dibujados en el mapa' : `SIG listo · mapa filtrado · ${texto}`);
    }
  }

  async function mostrarTodosLosRegistros() {
    const state = window.SIG_STATE;
    if (!state?.supabaseClient) {
      pintarPanelCarga('error', 'No se pudo mostrar el mapa', 'Supabase no está iniciado.');
      return;
    }

    const filtros = filtroActivo();
    const acumular = modoAcumulativoActivo();
    const estiloFiltro = copiarEstiloCircleMarker();
    const resumenActual = resumenPanelActual();
    const resumenLeyenda = {
      totalCasos: resumenActual.casos,
      totalPersonas: resumenActual.personas
    };
    const boton = qs('btnMostrarTodosCasos');
    const textoOriginal = boton?.innerHTML;
    if (boton) {
      boton.disabled = true;
      boton.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Cargando puntos...';
    }

    try {
      const registros = await cargarPuntosCasos(state.supabaseClient, filtros);
      pintarRegistrosEnMapa(registros, { ajustarVista: true, filtros, acumular, estilo: estiloFiltro, resumen: resumenLeyenda });
    } catch (err) {
      const mensaje = err?.message || 'Error desconocido al cargar puntos desde sig_casos_public_2026.';
      pintarPanelCarga('error', 'No se pudieron mostrar los casos', mensaje);
      actualizarEstado('SIG listo · puntos pendientes');
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.innerHTML = textoOriginal || '<i class="bi bi-eye me-1"></i>Mostrar casos en mapa';
      }
    }
  }

  function limpiarRegistrosMapa() {
    const state = window.SIG_STATE;
    if (state?.capaCasos) state.capaCasos.clearLayers();
    if (state) {
      state.casosConsultados = [];
      state.puntosVisibles = 0;
      state.capasFiltrosAcumulados = [];
    }
    limpiarLeyendaFiltrosAcumulados();
    actualizarStatsPanel();
    actualizarEstado(`SIG listo · ${formatoNumero(resumenPanelActual().casos)} casos · ${formatoNumero(resumenPanelActual().personas)} personas`);
  }

  async function aplicarFiltrosCombinadosSIG() {
    const state = window.SIG_STATE;
    if (!state?.supabaseClient) return;

    const filtros = leerFiltrosDesdePanel();
    const acumular = modoAcumulativoActivo();
    const estiloFiltro = copiarEstiloCircleMarker();
    const boton = qs('btnAplicarFiltrosSIG');
    const textoOriginal = boton?.innerHTML;

    if (boton) {
      boton.disabled = true;
      boton.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Aplicando...';
    }

    try {
      const tabla = window.SIG_CONFIG?.supabase?.tablaCasos || 'casos_2026';
      const resumen = await cargarResumenCasosCore(state.supabaseClient, tabla, filtros);

      state.filtrosActivos = filtrosVacios(filtros) ? {} : filtros;
      state.filtroAnioActivo = normalizarAnio(filtros.anio);
      state.totalCasosPanel = resumen.totalCasos;
      state.totalPersonasPanel = resumen.totalPersonas;
      state.totalMujeresPanel = resumen.totalMujeres;
      state.totalHombresPanel = resumen.totalHombres;
      state.totalMenoresPanel = resumen.totalMenores;
      actualizarStatsPanel();

      const registros = await cargarPuntosCasos(state.supabaseClient, state.filtrosActivos);
      pintarRegistrosEnMapa(registros, { ajustarVista: true, filtros: state.filtrosActivos, acumular, estilo: estiloFiltro, resumen });

      const texto = textoFiltrosActivos(state.filtrosActivos);
      actualizarEstado(`${acumular ? 'Filtro acumulado' : 'Filtro aplicado'} · ${texto} · ${formatoNumero(resumen.totalCasos)} casos · ${formatoNumero(resumen.totalPersonas)} personas`);
    } catch (err) {
      const mensaje = err?.message || 'Error desconocido al aplicar filtros.';
      pintarPanelCarga('error', 'No se pudieron aplicar los filtros', mensaje);
      actualizarEstado('SIG listo · filtros pendientes');
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.innerHTML = textoOriginal || '<i class="bi bi-funnel me-1"></i>Aplicar filtro';
      }
    }
  }

  function limpiarFiltrosCombinadosSIG() {
    const state = window.SIG_STATE;
    if (!state) return false;

    state.filtrosActivos = {};
    state.filtroAnioActivo = null;
    state.totalCasosPanel = state.totalCasosCore || 0;
    state.totalPersonasPanel = state.totalPersonasCore || 0;
    state.totalMujeresPanel = state.totalMujeresCore || 0;
    state.totalHombresPanel = state.totalHombresCore || 0;
    state.totalMenoresPanel = state.totalMenoresCore || 0;

    ['selectAnioFiltroSIG', 'selectDepartamentoFiltroSIG', 'selectMacrotipoFiltroSIG', 'selectPuebloFiltroSIG', 'selectMacroactorFiltroSIG', 'selectPoblacionalFiltroSIG']
      .forEach(id => {
        const control = qs(id);
        if (control) control.value = '';
      });

    const checkAcumular = qs('checkAcumularFiltrosSIG');
    if (checkAcumular) checkAcumular.checked = false;
    state.modoAcumularFiltrosMapa = false;

    limpiarRegistrosMapa();
    actualizarStatsPanel();
    actualizarEstado(`Filtro limpio · ${formatoNumero(state.totalCasosPanel || 0)} casos · ${formatoNumero(state.totalPersonasPanel || 0)} personas`);
    return true;
  }

  async function cargarConteosIniciales(cliente) {
    const cfg = window.SIG_CONFIG?.supabase || {};
    const tabla = cfg.tablaCasos || 'casos_2026';

    pintarPanelCarga('cargando', 'Cargando datos...', 'Consultando casos y variables poblacionales desde casos_2026.');
    actualizarEstado('Cargando datos core del SIG...');

    const registrosCore = await cargarCasosCoreRegistros(cliente, tabla);
    const resumenCore = calcularResumenDesdeRegistros(registrosCore);

    return {
      tabla,
      casosCore: resumenCore.totalCasos,
      personasCore: resumenCore.totalPersonas,
      mujeresCore: resumenCore.totalMujeres,
      hombresCore: resumenCore.totalHombres,
      menoresCore: resumenCore.totalMenores
    };
  }

  async function inicializar() {
    const state = window.SIG_STATE;
    if (!state) return;

    asegurarPaneCasosSuperior();
    if (!state.capaCasos && state.mapa && window.L) {
      state.capaCasos = L.layerGroup().addTo(state.mapa);
    }

    state.casosConsultados = [];
    state.casosPuntosCachePorFiltro = {};
    state.puntosVisibles = 0;
    state.filtrosActivos = {};
    state.filtroAnioActivo = null;
    state.modoAcumularFiltrosMapa = false;
    state.capasFiltrosAcumulados = [];
    state.leyendasFiltrosAcumulados = [];
    state.contadorCapasAcumuladas = 0;

    const { cliente, error } = crearClienteSupabaseSIG();
    if (error) {
      state.supabaseClient = null;
      pintarPanelCarga('error', 'No se pudo iniciar Supabase', error);
      actualizarEstado('SIG listo · Supabase sin iniciar');
      return;
    }

    state.supabaseClient = cliente;

    try {
      const resultado = await cargarConteosIniciales(cliente);

      state.pruebaSupabase = {
        ok: true,
        tabla: resultado.tabla,
        casos: resultado.casosCore,
        personas: resultado.personasCore,
        mujeres: resultado.mujeresCore,
        hombres: resultado.hombresCore,
        menores: resultado.menoresCore,
        fecha: new Date().toISOString()
      };
      state.totalCasosCore = resultado.casosCore;
      state.totalPersonasCore = resultado.personasCore;
      state.totalMujeresCore = resultado.mujeresCore;
      state.totalHombresCore = resultado.hombresCore;
      state.totalMenoresCore = resultado.menoresCore;
      state.totalCasosPanel = resultado.casosCore;
      state.totalPersonasPanel = resultado.personasCore;
      state.totalMujeresPanel = resultado.mujeresCore;
      state.totalHombresPanel = resultado.hombresCore;
      state.totalMenoresPanel = resultado.menoresCore;
      state.totalPuntosDisponibles = 0;

      pintarPanelPrincipal();
      actualizarEstado(`SIG listo · ${formatoNumero(resultado.casosCore)} casos · ${formatoNumero(resultado.personasCore)} personas`);
    } catch (err) {
      const mensaje = err?.message || 'Error desconocido al consultar casos_2026.';
      state.pruebaSupabase = {
        ok: false,
        error: mensaje,
        fecha: new Date().toISOString()
      };

      pintarPanelCarga('error', 'No se pudieron cargar los datos', mensaje);
      actualizarEstado('SIG listo · carga de datos pendiente');
    }
  }

  function aplicarFiltrosSIG() {
    return aplicarFiltrosCombinadosSIG();
  }

  function limpiarFiltrosSIG() {
    return limpiarFiltrosCombinadosSIG();
  }

  function aplicarFiltroAnioSIG() {
    return aplicarFiltrosCombinadosSIG();
  }

  function limpiarFiltroAnioSIG() {
    return limpiarFiltrosCombinadosSIG();
  }

  function noop() {
    return false;
  }

  function obtenerEstiloDepartamentoCalor() {
    return null;
  }

  function crearPopupDepartamentoCalor() {
    return null;
  }

  window.SIG_DATOS = {
    inicializar,
    mostrarTodosLosRegistros,
    aplicarFiltrosSIG,
    limpiarFiltrosSIG,
    limpiarRegistrosMapa,
    aplicarFiltroAnioSIG,
    limpiarFiltroAnioSIG,
    aplicarFiltrosCombinadosSIG,
    limpiarFiltrosCombinadosSIG,
    pintarRegistrosEnMapa,
    aplicarMapaCalorDepartamentos: noop,
    limpiarMapaCalorDepartamentos: noop,
    refrescarMapaCalorDepartamentos: noop,
    obtenerEstiloDepartamentoCalor,
    crearPopupDepartamentoCalor
  };
})();
