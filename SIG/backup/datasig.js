/*
  datasig.js
  Administración de datos y filtros del módulo SIG.

  Este archivo concentra la conexión a Supabase, la consulta pública controlada
  y la representación de casos en el mapa. La página sigindex.html conserva la
  estructura visual del mapa y las capas; este archivo administra solo datos,
  filtros, estadísticas y puntos provenientes de Supabase.
*/
(function () {
  'use strict';

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

  // Actualiza los contadores visibles de casos y puntos en el panel.
  function actualizarEstadisticasFiltros({ casos = 0, puntos = 0 } = {}) {
    const statCasos = qs('statCasos');
    const statPuntos = qs('statPuntos');
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



  // Convierte valores de coordenadas en números seguros.
  // Acepta números reales o textos numéricos con coma decimal.
  function numeroCoordenada(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const numero = Number(String(valor).trim().replace(',', '.'));
    return Number.isFinite(numero) ? numero : null;
  }

  // Verifica si una coordenada está dentro de un rango amplio de Colombia.
  // Este rango evita pintar puntos en otros continentes cuando hay errores de signo o de orden.
  function coordenadaEnColombia(lat, lng) {
    return lat >= -5 && lat <= 15 && lng >= -82 && lng <= -60;
  }

  // Normaliza coordenadas para Colombia antes de pintar en Leaflet.
  // Casos que corrige:
  // 1. Longitud positiva: lat 4.7, lng 74.1 -> lat 4.7, lng -74.1.
  // 2. Coordenadas invertidas: lat -74.1, lng 4.7 -> lat 4.7, lng -74.1.
  // 3. Coordenadas invertidas con longitud positiva: lat 74.1, lng 4.7 -> lat 4.7, lng -74.1.
  function normalizarCoordenadasColombia(latOriginal, lngOriginal) {
    const lat = numeroCoordenada(latOriginal);
    const lng = numeroCoordenada(lngOriginal);

    if (lat === null || lng === null) return null;

    const candidatos = [
      // Coordenada correcta.
      { lat, lng },

      // Longitud positiva convertida a negativa.
      { lat, lng: -Math.abs(lng) },

      // Coordenadas invertidas: lng realmente es lat y lat realmente es lng.
      { lat: lng, lng: lat },

      // Coordenadas invertidas y longitud sin signo negativo.
      { lat: lng, lng: -Math.abs(lat) },

      // Variante adicional para datos raros con ambos signos positivos.
      { lat: Math.abs(lng), lng: -Math.abs(lat) }
    ];

    for (const candidato of candidatos) {
      if (coordenadaEnColombia(candidato.lat, candidato.lng)) {
        return candidato;
      }
    }

    // Si no se puede reconocer como coordenada de Colombia, no se pinta.
    console.warn('Coordenada descartada fuera de Colombia:', { latOriginal, lngOriginal, lat, lng });
    return null;
  }

  // Construye el popup resumido de cada punto de caso.
  function crearPopupCaso(registro, lugar) {
    const fecha = registro.fecha_evento || 'Sin fecha';
    const municipio = lugar?.municipio || 'Municipio no reportado';
    const departamento = lugar?.departamento || textoLista(registro.departamentos, 1);
    const macroregion = lugar?.macroregion || textoLista(registro.macroregiones, 1);

    return `
      <div style="min-width:260px">
        <div class="fw-bold mb-1">Caso SIG</div>
        <div class="small text-muted mb-2">${escapeHtml(fecha)} · ${escapeHtml(registro.macrotipo || 'Sin macrotipo')}</div>
        <table class="table table-sm mb-2">
          <tbody>
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

  // Limpia del mapa la capa de puntos proveniente de Supabase.
  function limpiarRegistrosMapa() {
    const state = window.SIG_STATE;
    if (!state) return;

    if (state.capaCasos) state.capaCasos.clearLayers();
    state.casosConsultados = [];
    actualizarEstadisticasFiltros({ casos: 0, puntos: 0 });
    actualizarEstado('Registros limpiados del mapa');
  }

  // Pinta registros de la RPC como circleMarker usando lugares[].lat y lugares[].lng.
  function pintarRegistrosEnMapa(registros) {
    const state = window.SIG_STATE;
    const cfg = window.SIG_CONFIG;

    if (!state?.mapa || !state?.capaCasos) return { casos: 0, puntos: 0 };

    state.capaCasos.clearLayers();
    const bounds = [];
    let puntos = 0;

    registros.forEach(registro => {
      const lugares = normalizarArregloJsonb(registro.lugares);

      lugares.forEach(lugar => {
        const coord = normalizarCoordenadasColombia(lugar?.lat, lugar?.lng);
        if (!coord) return;

        const { lat, lng } = coord;
        const estilo = cfg?.casos?.estiloPunto || {};
        const marker = L.circleMarker([lat, lng], {
          pane: cfg?.casos?.pane || 'pane9',
          radius: Number(estilo.radio ?? 5),
          color: estilo.colorLinea || '#0d6efd',
          weight: Number(estilo.grosorLinea ?? 1),
          opacity: Number(estilo.opacidadLinea ?? 0.9),
          fillColor: estilo.colorRelleno || '#0d6efd',
          fillOpacity: Number(estilo.opacidadRelleno ?? 0.65)
        });

        marker.bindPopup(crearPopupCaso(registro, lugar));
        marker.addTo(state.capaCasos);
        bounds.push([lat, lng]);
        puntos += 1;
      });
    });

    if (bounds.length) {
      state.mapa.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: cfg?.casos?.zoomMaximoAjuste || 9
      });
    }

    return { casos: registros.length, puntos };
  }

  // Consulta una RPC paginando resultados para superar el límite estándar de 1000 filas de Supabase.
  // Supabase permite aplicar range() a funciones que retornan tabla; por eso pedimos bloques de 1000 registros.
  async function consultarRpcPaginada(cliente, nombreFuncion, opciones = {}) {
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
        .rpc(nombreFuncion)
        .range(desde, hasta);

      if (error) throw error;

      const lote = Array.isArray(data) ? data : [];
      acumulado.push(...lote);

      // Si llega una página incompleta, ya no hay más registros por consultar.
      if (lote.length < tamanoPagina) break;

      pagina += 1;
      desde += tamanoPagina;
    }

    return acumulado;
  }

  // Consulta la RPC pública controlada y muestra todos los registros con coordenadas.
  async function mostrarTodosLosRegistros() {
    const state = window.SIG_STATE;
    const cfg = window.SIG_CONFIG;
    const cliente = state?.supabaseClient;
    const btn = qs('btnMostrarTodosRegistros');

    if (!cliente) {
      mostrarAvisoFiltros('danger', 'No hay conexión Supabase configurada.');
      return;
    }

    const nombreFuncion = cfg?.supabase?.rpcCasosMapa || 'get_sig_casos_mapa_2026';
    const htmlOriginal = btn ? btn.innerHTML : '';

    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Consultando...';
      }

      mostrarAvisoFiltros('info', 'Consultando registros disponibles para el SIG...');
      actualizarEstado('Consultando Supabase...');

      // Se consulta por páginas porque Supabase devuelve máximo 1000 filas por respuesta
      // salvo que se cambie la configuración del API. Así no perdemos registros del mapa.
      const registros = await consultarRpcPaginada(cliente, nombreFuncion, {
        tamanoPagina: cfg?.supabase?.tamanoPagina || 1000,
        maxPaginas: cfg?.supabase?.maxPaginas || 100
      });
      state.casosConsultados = registros;
      const resumen = pintarRegistrosEnMapa(registros);

      actualizarEstadisticasFiltros(resumen);
      limpiarAvisoFiltros();
      actualizarEstado(`${resumen.puntos} puntos cargados desde Supabase`);

      if (!resumen.puntos) {
        mostrarAvisoFiltros('warning', 'La consulta respondió, pero no encontró coordenadas válidas para pintar.');
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

  // Enlaza los botones del panel de filtros con sus funciones.
  function vincularPanelFiltros() {
    qs('btnMostrarTodosRegistros')?.addEventListener('click', mostrarTodosLosRegistros);
    qs('btnLimpiarRegistros')?.addEventListener('click', limpiarRegistrosMapa);
  }

  // Inicializa el módulo de datos cuando sigindex.html ya creó el mapa y SIG_STATE.
  function inicializar() {
    const state = window.SIG_STATE;
    if (!state) {
      console.warn('SIG_STATE no existe. Revisa el orden de carga de scripts.');
      return;
    }

    state.supabaseClient = crearClienteSupabaseSIG();
    if (!state.capaCasos && state.mapa) {
      state.capaCasos = L.layerGroup().addTo(state.mapa);
    }

    actualizarEstadisticasFiltros({ casos: 0, puntos: 0 });
    vincularPanelFiltros();
  }

  // Se expone una API global pequeña para que sigindex.html pueda inicializar filtros.
  window.SIG_DATOS = {
    inicializar,
    mostrarTodosLosRegistros,
    limpiarRegistrosMapa,
    pintarRegistrosEnMapa
  };
})();
