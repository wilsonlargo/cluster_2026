/*
  datasig.js
  Administración de datos y filtros del módulo SIG.

  Este archivo concentra la conexión a Supabase, la consulta pública controlada,
  los filtros combinados y la representación de casos en el mapa. sigindex.html
  conserva la estructura visual del mapa y las capas GeoJSON.
*/
(function () {
  'use strict';

  // Estado interno de filtros. Cada valor vacío se envía a Supabase como null.
  const filtrosActivos = {
    anio: null,
    departamento: null,
    pueblo: null,
    macrotipo: null,
    macroregion: null,
    macroactor: null
  };

  // Atajo local para obtener elementos del DOM por id.
  function qs(id) {
    return document.getElementById(id);
  }

  // Escapa texto antes de insertarlo en popups o alertas HTML.
  function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, caracter => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[caracter]));
  }

  // Normaliza texto para comparar valores sin acentos ni diferencias de mayúsculas.
  function normTxt(valor) {
    return String(valor ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  // Convierte una opción vacía en null para que la RPC no aplique ese filtro.
  function limpiarValor(valor) {
    const v = String(valor ?? '').trim();
    return v ? v : null;
  }

  // Actualiza el texto de estado ubicado en la barra superior del SIG.
  function actualizarEstado(texto) {
    const estado = qs('estadoSIG');
    if (estado) estado.textContent = texto;
  }

  // Muestra mensajes cortos dentro del panel lateral de filtros.
  function mostrarAvisoFiltros(tipo, mensaje) {
    const contenedor = qs('alertasFiltros');
    if (!contenedor) return;
    contenedor.innerHTML = `<div class="alert alert-${tipo} py-2 mb-0" role="alert">${escapeHtml(mensaje)}</div>`;
  }

  // Limpia los mensajes del panel de filtros.
  function limpiarAvisoFiltros() {
    const contenedor = qs('alertasFiltros');
    if (contenedor) contenedor.innerHTML = '';
  }

  // Crea el cliente Supabase con la configuración pública declarada en configlayers.js.
  function crearClienteSupabaseSIG() {
    if (!window.supabase?.createClient) {
      mostrarAvisoFiltros('danger', 'No cargó Supabase JS. Revisa el CDN o la conexión.');
      return null;
    }

    const cfg = window.SIG_CONFIG?.supabase;
    if (!cfg?.url || !cfg?.anonKey) {
      mostrarAvisoFiltros('danger', 'Falta configurar Supabase en configlayers.js.');
      return null;
    }

    return window.supabase.createClient(cfg.url, cfg.anonKey);
  }

  // Convierte un campo JSONB que puede llegar como arreglo, objeto o texto en un arreglo seguro.
  function normalizarArregloJsonb(valor) {
    if (Array.isArray(valor)) return valor;
    if (!valor) return [];

    if (typeof valor === 'string') {
      try {
        const parsed = JSON.parse(valor);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }

    if (typeof valor === 'object') return [valor];
    return [];
  }

  // Crea un texto corto desde arreglos simples o JSONB para mostrarlo en popups.
  function textoLista(valor, max = 4) {
    const arr = Array.isArray(valor) ? valor : normalizarArregloJsonb(valor);
    const limpio = arr
      .map(item => typeof item === 'string' ? item : (item?.nombre || item?.pueblo || item?.label || item?.municipio || ''))
      .map(item => String(item || '').trim())
      .filter(Boolean);

    if (!limpio.length) return '—';
    const base = limpio.slice(0, max).join(', ');
    return limpio.length > max ? `${base}…` : base;
  }

  // Normaliza coordenadas esperadas para Colombia antes de pintar en Leaflet.
  function normalizarCoordenadasColombia(latEntrada, lngEntrada) {
    let lat = Number(latEntrada);
    let lng = Number(lngEntrada);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    // Caso común: lat y lng vienen invertidas, por ejemplo lat=-74 y lng=4.
    const pareceLatitudComoLongitud = Math.abs(lat) > 20 && Math.abs(lng) <= 15;
    if (pareceLatitudComoLongitud) {
      const temp = lat;
      lat = lng;
      lng = temp;
    }

    // Colombia está al occidente de Greenwich; por tanto la longitud debe ser negativa.
    if (lng > 0 && lng >= 60 && lng <= 85) lng = -lng;

    // Rango aproximado ampliado de Colombia para descartar puntos imposibles.
    const dentroColombia = lat >= -5.5 && lat <= 14.5 && lng >= -82 && lng <= -65;
    if (!dentroColombia) return null;

    return { lat, lng };
  }

  // Lee la configuración visual de puntos desde los controles del panel.
  function leerEstiloPuntosDesdePanel() {
    const cfg = window.SIG_CONFIG?.casos?.estiloPunto || {};

    return {
      radio: Number(qs('sigMarkerRadio')?.value || cfg.radio || 5),
      colorRelleno: qs('sigMarkerColor')?.value || cfg.colorRelleno || '#0d6efd',
      colorLinea: qs('sigMarkerLinea')?.value || cfg.colorLinea || '#052c65',
      grosorLinea: Number(qs('sigMarkerGrosor')?.value || cfg.grosorLinea || 1),
      opacidadRelleno: Number(qs('sigMarkerOpacidad')?.value || cfg.opacidadRelleno || 0.65),
      opacidadLinea: Number(qs('sigMarkerOpacidadLinea')?.value || cfg.opacidadLinea || 0.9)
    };
  }

  // Aplica al objeto global de configuración el estilo definido en el panel.
  function sincronizarEstiloPuntos() {
    if (!window.SIG_CONFIG) return;
    if (!window.SIG_CONFIG.casos) window.SIG_CONFIG.casos = {};
    window.SIG_CONFIG.casos.estiloPunto = leerEstiloPuntosDesdePanel();
    actualizarVistaPreviaPunto();
  }

  // Actualiza la muestra circular del panel para que el usuario vea el estilo seleccionado.
  function actualizarVistaPreviaPunto() {
    const preview = qs('sigMarkerPreview');
    if (!preview) return;
    const estilo = window.SIG_CONFIG?.casos?.estiloPunto || leerEstiloPuntosDesdePanel();
    const radio = Number(estilo.radio || 5);
    preview.style.width = `${Math.max(10, radio * 2.4)}px`;
    preview.style.height = `${Math.max(10, radio * 2.4)}px`;
    preview.style.background = estilo.colorRelleno || '#0d6efd';
    preview.style.borderColor = estilo.colorLinea || '#052c65';
    preview.style.borderWidth = `${Math.max(1, Number(estilo.grosorLinea || 1))}px`;
    preview.style.opacity = String(estilo.opacidadRelleno ?? 0.65);
  }

  // Aplica el estilo vigente a los puntos ya pintados sin volver a consultar Supabase.
  function actualizarEstiloPuntosEnMapa() {
    sincronizarEstiloPuntos();
    const state = window.SIG_STATE;
    const estilo = window.SIG_CONFIG?.casos?.estiloPunto || {};
    if (!state?.capaCasos) return;

    state.capaCasos.eachLayer(layer => {
      if (layer instanceof L.CircleMarker) {
        layer.setStyle({
          radius: Number(estilo.radio ?? 5),
          color: estilo.colorLinea || '#052c65',
          weight: Number(estilo.grosorLinea ?? 1),
          opacity: Number(estilo.opacidadLinea ?? 0.9),
          fillColor: estilo.colorRelleno || '#0d6efd',
          fillOpacity: Number(estilo.opacidadRelleno ?? 0.65)
        });
      }
    });
  }

  // Construye el popup resumido de cada punto de caso.
  function crearPopupCaso(registro, lugar) {
    const fecha = registro.fecha_evento || 'Sin fecha';
    const municipio = lugar?.municipio || 'Municipio no reportado';
    const departamento = lugar?.departamento || textoLista(registro.departamentos, 1) || registro.departamento || '—';
    const macroregion = lugar?.macroregion || textoLista(registro.macroregiones, 1) || registro.macroregion || '—';

    return `
      <div style="min-width:270px">
        <div class="fw-bold mb-1">Caso SIG</div>
        <div class="small text-muted mb-2">${escapeHtml(fecha)}</div>
        <table class="table table-sm mb-2">
          <tbody>
            <tr><th class="text-muted pe-2">Macrotipo</th><td>${escapeHtml(registro.macrotipo || '—')}</td></tr>
            <tr><th class="text-muted pe-2">Municipio</th><td>${escapeHtml(municipio)}</td></tr>
            <tr><th class="text-muted pe-2">Departamento</th><td>${escapeHtml(departamento)}</td></tr>
            <tr><th class="text-muted pe-2">Macroregión</th><td>${escapeHtml(macroregion)}</td></tr>
            <tr><th class="text-muted pe-2">Pueblos</th><td>${escapeHtml(textoLista(registro.pueblo))}</td></tr>
            <tr><th class="text-muted pe-2">Macroactor</th><td>${escapeHtml(registro.macroactor || '—')}</td></tr>
            <tr><th class="text-muted pe-2">Personas</th><td>${escapeHtml(registro.npersonas ?? 0)}</td></tr>
          </tbody>
        </table>
        <div class="text-muted small">ID: ${escapeHtml(String(registro.caso_id || '').slice(0, 8))}…</div>
      </div>`;
  }

  // Lee los filtros actuales del panel lateral.
  function leerFiltrosDesdePanel() {
    return {
      anio: limpiarValor(qs('filtroAnioSIG')?.value),
      departamento: limpiarValor(qs('filtroDepartamentoSIG')?.value),
      pueblo: limpiarValor(qs('filtroPuebloSIG')?.value),
      macrotipo: limpiarValor(qs('filtroMacrotipoSIG')?.value),
      macroregion: limpiarValor(qs('filtroMacroregionSIG')?.value),
      macroactor: limpiarValor(qs('filtroMacroactorSIG')?.value)
    };
  }

  // Copia los filtros leídos al estado interno, para tener trazabilidad de la consulta actual.
  function guardarFiltrosActivos(filtros) {
    Object.assign(filtrosActivos, filtros);
  }

  // Genera el texto visible que informa qué filtros están aplicados.
  function actualizarTextoFiltrosActivos(filtros = filtrosActivos) {
    const host = qs('textoFiltrosActivos');
    if (!host) return;

    const activos = [];
    if (filtros.anio) activos.push(`Año ${filtros.anio}`);
    if (filtros.departamento) activos.push(`Departamento ${filtros.departamento}`);
    if (filtros.pueblo) activos.push(`Pueblo ${filtros.pueblo}`);
    if (filtros.macrotipo) activos.push(`Macrotipo ${filtros.macrotipo}`);
    if (filtros.macroregion) activos.push(`Macroregión ${filtros.macroregion}`);
    if (filtros.macroactor) activos.push(`Macroactor ${filtros.macroactor}`);

    host.className = activos.length ? 'alert alert-primary-subtle border small mb-3' : 'alert alert-light border small mb-3';
    host.innerHTML = activos.length
      ? `<div class="fw-semibold mb-1"><i class="bi bi-check2-circle me-1"></i>Filtros aplicados</div><div>${activos.map(escapeHtml).join(' · ')}</div>`
      : '<div class="fw-semibold mb-1"><i class="bi bi-info-circle me-1"></i>Sin filtros aplicados</div><div class="text-muted">Mostrando todos los registros disponibles para el SIG.</div>';
  }

  // Actualiza los contadores visibles del panel de filtros.
  function actualizarEstadisticasFiltros({ registros = 0, casosConCoordenadas = 0, puntos = 0 } = {}) {
    const statRegistros = qs('statRegistros');
    const statCasosCoord = qs('statCasosCoord');
    const statPuntos = qs('statPuntos');

    if (statRegistros) statRegistros.textContent = String(registros);
    if (statCasosCoord) statCasosCoord.textContent = String(casosConCoordenadas);
    if (statPuntos) statPuntos.textContent = String(puntos);
  }

  // Limpia la capa de puntos del mapa, pero no borra la configuración de filtros del panel.
  function limpiarRegistrosMapa() {
    const state = window.SIG_STATE;
    if (!state) return;

    if (state.capaCasos) state.capaCasos.clearLayers();
    state.casosConsultados = [];
    actualizarEstadisticasFiltros({ registros: 0, casosConCoordenadas: 0, puntos: 0 });
    actualizarEstado('Registros limpiados del mapa');
  }

  // Pinta registros de la RPC como circleMarker usando lugares[].lat y lugares[].lng.
  function pintarRegistrosEnMapa(registros) {
    const state = window.SIG_STATE;
    const cfg = window.SIG_CONFIG;

    if (!state?.mapa || !state?.capaCasos) return { registros: 0, casosConCoordenadas: 0, puntos: 0 };

    sincronizarEstiloPuntos();
    state.capaCasos.clearLayers();

    const estilo = cfg?.casos?.estiloPunto || {};
    const bounds = [];
    const casosConCoordenadas = new Set();
    let puntos = 0;

    registros.forEach(registro => {
      const lugares = normalizarArregloJsonb(registro.lugares);

      lugares.forEach(lugar => {
        const coord = normalizarCoordenadasColombia(lugar?.lat, lugar?.lng);
        if (!coord) return;

        const marker = L.circleMarker([coord.lat, coord.lng], {
          pane: cfg?.casos?.pane || 'pane9',
          radius: Number(estilo.radio ?? 5),
          color: estilo.colorLinea || '#052c65',
          weight: Number(estilo.grosorLinea ?? 1),
          opacity: Number(estilo.opacidadLinea ?? 0.9),
          fillColor: estilo.colorRelleno || '#0d6efd',
          fillOpacity: Number(estilo.opacidadRelleno ?? 0.65)
        });

        marker.bindPopup(crearPopupCaso(registro, lugar));
        marker.addTo(state.capaCasos);
        bounds.push([coord.lat, coord.lng]);
        casosConCoordenadas.add(String(registro.caso_id));
        puntos += 1;
      });
    });

    if (bounds.length) {
      state.mapa.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: cfg?.casos?.zoomMaximoAjuste || 9
      });
    }

    return {
      registros: registros.length,
      casosConCoordenadas: casosConCoordenadas.size,
      puntos
    };
  }

  // Consulta una RPC paginada hasta traer todos los registros disponibles.
  async function consultarRpcPaginada(nombreFuncion, parametros = {}, tamanoPagina = 1000) {
    const state = window.SIG_STATE;
    const cliente = state?.supabaseClient;
    if (!cliente) throw new Error('No hay conexión Supabase configurada.');

    const acumulado = [];
    let desde = 0;

    while (true) {
      const hasta = desde + tamanoPagina - 1;
      const { data, error } = await cliente
        .rpc(nombreFuncion, parametros)
        .range(desde, hasta);

      if (error) throw error;

      const pagina = Array.isArray(data) ? data : [];
      acumulado.push(...pagina);

      if (pagina.length < tamanoPagina) break;
      desde += tamanoPagina;
    }

    return acumulado;
  }

  // Ejecuta la consulta filtrada y actualiza mapa, texto y conteos.
  async function consultarYPintarCasosSIG(filtros, opciones = {}) {
    const state = window.SIG_STATE;
    const cfg = window.SIG_CONFIG;
    const nombreFuncion = cfg?.supabase?.rpcCasosMapaFiltrado || 'get_sig_casos_mapa_filtrado_2026';
    const boton = opciones.boton || null;
    const htmlOriginal = boton ? boton.innerHTML : '';

    const parametros = {
      p_anio: filtros.anio ? Number(filtros.anio) : null,
      p_departamento: filtros.departamento || null,
      p_pueblo: filtros.pueblo || null,
      p_macrotipo: filtros.macrotipo || null,
      p_macroregion: filtros.macroregion || null,
      p_macroactor: filtros.macroactor || null
    };

    try {
      if (boton) {
        boton.disabled = true;
        boton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Consultando...';
      }

      limpiarAvisoFiltros();
      actualizarEstado('Consultando filtros en Supabase...');
      mostrarAvisoFiltros('info', 'Consultando registros vinculados al filtro territorial...');

      const registros = await consultarRpcPaginada(nombreFuncion, parametros);
      state.casosConsultados = registros;

      const resumen = pintarRegistrosEnMapa(registros);
      actualizarEstadisticasFiltros(resumen);
      limpiarAvisoFiltros();

      if (resumen.puntos) {
        actualizarEstado(`${resumen.puntos} puntos en mapa · ${resumen.registros} registros vinculados`);
      } else {
        actualizarEstado(`${resumen.registros} registros vinculados, sin coordenadas para pintar`);
        mostrarAvisoFiltros('warning', 'La consulta encontró registros, pero ninguno tiene coordenadas válidas para el mapa.');
      }
    } catch (error) {
      console.error(error);
      mostrarAvisoFiltros('danger', error?.message || 'No fue posible consultar los registros del SIG.');
      actualizarEstado('Error consultando Supabase');
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.innerHTML = htmlOriginal;
      }
    }
  }

  // Acción directa: mostrar todos los registros equivale a consultar con filtros vacíos.
  async function mostrarTodosLosRegistros() {
    const filtros = {
      anio: null,
      departamento: null,
      pueblo: null,
      macrotipo: null,
      macroregion: null,
      macroactor: null
    };
    guardarFiltrosActivos(filtros);
    actualizarTextoFiltrosActivos(filtros);
    await consultarYPintarCasosSIG(filtros, { boton: qs('btnMostrarTodosRegistros') });
  }

  // Aplica simultáneamente todos los filtros seleccionados en el panel.
  async function aplicarFiltrosSIG() {
    const filtros = leerFiltrosDesdePanel();
    guardarFiltrosActivos(filtros);
    actualizarTextoFiltrosActivos(filtros);
    await consultarYPintarCasosSIG(filtros, { boton: qs('btnAplicarFiltrosSIG') });
  }

  // Limpia los controles del panel y vuelve a mostrar todos los registros.
  async function limpiarFiltrosSIG() {
    ['filtroAnioSIG', 'filtroDepartamentoSIG', 'filtroPuebloSIG', 'filtroMacrotipoSIG', 'filtroMacroregionSIG', 'filtroMacroactorSIG']
      .forEach(id => {
        const el = qs(id);
        if (el) el.value = '';
      });

    const filtros = {
      anio: null,
      departamento: null,
      pueblo: null,
      macrotipo: null,
      macroregion: null,
      macroactor: null
    };

    guardarFiltrosActivos(filtros);
    actualizarTextoFiltrosActivos(filtros);
    await consultarYPintarCasosSIG(filtros, { boton: qs('btnLimpiarFiltrosSIG') });
  }

  // Carga opciones de filtros desde la función RPC y llena los select.
  async function cargarOpcionesFiltros() {
    const state = window.SIG_STATE;
    const cfg = window.SIG_CONFIG;
    const cliente = state?.supabaseClient;
    if (!cliente) return;

    const nombreFuncion = cfg?.supabase?.rpcOpcionesFiltros || 'get_sig_opciones_filtros_2026';

    try {
      const { data, error } = await cliente.rpc(nombreFuncion);
      if (error) throw error;

      const fila = Array.isArray(data) ? data[0] : data;
      const opciones = fila?.opciones || fila || {};

      llenarSelect('filtroAnioSIG', opciones.anios || [], 'Todos los años');
      llenarSelect('filtroDepartamentoSIG', opciones.departamentos || [], 'Todos los departamentos');
      llenarSelect('filtroPuebloSIG', opciones.pueblos || [], 'Todos los pueblos');
      llenarSelect('filtroMacrotipoSIG', opciones.macrotipos || [], 'Todos los macrotipos');
      llenarSelect('filtroMacroregionSIG', opciones.macroregiones || [], 'Todas las macroregiones');
      llenarSelect('filtroMacroactorSIG', opciones.macroactores || [], 'Todos los macroactores');
    } catch (error) {
      console.error(error);
      mostrarAvisoFiltros('warning', 'No se pudieron cargar las opciones de filtros. Revisa la función get_sig_opciones_filtros_2026().');
    }
  }

  // Llena un select conservando una primera opción vacía.
  function llenarSelect(id, valores, etiquetaTodos) {
    const select = qs(id);
    if (!select) return;

    const valorActual = select.value;
    const lista = Array.from(new Set((valores || [])
      .map(v => String(v ?? '').trim())
      .filter(Boolean)))
      .sort((a, b) => {
        const na = Number(a), nb = Number(b);
        if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
        return a.localeCompare(b, 'es');
      });

    select.innerHTML = '';
    select.appendChild(new Option(etiquetaTodos, ''));
    lista.forEach(valor => select.appendChild(new Option(valor, valor)));

    if (valorActual && lista.some(v => normTxt(v) === normTxt(valorActual))) {
      select.value = valorActual;
    }
  }

  // Enlaza los controles del panel de filtros con sus funciones.
  function vincularPanelFiltros() {
    qs('btnMostrarTodosRegistros')?.addEventListener('click', mostrarTodosLosRegistros);
    qs('btnAplicarFiltrosSIG')?.addEventListener('click', aplicarFiltrosSIG);
    qs('btnLimpiarFiltrosSIG')?.addEventListener('click', limpiarFiltrosSIG);
    qs('btnLimpiarRegistros')?.addEventListener('click', limpiarRegistrosMapa);

    ['sigMarkerRadio', 'sigMarkerColor', 'sigMarkerLinea', 'sigMarkerGrosor', 'sigMarkerOpacidad', 'sigMarkerOpacidadLinea']
      .forEach(id => qs(id)?.addEventListener('input', actualizarEstiloPuntosEnMapa));
  }

  // Inicializa valores visuales de controles de circleMarker desde configlayers.js.
  function inicializarControlesVisuales() {
    const estilo = window.SIG_CONFIG?.casos?.estiloPunto || {};
    const asignar = (id, valor) => {
      const el = qs(id);
      if (el && valor !== undefined && valor !== null) el.value = String(valor);
    };

    asignar('sigMarkerRadio', estilo.radio ?? 5);
    asignar('sigMarkerColor', estilo.colorRelleno || '#0d6efd');
    asignar('sigMarkerLinea', estilo.colorLinea || '#052c65');
    asignar('sigMarkerGrosor', estilo.grosorLinea ?? 1);
    asignar('sigMarkerOpacidad', estilo.opacidadRelleno ?? 0.65);
    asignar('sigMarkerOpacidadLinea', estilo.opacidadLinea ?? 0.9);
    actualizarVistaPreviaPunto();
  }

  // Inicializa el módulo de datos cuando sigindex.html ya creó el mapa y SIG_STATE.
  async function inicializar() {
    const state = window.SIG_STATE;
    if (!state) {
      console.warn('SIG_STATE no existe. Revisa el orden de carga de scripts.');
      return;
    }

    state.supabaseClient = crearClienteSupabaseSIG();
    if (!state.capaCasos && state.mapa) {
      state.capaCasos = L.layerGroup().addTo(state.mapa);
    }

    inicializarControlesVisuales();
    actualizarTextoFiltrosActivos(filtrosActivos);
    actualizarEstadisticasFiltros({ registros: 0, casosConCoordenadas: 0, puntos: 0 });
    vincularPanelFiltros();
    await cargarOpcionesFiltros();
  }

  // API global mínima para que sigindex.html pueda inicializar el módulo.
  window.SIG_DATOS = {
    inicializar,
    mostrarTodosLosRegistros,
    aplicarFiltrosSIG,
    limpiarFiltrosSIG,
    limpiarRegistrosMapa,
    pintarRegistrosEnMapa
  };
})();
