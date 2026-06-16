/*
  datasig.js
  Paso 3 de reconstrucción del módulo SIG.

  Esta versión mantiene el panel de filtros sin filtros activos y realiza una
  prueba mínima de lectura sobre casos_2026 para confirmar que los datos cargan.

  No carga filtros, no pinta puntos, no usa RPC, no usa tablas ligeras antiguas,
  no consulta lugares y no incorpora consola avanzada.
*/
(function () {
  'use strict';

  const VERSION = '20260615-sig-panel-filtros-blanco-v2';
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

  async function cargarConteoCasos(cliente) {
    const cfg = window.SIG_CONFIG?.supabase || {};
    const tabla = cfg.tablaCasos || 'casos_2026';
    const timeoutMs = Number(cfg.timeoutConsultaMs || 15000);

    pintarPanelCarga('cargando', 'Cargando datos...', 'Consultando casos_2026.');
    actualizarEstado('Cargando datos core del SIG...');

    const consulta = cliente
      .from(tabla)
      .select('id', { count: 'exact' })
      .limit(1);

    const { error, count } = await conTimeout(consulta, timeoutMs);

    if (error) throw error;

    return {
      tabla,
      casos: Number(count || 0)
    };
  }

  async function inicializar() {
    const state = window.SIG_STATE;
    if (!state) return;

    if (!state.capaCasos && state.mapa && window.L) {
      state.capaCasos = L.layerGroup().addTo(state.mapa);
    }

    state.casosConsultados = [];

    const { cliente, error } = crearClienteSupabaseSIG();
    if (error) {
      state.supabaseClient = null;
      pintarPanelCarga('error', 'No se pudo iniciar Supabase', error);
      actualizarEstado('SIG listo · Supabase sin iniciar');
      return;
    }

    state.supabaseClient = cliente;

    try {
      const resultado = await cargarConteoCasos(cliente);

      state.pruebaSupabase = {
        ok: true,
        tabla: resultado.tabla,
        casos: resultado.casos,
        fecha: new Date().toISOString()
      };

      pintarPanelCarga(
        'exito',
        'Datos cargados correctamente',
        `Casos cargados: ${formatoNumero(resultado.casos)}.`
      );
      actualizarEstado(`SIG listo · ${formatoNumero(resultado.casos)} casos cargados`);
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
    mostrarTodosLosRegistros: noop,
    aplicarFiltrosSIG: noop,
    limpiarFiltrosSIG: noop,
    limpiarRegistrosMapa: noop,
    pintarRegistrosEnMapa: noop,
    aplicarMapaCalorDepartamentos: noop,
    limpiarMapaCalorDepartamentos: noop,
    refrescarMapaCalorDepartamentos: noop,
    obtenerEstiloDepartamentoCalor,
    crearPopupDepartamentoCalor
  };
})();
