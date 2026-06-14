/*
  datasig.js
  Administración de datos, filtros y puntos del módulo SIG.

  Este archivo concentra la conexión a Supabase, el panel de filtros, la consulta
  pública controlada y la representación de casos en el mapa. sigindex.html queda
  encargado de la estructura visual general y del panel de capas GeoJSON.
*/
(function () {
  'use strict';

  // Lista base de departamentos de Colombia para que el filtro exista aunque la RPC de opciones falle.
  const DEPARTAMENTOS_COLOMBIA = [
    'Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bogotá D.C.', 'Bolívar', 'Boyacá', 'Caldas',
    'Caquetá', 'Casanare', 'Cauca', 'Cesar', 'Chocó', 'Córdoba', 'Cundinamarca', 'Guainía',
    'Guaviare', 'Huila', 'La Guajira', 'Magdalena', 'Meta', 'Nariño', 'Norte de Santander',
    'Putumayo', 'Quindío', 'Risaralda', 'San Andrés y Providencia', 'Santander', 'Sucre',
    'Tolima', 'Valle del Cauca', 'Vaupés', 'Vichada'
  ];

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

  // Normaliza texto para comparar filtros sin depender de mayúsculas ni tildes en el frontend.
  function normLocal(valor) {
    return String(valor || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
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

  // Actualiza los contadores visibles del panel: registros totales del filtro, casos ubicables y puntos.
  function actualizarEstadisticasFiltros({ total = 0, casos = 0, puntos = 0 } = {}) {
    const statTotal = qs('statTotalFiltro');
    const statCasos = qs('statCasos');
    const statPuntos = qs('statPuntos');
    if (statTotal) statTotal.textContent = String(total);
    if (statCasos) statCasos.textContent = String(casos);
    if (statPuntos) statPuntos.textContent = String(puntos);
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

  // Convierte valores de coordenadas en números seguros. Acepta coma decimal.
  function numeroCoordenada(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const numero = Number(String(valor).trim().replace(',', '.'));
    return Number.isFinite(numero) ? numero : null;
  }

  // Verifica si una coordenada está dentro de un rango amplio de Colombia.
  function coordenadaEnColombia(lat, lng) {
    return lat >= -5 && lat <= 15 && lng >= -82 && lng <= -60;
  }

  // Normaliza coordenadas para Colombia antes de pintar en Leaflet.
  // Corrige longitud positiva y pares lat/lng invertidos.
  function normalizarCoordenadasColombia(latOriginal, lngOriginal) {
    const lat = numeroCoordenada(latOriginal);
    const lng = numeroCoordenada(lngOriginal);

    if (lat === null || lng === null) return null;

    const candidatos = [
      { lat, lng },
      { lat, lng: -Math.abs(lng) },
      { lat: lng, lng: lat },
      { lat: lng, lng: -Math.abs(lat) },
      { lat: Math.abs(lng), lng: -Math.abs(lat) }
    ];

    for (const candidato of candidatos) {
      if (coordenadaEnColombia(candidato.lat, candidato.lng)) return candidato;
    }

    console.warn('Coordenada descartada fuera de Colombia:', { latOriginal, lngOriginal, lat, lng });
    return null;
  }

  // Construye el popup resumido de cada punto de caso.
  function crearPopupCaso(registro, lugar) {
    const fecha = registro.fecha_evento || 'Sin fecha';
    const municipio = lugar?.municipio || 'Municipio no reportado';
    const departamento = lugar?.departamento || textoLista(registro.departamentos, 1) || registro.departamento || '—';
    const macroregion = lugar?.macroregion || textoLista(registro.macroregiones, 1) || registro.macroregion || '—';
    const macrotipo = registro.macrotipo || 'Sin macrotipo';

    return `
      <div style="min-width:270px">
        <div class="fw-bold mb-1">Caso SIG</div>
        <div class="small text-muted mb-2">${escapeHtml(fecha)} · ${escapeHtml(macrotipo)}</div>
        <table class="table table-sm mb-2">
          <tbody>
            <tr><th class="text-muted pe-2">Macrotipo</th><td>${escapeHtml(macrotipo)}</td></tr>
            <tr><th class="text-muted pe-2">Municipio</th><td>${escapeHtml(municipio)}</td></tr>
            <tr><th class="text-muted pe-2">Departamento</th><td>${escapeHtml(departamento)}</td></tr>
            <tr><th class="text-muted pe-2">Macroregión</th><td>${escapeHtml(macroregion)}</td></tr>
            <tr><th class="text-muted pe-2">Pueblos</th><td>${escapeHtml(textoLista(registro.pueblo))}</td></tr>
            <tr><th class="text-muted pe-2">Personas</th><td>${escapeHtml(registro.npersonas ?? 0)}</td></tr>
            <tr><th class="text-muted pe-2">Actor</th><td>${escapeHtml(registro.macroactor || '—')}</td></tr>
          </tbody>
        </table>
        <div class="text-muted small">ID: ${escapeHtml(String(registro.caso_id || '').slice(0, 8))}…</div>
      </div>`;
  }

  // Lee los estilos vigentes para circleMarker desde SIG_CONFIG.
  function obtenerEstiloPunto() {
    const estilo = window.SIG_CONFIG?.casos?.estiloPunto || {};
    return {
      radio: Number(estilo.radio ?? 5),
      colorRelleno: estilo.colorRelleno || '#0d6efd',
      colorLinea: estilo.colorLinea || '#084298',
      opacidadRelleno: Number(estilo.opacidadRelleno ?? 0.65),
      opacidadLinea: Number(estilo.opacidadLinea ?? 0.9),
      grosorLinea: Number(estilo.grosorLinea ?? 1)
    };
  }

  // Limpia del mapa la capa de puntos proveniente de Supabase.
  function limpiarRegistrosMapa() {
    const state = window.SIG_STATE;
    if (!state) return;

    if (state.capaCasos) state.capaCasos.clearLayers();
    state.casosConsultados = [];
    actualizarEstadisticasFiltros({ total: 0, casos: 0, puntos: 0 });
    actualizarEstado('Registros limpiados del mapa');
  }

  // Pinta registros de la RPC como circleMarker usando lugares[].lat y lugares[].lng.
  // El total cuenta todos los casos devueltos por el filtro, incluso si no tienen coordenadas.
  function pintarRegistrosEnMapa(registros) {
    const state = window.SIG_STATE;
    const cfg = window.SIG_CONFIG;

    if (!state?.mapa || !state?.capaCasos) return { total: 0, casos: 0, puntos: 0 };

    state.capaCasos.clearLayers();
    const bounds = [];
    const casosConCoordenadas = new Set();
    let puntos = 0;

    registros.forEach(registro => {
      const lugares = normalizarArregloJsonb(registro.lugares);

      lugares.forEach(lugar => {
        const coord = normalizarCoordenadasColombia(lugar?.lat, lugar?.lng);
        if (!coord) return;

        const { lat, lng } = coord;
        const estilo = obtenerEstiloPunto();
        const marker = L.circleMarker([lat, lng], {
          pane: cfg?.casos?.pane || 'pane9',
          radius: estilo.radio,
          color: estilo.colorLinea,
          weight: estilo.grosorLinea,
          opacity: estilo.opacidadLinea,
          fillColor: estilo.colorRelleno,
          fillOpacity: estilo.opacidadRelleno
        });

        marker.bindPopup(crearPopupCaso(registro, lugar));
        marker.addTo(state.capaCasos);
        bounds.push([lat, lng]);
        puntos += 1;
        casosConCoordenadas.add(String(registro.caso_id));
      });
    });

    if (bounds.length) {
      state.mapa.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: cfg?.casos?.zoomMaximoAjuste || 9
      });
    }

    return { total: registros.length, casos: casosConCoordenadas.size, puntos };
  }

  // Repinta los registros ya consultados cuando se cambia color, radio, línea u opacidad.
  function repintarRegistrosActuales() {
    const state = window.SIG_STATE;
    const registros = Array.isArray(state?.casosConsultados) ? state.casosConsultados : [];
    const resumen = pintarRegistrosEnMapa(registros);
    actualizarEstadisticasFiltros(resumen);
  }

  // Consulta una RPC paginando resultados para superar el límite estándar de 1000 filas de Supabase.
  async function consultarRpcPaginada(cliente, nombreFuncion, parametros = {}, opciones = {}) {
    const tamanoPagina = Number(opciones.tamanoPagina || 1000);
    const maxPaginas = Number(opciones.maxPaginas || 100);
    const acumulado = [];

    let desde = 0;
    let pagina = 0;

    while (pagina < maxPaginas) {
      const hasta = desde + tamanoPagina - 1;

      actualizarEstado(`Consultando Supabase ${desde + 1}-${hasta + 1}...`);
      mostrarAvisoFiltros('info', `Consultando registros ${desde + 1} a ${hasta + 1}...`);

      const { data, error } = await cliente
        .rpc(nombreFuncion, parametros)
        .range(desde, hasta);

      if (error) throw error;

      const lote = Array.isArray(data) ? data : [];
      acumulado.push(...lote);

      if (lote.length < tamanoPagina) break;

      pagina += 1;
      desde += tamanoPagina;
    }

    return acumulado;
  }

  // Devuelve el año vigente para construir el filtro de 2016 hasta hoy.
  function anioActual() {
    return new Date().getFullYear();
  }

  // Llena un select de opciones. El valor vacío representa "todos".
  function llenarSelect(id, opciones, etiquetaTodos) {
    const select = qs(id);
    if (!select) return;

    const vistos = new Set();
    const limpias = (opciones || [])
      .map(v => String(v || '').trim())
      .filter(Boolean)
      .filter(v => {
        const k = normLocal(v);
        if (!k || vistos.has(k)) return false;
        vistos.add(k);
        return true;
      })
      .sort((a, b) => a.localeCompare(b, 'es'));

    select.innerHTML = `<option value="">${escapeHtml(etiquetaTodos)}</option>` +
      limpias.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  }

  // Llena el filtro de años desde 2016 hasta el año vigente.
  function llenarAnios() {
    const select = qs('filtroAnioSIG');
    if (!select) return;

    const actual = anioActual();
    const anios = [];
    for (let y = actual; y >= 2016; y -= 1) anios.push(y);

    select.innerHTML = '<option value="">Todos los años</option>' +
      anios.map(y => `<option value="${y}">${y}</option>`).join('');
  }

  // Construye los parámetros de la RPC desde los controles del panel.
  function leerFiltrosActivos() {
    const anioRaw = qs('filtroAnioSIG')?.value || '';
    return {
      p_anio: anioRaw ? Number(anioRaw) : null,
      p_departamento: qs('filtroDepartamentoSIG')?.value || null,
      p_pueblo: qs('filtroPuebloSIG')?.value || null,
      p_macrotipo: qs('filtroMacrotipoSIG')?.value || null,
      p_macroregion: qs('filtroMacroregionSIG')?.value || null,
      p_macroactor: qs('filtroMacroactorSIG')?.value || null
    };
  }

  // Limpia todos los filtros territoriales y temáticos.
  function limpiarFiltros() {
    ['filtroAnioSIG', 'filtroDepartamentoSIG', 'filtroPuebloSIG', 'filtroMacrotipoSIG', 'filtroMacroregionSIG', 'filtroMacroactorSIG']
      .forEach(id => {
        const el = qs(id);
        if (el) el.value = '';
      });
  }

  // Consulta opciones para los filtros desde una RPC liviana. Si falla, usa valores de respaldo.
  async function cargarOpcionesFiltros() {
    llenarAnios();
    llenarSelect('filtroDepartamentoSIG', DEPARTAMENTOS_COLOMBIA, 'Todos los departamentos');

    const cliente = window.SIG_STATE?.supabaseClient;
    const nombreFuncion = window.SIG_CONFIG?.supabase?.rpcOpcionesFiltros || 'get_sig_opciones_filtros_2026';
    if (!cliente) return;

    try {
      const { data, error } = await cliente.rpc(nombreFuncion);
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      const opciones = row?.opciones || row || {};

      llenarSelect('filtroDepartamentoSIG', opciones.departamentos?.length ? opciones.departamentos : DEPARTAMENTOS_COLOMBIA, 'Todos los departamentos');
      llenarSelect('filtroPuebloSIG', opciones.pueblos || [], 'Todos los pueblos');
      llenarSelect('filtroMacrotipoSIG', opciones.macrotipos || [], 'Todos los macrotipos');
      llenarSelect('filtroMacroregionSIG', opciones.macroregiones || [], 'Todas las macroregiones');
      llenarSelect('filtroMacroactorSIG', opciones.macroactores || [], 'Todos los macroactores');
    } catch (error) {
      console.warn('No se pudieron cargar opciones dinámicas de filtros:', error);
      llenarSelect('filtroPuebloSIG', [], 'Todos los pueblos');
      llenarSelect('filtroMacrotipoSIG', [], 'Todos los macrotipos');
      llenarSelect('filtroMacroregionSIG', [], 'Todas las macroregiones');
      llenarSelect('filtroMacroactorSIG', [], 'Todos los macroactores');
      mostrarAvisoFiltros('warning', 'No se pudieron cargar opciones dinámicas. Revisa la función de filtros en Supabase.');
    }
  }

  // Consulta la RPC pública controlada y muestra registros según filtros activos.
  async function consultarRegistrosSIG({ limpiar = false } = {}) {
    const state = window.SIG_STATE;
    const cfg = window.SIG_CONFIG;
    const cliente = state?.supabaseClient;
    const btn = limpiar ? qs('btnMostrarTodosRegistros') : qs('btnAplicarFiltrosSIG');

    if (!cliente) {
      mostrarAvisoFiltros('danger', 'No hay conexión Supabase configurada.');
      return;
    }

    if (limpiar) limpiarFiltros();

    const nombreFuncion = cfg?.supabase?.rpcCasosMapa || 'get_sig_casos_mapa_filtrado_2026';
    const parametros = leerFiltrosActivos();
    const htmlOriginal = btn ? btn.innerHTML : '';

    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Consultando...';
      }

      mostrarAvisoFiltros('info', 'Consultando registros disponibles para el SIG...');
      actualizarEstado('Consultando Supabase...');

      const registros = await consultarRpcPaginada(cliente, nombreFuncion, parametros, {
        tamanoPagina: cfg?.supabase?.tamanoPagina || 1000,
        maxPaginas: cfg?.supabase?.maxPaginas || 100
      });

      state.casosConsultados = registros;
      const resumen = pintarRegistrosEnMapa(registros);

      actualizarEstadisticasFiltros(resumen);
      limpiarAvisoFiltros();
      actualizarEstado(`${resumen.total} registros filtrados · ${resumen.puntos} puntos en mapa`);

      if (!resumen.puntos) {
        mostrarAvisoFiltros('warning', 'La consulta respondió, pero no encontró coordenadas válidas para pintar. El total del filtro sí incluye registros sin ubicación.');
      }
    } catch (error) {
      console.error(error);
      mostrarAvisoFiltros('danger', error?.message || 'No fue posible consultar los registros del SIG.');
      actualizarEstado('Error consultando Supabase');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = htmlOriginal;
      }
    }
  }

  // Crea una paleta de color reutilizable dentro del panel de filtros.
  function crearSelectorColorFiltros({ contenedorId, muestraId, etiqueta, valorInicial, onChange }) {
    const contenedor = qs(contenedorId);
    if (!contenedor) return;

    contenedor.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'dropdown';

    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'color-picker-btn dropdown-toggle';
    boton.setAttribute('data-bs-toggle', 'dropdown');
    boton.setAttribute('aria-expanded', 'false');

    const muestra = document.createElement('span');
    muestra.className = 'color-sample';
    muestra.id = muestraId;
    muestra.style.background = valorInicial;

    const texto = document.createElement('span');
    texto.textContent = etiqueta;

    boton.append(muestra, texto);

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu color-palette-menu shadow';

    const grilla = document.createElement('div');
    grilla.className = 'color-grid';

    (window.SIG_CONFIG?.paletaColores || []).forEach(color => {
      const opcion = document.createElement('button');
      opcion.type = 'button';
      opcion.className = 'color-option';
      opcion.style.background = color;
      opcion.title = color;
      opcion.setAttribute('aria-label', `Seleccionar color ${color}`);
      if (color.toLowerCase() === String(valorInicial).toLowerCase()) opcion.classList.add('active');

      opcion.addEventListener('click', () => {
        muestra.style.background = color;
        grilla.querySelectorAll('.color-option').forEach(btn => btn.classList.remove('active'));
        opcion.classList.add('active');
        onChange(color);
        repintarRegistrosActuales();
      });

      grilla.appendChild(opcion);
    });

    menu.appendChild(grilla);
    wrapper.append(boton, menu);
    contenedor.appendChild(wrapper);
  }

  // Crea los controles de estilo del circleMarker: tamaño, color, línea y opacidad.
  function inicializarControlesPunto() {
    const cfg = window.SIG_CONFIG;
    if (!cfg?.casos?.estiloPunto) return;

    const estilo = cfg.casos.estiloPunto;

    const radio = qs('markerRadioSIG');
    const radioValor = qs('markerRadioValorSIG');
    if (radio) {
      radio.value = String(estilo.radio ?? 5);
      if (radioValor) radioValor.textContent = radio.value;
      radio.addEventListener('input', () => {
        estilo.radio = Number(radio.value);
        if (radioValor) radioValor.textContent = radio.value;
        repintarRegistrosActuales();
      });
    }

    const grosor = qs('markerGrosorSIG');
    if (grosor) {
      grosor.value = String(estilo.grosorLinea ?? 1);
      grosor.addEventListener('change', () => {
        estilo.grosorLinea = Number(grosor.value);
        repintarRegistrosActuales();
      });
    }

    const opRelleno = qs('markerOpacidadRellenoSIG');
    if (opRelleno) {
      opRelleno.value = String(estilo.opacidadRelleno ?? 0.65);
      opRelleno.addEventListener('change', () => {
        estilo.opacidadRelleno = Number(opRelleno.value);
        repintarRegistrosActuales();
      });
    }

    const opLinea = qs('markerOpacidadLineaSIG');
    if (opLinea) {
      opLinea.value = String(estilo.opacidadLinea ?? 0.9);
      opLinea.addEventListener('change', () => {
        estilo.opacidadLinea = Number(opLinea.value);
        repintarRegistrosActuales();
      });
    }

    crearSelectorColorFiltros({
      contenedorId: 'markerColorRellenoSlotSIG',
      muestraId: 'markerColorRellenoMuestraSIG',
      etiqueta: 'Color del punto',
      valorInicial: estilo.colorRelleno || '#0d6efd',
      onChange: color => { estilo.colorRelleno = color; }
    });

    crearSelectorColorFiltros({
      contenedorId: 'markerColorLineaSlotSIG',
      muestraId: 'markerColorLineaMuestraSIG',
      etiqueta: 'Color de línea',
      valorInicial: estilo.colorLinea || '#084298',
      onChange: color => { estilo.colorLinea = color; }
    });
  }

  // Enlaza los botones del panel de filtros con sus funciones.
  function vincularPanelFiltros() {
    qs('btnMostrarTodosRegistros')?.addEventListener('click', () => consultarRegistrosSIG({ limpiar: true }));
    qs('btnAplicarFiltrosSIG')?.addEventListener('click', () => consultarRegistrosSIG({ limpiar: false }));
    qs('btnLimpiarFiltrosSIG')?.addEventListener('click', limpiarFiltros);
    qs('btnLimpiarRegistros')?.addEventListener('click', limpiarRegistrosMapa);
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

    actualizarEstadisticasFiltros({ total: 0, casos: 0, puntos: 0 });
    inicializarControlesPunto();
    vincularPanelFiltros();
    await cargarOpcionesFiltros();
  }

  // Se expone una API global pequeña para que sigindex.html pueda inicializar filtros.
  window.SIG_DATOS = {
    inicializar,
    consultarRegistrosSIG,
    limpiarRegistrosMapa,
    pintarRegistrosEnMapa,
    repintarRegistrosActuales
  };
})();
