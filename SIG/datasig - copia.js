/*
  datasig.js
  Paso 2 de reconstrucción del módulo SIG.

  Esta versión mantiene el panel de filtros sin filtros activos y realiza una
  prueba mínima de acceso público controlado a Supabase sobre la vista
  sig_casos_public_2026.

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

  function pintarPanelConexion(tipo, titulo, mensaje, detalle, metricas) {
    const panel = qs('panelFiltrosContenido');
    if (!panel) return;

    const iconos = {
      cargando: 'bi-arrow-repeat',
      exito: 'bi-check-circle-fill',
      error: 'bi-exclamation-triangle-fill',
      aviso: 'bi-info-circle-fill'
    };

    const clases = {
      cargando: 'alert-primary',
      exito: 'alert-success',
      error: 'alert-danger',
      aviso: 'alert-warning'
    };

    const bloqueMetricas = metricas ? `
      <div class="row g-2 mt-2">
        ${metricas.map(item => `
          <div class="col-6">
            <div class="border rounded-3 p-2 bg-white h-100">
              <div class="small text-muted">${escapeHtml(item.etiqueta)}</div>
              <div class="fw-bold fs-6">${escapeHtml(item.valor)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : '';

    panel.dataset.estado = 'conexion-vista-sig';
    panel.innerHTML = `
      <div class="filter-block">
        <div class="filter-block-title">
          <i class="bi bi-database-check"></i>
          <span>Conexión a datos</span>
        </div>
        <div class="alert ${clases[tipo] || clases.aviso} mb-2" role="status">
          <div class="d-flex align-items-start gap-2">
            <i class="bi ${iconos[tipo] || iconos.aviso} mt-1"></i>
            <div>
              <div class="fw-bold">${escapeHtml(titulo)}</div>
              <div>${escapeHtml(mensaje)}</div>
            </div>
          </div>
        </div>
        ${bloqueMetricas}
        ${detalle ? `<div class="sig-help mt-2">${escapeHtml(detalle)}</div>` : ''}
        <div class="population-note mt-2">
          Paso actual: validar la vista pública. Aún no se reconstruyen filtros, no se pintan puntos y no se cargan popups.
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
      timer = window.setTimeout(() => reject(new Error(`La prueba superó ${ms / 1000} segundos.`)), ms);
    });

    return Promise.race([promesa, timeout]).finally(() => window.clearTimeout(timer));
  }

  function validarFilaVista(fila) {
    if (!fila) return [];

    const requeridos = [
      'punto_id',
      'caso_id',
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
    ];

    return requeridos.filter(campo => !(campo in fila));
  }

  async function contarCasosUnicos(cliente, vista, totalPuntos, timeoutMs) {
    const cfg = window.SIG_CONFIG?.supabase || {};
    const maxFilas = Number(cfg.maxFilasConteoCasosUnicos || 5000);

    if (!totalPuntos || totalPuntos > maxFilas) {
      return {
        calculado: false,
        valor: null,
        detalle: totalPuntos > maxFilas
          ? `Casos únicos no calculados para evitar cargar más de ${formatoNumero(maxFilas)} filas de prueba.`
          : 'Casos únicos no calculados porque la vista no reportó puntos.'
      };
    }

    const consulta = cliente
      .from(vista)
      .select('caso_id')
      .range(0, Math.max(totalPuntos - 1, 0));

    const { data, error } = await conTimeout(consulta, timeoutMs);
    if (error) throw error;

    const casos = new Set((data || []).map(item => item.caso_id).filter(Boolean));
    return {
      calculado: true,
      valor: casos.size,
      detalle: `Casos únicos calculados con ${formatoNumero((data || []).length)} filas de la vista.`
    };
  }

  async function probarAccesoVistaSIG(cliente) {
    const cfg = window.SIG_CONFIG?.supabase || {};
    const vista = cfg.vistaCasos || 'sig_casos_public_2026';
    const timeoutMs = Number(cfg.timeoutConsultaMs || 15000);

    pintarPanelConexion(
      'cargando',
      'Probando acceso...',
      `Consultando ${vista} con clave pública controlada.`,
      'Esta prueba solicita una fila y el conteo de puntos disponibles para evitar carga pesada.'
    );
    actualizarEstado('Probando acceso a vista SIG...');

    const consulta = cliente
      .from(vista)
      .select('punto_id, caso_id, fecha_evento, anio, macrotipo, departamento, macroregion, municipio, lat, lng, pueblo, npersonas, nmujeres, nhombres, nmenores, macroactor, contextual_type', { count: 'exact' })
      .limit(1);

    const { data, error, count } = await conTimeout(consulta, timeoutMs);

    if (error) {
      throw error;
    }

    const filaPrueba = Array.isArray(data) && data.length ? data[0] : null;
    const camposFaltantes = validarFilaVista(filaPrueba);
    const totalPuntos = Number(count || 0);
    const totalCasos = await contarCasosUnicos(cliente, vista, totalPuntos, timeoutMs);

    return {
      vista,
      filaPrueba,
      camposFaltantes,
      puntos: totalPuntos,
      casosUnicos: totalCasos
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
      pintarPanelConexion('error', 'No se pudo iniciar Supabase', error, 'Revisa el orden de scripts y la configuración pública.');
      actualizarEstado('SIG listo · Supabase sin iniciar');
      return;
    }

    state.supabaseClient = cliente;

    try {
      const resultado = await probarAccesoVistaSIG(cliente);
      const casosUnicosTexto = resultado.casosUnicos.calculado
        ? formatoNumero(resultado.casosUnicos.valor)
        : 'Pendiente';

      const detalle = resultado.camposFaltantes.length
        ? `Acceso confirmado, pero faltan campos esperados en la vista: ${resultado.camposFaltantes.join(', ')}.`
        : resultado.casosUnicos.detalle;

      state.pruebaSupabase = {
        ok: true,
        vista: resultado.vista,
        puntos: resultado.puntos,
        casosUnicos: resultado.casosUnicos,
        camposFaltantes: resultado.camposFaltantes,
        filaPrueba: resultado.filaPrueba,
        fecha: new Date().toISOString()
      };

      pintarPanelConexion(
        resultado.camposFaltantes.length ? 'aviso' : 'exito',
        resultado.camposFaltantes.length ? 'Acceso confirmado con revisión pendiente' : 'Acceso confirmado a vista SIG',
        `El SIG accedió correctamente a ${resultado.vista}.`,
        detalle,
        [
          { etiqueta: 'Puntos disponibles', valor: formatoNumero(resultado.puntos) },
          { etiqueta: 'Casos únicos', valor: casosUnicosTexto },
          { etiqueta: 'Fuente de municipios', valor: 'caso_municipio_2026' },
          { etiqueta: 'Tabla base', valor: 'casos_2026' }
        ]
      );
      actualizarEstado(`SIG listo · vista ${resultado.vista} confirmada`);
    } catch (err) {
      const mensaje = err?.message || 'Error desconocido al consultar la vista SIG.';
      state.pruebaSupabase = {
        ok: false,
        error: mensaje,
        fecha: new Date().toISOString()
      };

      pintarPanelConexion(
        'error',
        'No se confirmó el acceso a la vista SIG',
        mensaje,
        'Revisa que exista public.sig_casos_public_2026, que tenga permisos de lectura para anon y que la vista use los campos acordados.'
      );
      actualizarEstado('SIG listo · acceso a vista SIG pendiente');
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
