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
    macroactor: null,
    poblacional: null
  };


  // Cache local rápida. Evita depender de RPC lentas para cargar filtros y pintar mapa.
  // Se alimenta desde tablas ligeras creadas por el SQL 10.
  const DEPARTAMENTOS_COLOMBIA = [
    'Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bogotá, D.C.', 'Bolívar', 'Boyacá', 'Caldas',
    'Caquetá', 'Casanare', 'Cauca', 'Cesar', 'Chocó', 'Córdoba', 'Cundinamarca', 'Guainía',
    'Guaviare', 'Huila', 'La Guajira', 'Magdalena', 'Meta', 'Nariño', 'Norte de Santander',
    'Putumayo', 'Quindío', 'Risaralda', 'San Andrés, Providencia y Santa Catalina', 'Santander',
    'Sucre', 'Tolima', 'Valle del Cauca', 'Vaupés', 'Vichada'
  ];

  const MACROREGIONES_BASE = ['Amazonía', 'Andina', 'Caribe', 'Orinoquía', 'Pacífico', 'Insular'];

  // Opciones locales para no depender de una consulta Supabase al abrir el SIG.
  // Las listas abiertas (pueblo, macrotipo, macroactor) se pueden escribir manualmente
  // y se enriquecen con resultados después de una consulta exitosa.
  const MACROTIPOS_BASE = [
    'Amenaza', 'Desplazamiento', 'Confinamiento', 'Homicidio', 'Reclutamiento',
    'Riesgo', 'Hostigamiento', 'Atentado', 'Desaparición', 'Restricción a la movilidad'
  ];


  const COLUMNAS_PUBLICAS_SIG = [
    'caso_id', 'fecha_evento', 'anio', 'macrotipo', 'subtipos_texto', 'departamento', 'macroregion',
    'pueblo_texto', 'npersonas', 'nmujeres', 'nhombres', 'nmenores', 'macroactor', 'microactores_texto'
  ].join(',');

  const COLUMNAS_AVANZADAS_SIG = [
    COLUMNAS_PUBLICAS_SIG,
    'detalle', 'detalle_lugar', 'contextual_type', 'contextual_info', 'fuente', 'fechafuente',
    'enlace', 'personas_texto', 'medidas_texto', 'texto_busqueda'
  ].join(',');

  const COLUMNAS_PUNTOS_SIG = [
    'caso_id', 'municipio', 'departamento', 'macroregion', 'lat', 'lng'
  ].join(',');

  // Atajo local para obtener elementos del DOM por id.
  function qs(id) {
    return document.getElementById(id);
  }

  // Evita que una consulta quede indefinidamente en estado "Consultando...".
  function conTimeout(promesa, ms, mensaje) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(mensaje || 'La consulta tardó demasiado.')), ms);
    });
    return Promise.race([promesa, timeout]).finally(() => clearTimeout(timer));
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


  // Recorta textos largos para popups y tablas sin perder seguridad visual.
  function recortarTexto(valor, max = 120) {
    const texto = String(valor ?? '').replace(/\s+/g, ' ').trim();
    if (!texto) return '—';
    return texto.length > max ? `${texto.slice(0, max).trim()}…` : texto;
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
            <tr><th class="text-muted pe-2">Personas</th><td>${escapeHtml(formatearNumero(registro.npersonas ?? 0))}</td></tr>
            <tr><th class="text-muted pe-2">Mujeres</th><td>${escapeHtml(formatearNumero(registro.nmujeres ?? 0))}</td></tr>
            <tr><th class="text-muted pe-2">Hombres</th><td>${escapeHtml(formatearNumero(registro.nhombres ?? 0))}</td></tr>
            <tr><th class="text-muted pe-2">Menores</th><td>${escapeHtml(formatearNumero(registro.nmenores ?? 0))}</td></tr>
            ${registro.detalle ? `<tr><th class="text-muted pe-2">Detalle</th><td>${escapeHtml(recortarTexto(registro.detalle, 160))}</td></tr>` : ''}
            ${registro.fuente ? `<tr><th class="text-muted pe-2">Fuente</th><td>${escapeHtml(recortarTexto(registro.fuente, 90))}</td></tr>` : ''}
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
      macroactor: limpiarValor(qs('filtroMacroactorSIG')?.value),
      poblacional: limpiarValor(qs('filtroPoblacionalSIG')?.value)
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
    if (filtros.poblacional) {
      const etiquetasPoblacionales = {
        personas: 'Personas registradas',
        mujeres: 'Mujeres registradas',
        hombres: 'Hombres registrados',
        menores: 'Menores registrados'
      };
      activos.push(`Poblacional: ${etiquetasPoblacionales[filtros.poblacional] || filtros.poblacional}`);
    }

    host.className = activos.length ? 'alert alert-primary-subtle border small mb-3' : 'alert alert-light border small mb-3';
    host.innerHTML = activos.length
      ? `<div class="fw-semibold mb-1"><i class="bi bi-check2-circle me-1"></i>Filtros aplicados</div><div>${activos.map(escapeHtml).join(' · ')}</div>`
      : '<div class="fw-semibold mb-1"><i class="bi bi-info-circle me-1"></i>Sin filtros aplicados</div><div class="text-muted">El mapa no consulta automáticamente. Usa “Mostrar todos” o “Aplicar filtros” para cargar resultados.</div>';
  }

  // Formatea números para que los resultados del panel sean más legibles.
  function formatearNumero(valor) {
    const numero = Number(valor || 0);
    return Number.isFinite(numero) ? numero.toLocaleString('es-CO') : '0';
  }

  // Lee un valor numérico de forma segura. Si viene vacío o nulo, retorna 0.
  function numeroSeguro(valor) {
    const numero = Number(valor ?? 0);
    return Number.isFinite(numero) ? numero : 0;
  }

  // Calcula dos lecturas separadas del filtro:
  // 1) conteo de casos/registros; 2) sumatoria de personas reportadas.
  // Un caso puede incluir una o muchas personas, por eso mujeres/hombres/menores
  // pueden ser mayores que el número de casos del filtro.
  function calcularTotalesPoblacion(registros = []) {
    const casosUnicos = new Map();

    (registros || []).forEach(registro => {
      const llave = String(registro?.caso_id || registro?.id || '').trim();
      if (!llave || casosUnicos.has(llave)) return;
      casosUnicos.set(llave, registro);
    });

    let personasReportadas = 0;
    let mujeresReportadas = 0;
    let hombresReportados = 0;
    let menoresReportados = 0;

    let casosConPersonas = 0;
    let casosConMujeres = 0;
    let casosConHombres = 0;
    let casosConMenores = 0;
    let casosConDesagregacionSexo = 0;
    let casosConInconsistenciaSexo = 0;

    casosUnicos.forEach(registro => {
      const p = numeroSeguro(registro.npersonas);
      const m = numeroSeguro(registro.nmujeres);
      const h = numeroSeguro(registro.nhombres);
      const n = numeroSeguro(registro.nmenores);

      personasReportadas += p;
      mujeresReportadas += m;
      hombresReportados += h;
      menoresReportados += n;

      if (p > 0) casosConPersonas += 1;
      if (m > 0) casosConMujeres += 1;
      if (h > 0) casosConHombres += 1;
      if (n > 0) casosConMenores += 1;
      if (m > 0 || h > 0) casosConDesagregacionSexo += 1;
      if (p > 0 && (m + h) > p) casosConInconsistenciaSexo += 1;
    });

    const totalRegistros = casosUnicos.size;
    const casosSinDatoSexo = Math.max(0, totalRegistros - casosConDesagregacionSexo);
    const personasSinDatoSexo = Math.max(0, personasReportadas - mujeresReportadas - hombresReportados);

    return {
      registros: totalRegistros,
      personas: personasReportadas,
      mujeres: mujeresReportadas,
      hombres: hombresReportados,
      menores: menoresReportados,
      sinDesagregarSexo: personasSinDatoSexo,
      porcentajeMujeres: porcentajeSeguro(mujeresReportadas, personasReportadas),
      porcentajeHombres: porcentajeSeguro(hombresReportados, personasReportadas),
      porcentajeMenores: porcentajeSeguro(menoresReportados, personasReportadas),
      casosConPersonas,
      casosConMujeres,
      casosConHombres,
      casosConMenores,
      casosConDesagregacionSexo,
      casosSinDatoSexo,
      casosConInconsistenciaSexo,
      personasReportadas,
      mujeresReportadas,
      hombresReportados,
      menoresReportados,
      personasSinDatoSexo
    };
  }

  function obtenerCategoriaPoblacionalActiva() {
    const valorPanel = limpiarValor(qs('filtroPoblacionalSIG')?.value);
    const valorEstado = filtrosActivos?.poblacional;
    return normTxt(valorPanel || valorEstado || '');
  }

  function valorCategoriaPoblacional(totales = {}, categoria = null) {
    const cat = normTxt(categoria || obtenerCategoriaPoblacionalActiva());
    if (cat === 'mujeres') return { valor: totales.mujeres || 0, etiqueta: 'Mujeres reportadas' };
    if (cat === 'hombres') return { valor: totales.hombres || 0, etiqueta: 'Hombres reportados' };
    if (cat === 'menores') return { valor: totales.menores || 0, etiqueta: 'Menores reportados' };
    if (cat === 'personas') return { valor: totales.personas || 0, etiqueta: 'Personas reportadas' };
    return { valor: totales.personas || 0, etiqueta: 'Personas reportadas' };
  }

  function actualizarNotaPoblacion({
    registros = 0,
    personas = 0,
    mujeres = 0,
    hombres = 0,
    menores = 0,
    sinDesagregarSexo = 0,
    porcentajeMujeres = 0,
    porcentajeHombres = 0,
    porcentajeMenores = 0,
    casosConInconsistenciaSexo = 0
  } = {}) {
    const host = qs('statPoblacionNota');
    if (!host) return;

    if (!registros) {
      host.className = 'population-note mb-2';
      host.textContent = 'Este bloque suma personas/víctimas reportadas en los casos filtrados. Un caso puede incluir una o varias personas.';
      return;
    }

    const partes = [];
    partes.push(`${formatearNumero(registros)} casos en el filtro suman ${formatearNumero(personas)} personas reportadas.`);
    partes.push(`Mujeres: ${formatearNumero(porcentajeMujeres)}%; hombres: ${formatearNumero(porcentajeHombres)}%; menores: ${formatearNumero(porcentajeMenores)}%.`);
    partes.push(`Personas sin dato de sexo: ${formatearNumero(sinDesagregarSexo)}.`);
    partes.push('Menores es una categoría etaria, por eso no se suma directamente con mujeres y hombres.');

    if (casosConInconsistenciaSexo > 0) {
      partes.push(`Revisar calidad del dato: ${formatearNumero(casosConInconsistenciaSexo)} casos tienen mujeres+hombres mayor que personas reportadas.`);
      host.className = 'population-note mb-2 text-warning';
    } else {
      host.className = 'population-note mb-2';
    }

    host.textContent = partes.join(' ');
  }

  // Actualiza los contadores visibles del panel de filtros.
  function actualizarEstadisticasFiltros({
    registros = 0,
    casosConCoordenadas = 0,
    puntos = 0,
    personas = 0,
    mujeres = 0,
    hombres = 0,
    menores = 0,
    sinDesagregarSexo = 0,
    porcentajeMujeres = 0,
    porcentajeHombres = 0,
    porcentajeMenores = 0,
    casosConMujeres = 0,
    casosConHombres = 0,
    casosConMenores = 0,
    casosConPersonas = 0,
    casosSinDatoSexo = 0,
    casosConInconsistenciaSexo = 0
  } = {}) {
    const casosSinCoordenadas = Math.max(0, numeroSeguro(registros) - numeroSeguro(casosConCoordenadas));

    const statRegistros = qs('statRegistros');
    const statCasosCoord = qs('statCasosCoord');
    const statCasosSinCoord = qs('statCasosSinCoord');
    const statPuntos = qs('statPuntos');
    const statPersonas = qs('statPersonas');
    const statMujeres = qs('statMujeres');
    const statHombres = qs('statHombres');
    const statMenores = qs('statMenores');
    const statSinDesagregar = qs('statSinDesagregarSexo');
    const statCasosConPersonas = qs('statCasosConPersonas');
    const statCasosConMujeres = qs('statCasosConMujeres');
    const statCasosConHombres = qs('statCasosConHombres');
    const statCasosConMenores = qs('statCasosConMenores');
    const statCasosSinDatoSexo = qs('statCasosSinDatoSexo');

    if (statRegistros) statRegistros.textContent = formatearNumero(registros);
    if (statCasosCoord) statCasosCoord.textContent = formatearNumero(casosConCoordenadas);
    if (statCasosSinCoord) statCasosSinCoord.textContent = formatearNumero(casosSinCoordenadas);
    if (statPuntos) statPuntos.textContent = formatearNumero(puntos);

    if (statPersonas) statPersonas.textContent = formatearNumero(personas);
    if (statMujeres) statMujeres.textContent = formatearNumero(mujeres);
    if (statHombres) statHombres.textContent = formatearNumero(hombres);
    if (statMenores) statMenores.textContent = formatearNumero(menores);
    if (statSinDesagregar) statSinDesagregar.textContent = formatearNumero(sinDesagregarSexo);

    if (statCasosConPersonas) statCasosConPersonas.textContent = formatearNumero(casosConPersonas);
    if (statCasosConMujeres) statCasosConMujeres.textContent = formatearNumero(casosConMujeres);
    if (statCasosConHombres) statCasosConHombres.textContent = formatearNumero(casosConHombres);
    if (statCasosConMenores) statCasosConMenores.textContent = formatearNumero(casosConMenores);
    if (statCasosSinDatoSexo) statCasosSinDatoSexo.textContent = formatearNumero(casosSinDatoSexo);

    ['cardStatPersonas', 'cardStatMujeres', 'cardStatHombres', 'cardStatMenores', 'cardStatSinDesagregar'].forEach(id => qs(id)?.classList.remove('stat-focus'));
    const cat = obtenerCategoriaPoblacionalActiva();
    const foco = {
      personas: 'cardStatPersonas',
      mujeres: 'cardStatMujeres',
      hombres: 'cardStatHombres',
      menores: 'cardStatMenores'
    }[cat] || 'cardStatPersonas';
    if (foco) qs(foco)?.classList.add('stat-focus');

    ['cardStatPersonas', 'cardStatMujeres', 'cardStatHombres', 'cardStatMenores', 'cardStatSinDesagregar'].forEach(id => qs(id)?.classList.toggle('stat-warning', casosConInconsistenciaSexo > 0));

    actualizarNotaPoblacion({
      registros,
      personas,
      mujeres,
      hombres,
      menores,
      sinDesagregarSexo,
      porcentajeMujeres,
      porcentajeHombres,
      porcentajeMenores,
      casosConInconsistenciaSexo
    });
  }


  // ========================
  // Mapa de calor departamental
  // ========================

  const estadoMapaCalorDepto = {
    activo: false,
    metrica: 'casos',
    stats: new Map(),
    max: 0,
    departamentosConDato: 0
  };

  function obtenerNombreDepartamentoFeature(feature) {
    const props = feature?.properties || {};
    const propiedadConfig = window.SIG_CONFIG?.mapaCalorDepartamentos?.propiedadNombre || 'DPTO_CNMBR';
    return String(
      props[propiedadConfig]
      || props.DPTO_CNMBR
      || props.DEPARTAMEN
      || props.DEPTO
      || props.NOMBRE_DPT
      || props.NOMBRE
      || props.nombre
      || ''
    ).trim();
  }

  function obtenerCodigoDepartamentoFeature(feature) {
    const props = feature?.properties || {};
    return String(props.DPTO_CCDGO || props.COD_DEPTO || props.CODIGO || props.codigo || '').trim();
  }

  function obtenerConfiguracionCalorDepto() {
    return window.SIG_CONFIG?.mapaCalorDepartamentos || {
      colorSinDato: '#f8fafc',
      colorBorde: '#334155',
      opacidad: 0.78,
      grosorLinea: 1.2,
      colores: ['#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0284c7', '#075985']
    };
  }

  function extraerDepartamentosRegistro(registro) {
    const departamentos = new Map();
    const agregar = valor => {
      const texto = String(valor ?? '').trim();
      if (!texto) return;
      departamentos.set(normTxt(texto), texto);
    };

    if (Array.isArray(registro?.departamentos)) {
      registro.departamentos.forEach(agregar);
    }

    agregar(registro?.departamento);

    normalizarArregloJsonb(registro?.lugares).forEach(lugar => {
      agregar(lugar?.departamento);
    });

    return Array.from(departamentos.entries()).map(([key, nombre]) => ({ key, nombre }));
  }


  function incrementarConteo(mapa, valor) {
    const texto = String(valor ?? '').trim();
    if (!texto || texto === '—') return;
    const key = normTxt(texto);
    if (!key) return;
    if (!mapa.has(key)) mapa.set(key, { nombre: texto, total: 0 });
    mapa.get(key).total += 1;
  }

  function topConteos(mapa, limite = 5) {
    return Array.from((mapa || new Map()).values())
      .sort((a, b) => (b.total || 0) - (a.total || 0) || String(a.nombre).localeCompare(String(b.nombre), 'es'))
      .slice(0, limite);
  }

  function textoTopConteos(mapa, limite = 5) {
    const top = topConteos(mapa, limite);
    if (!top.length) return '—';
    return top.map(item => `${escapeHtml(item.nombre)} <span class="text-muted">(${formatearNumero(item.total)})</span>`).join(', ');
  }

  function porcentajeSeguro(parte, total) {
    const p = numeroSeguro(parte);
    const t = numeroSeguro(total);
    if (!t || t <= 0) return 0;
    return Math.round((p / t) * 1000) / 10;
  }

  function etiquetaRangoAnios(anios) {
    const lista = Array.from(anios || [])
      .map(v => Number(v))
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    if (!lista.length) return '—';
    if (lista.length === 1) return String(lista[0]);
    return `${lista[0]}-${lista[lista.length - 1]}`;
  }

  function obtenerAnioRegistro(registro) {
    const anioDirecto = Number(registro?.anio);
    if (Number.isFinite(anioDirecto) && anioDirecto > 0) return anioDirecto;
    const fecha = String(registro?.fecha_evento || '').slice(0, 4);
    const anioFecha = Number(fecha);
    return Number.isFinite(anioFecha) && anioFecha > 0 ? anioFecha : null;
  }

  function calcularEstadisticasDepartamentales(registros = []) {
    const stats = new Map();
    const vistos = new Set();

    (registros || []).forEach((registro, indice) => {
      const casoId = String(registro?.caso_id || registro?.id || `sin-id-${indice}`);
      const departamentos = extraerDepartamentosRegistro(registro);
      const lugares = normalizarArregloJsonb(registro?.lugares);
      const anio = obtenerAnioRegistro(registro);

      departamentos.forEach(({ key, nombre }) => {
        if (!key) return;
        const llaveCasoDepto = `${casoId}::${key}`;
        if (vistos.has(llaveCasoDepto)) return;
        vistos.add(llaveCasoDepto);

        if (!stats.has(key)) {
          stats.set(key, {
            nombre,
            casos: 0,
            personas: 0,
            mujeres: 0,
            hombres: 0,
            menores: 0,
            municipios: new Map(),
            macrotipos: new Map(),
            pueblos: new Map(),
            macroactores: new Map(),
            anios: new Set()
          });
        }

        const item = stats.get(key);
        item.casos += 1;
        item.personas += numeroSeguro(registro.npersonas);
        item.mujeres += numeroSeguro(registro.nmujeres);
        item.hombres += numeroSeguro(registro.nhombres);
        item.menores += numeroSeguro(registro.nmenores);

        if (anio) item.anios.add(anio);
        incrementarConteo(item.macrotipos, registro.macrotipo);
        incrementarConteo(item.macroactores, registro.macroactor);
        extraerValoresPueblo(registro).forEach(pueblo => incrementarConteo(item.pueblos, pueblo));

        lugares.forEach(lugar => {
          const deptoLugar = normTxt(lugar?.departamento);
          if (deptoLugar && deptoLugar === key) incrementarConteo(item.municipios, lugar?.municipio);
        });
      });
    });

    return stats;
  }

  function valorMetricaDepartamento(item, metrica) {
    if (!item) return 0;
    return metrica === 'personas' ? numeroSeguro(item.personas) : numeroSeguro(item.casos);
  }

  function colorCalorPorValor(valor, maximo) {
    const cfg = obtenerConfiguracionCalorDepto();
    const colores = Array.isArray(cfg.colores) && cfg.colores.length ? cfg.colores : ['#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0284c7', '#075985'];
    if (!valor || !maximo || maximo <= 0) return cfg.colorSinDato || '#f8fafc';
    const indice = Math.min(colores.length - 1, Math.max(0, Math.ceil((valor / maximo) * colores.length) - 1));
    return colores[indice];
  }

  function construirEstiloBaseDepartamento(capaConfig) {
    return {
      pane: capaConfig?.pane || 'pane3',
      color: capaConfig?.colorLinea || '#1f77b4',
      weight: Number(capaConfig?.grosorLinea ?? 1),
      opacity: Number(capaConfig?.opacidad ?? 0.3),
      fillColor: capaConfig?.colorCapa || '#bdd7ee',
      fillOpacity: Number(capaConfig?.opacidad ?? 0.3),
      lineCap: 'round',
      lineJoin: 'round'
    };
  }

  function obtenerEstiloDepartamentoCalor(feature, capaConfig, estiloBase = null) {
    if (capaConfig?.id !== 'departamentos' || !estadoMapaCalorDepto.activo) return null;

    const cfg = obtenerConfiguracionCalorDepto();
    const nombre = obtenerNombreDepartamentoFeature(feature);
    const item = estadoMapaCalorDepto.stats.get(normTxt(nombre));
    const valor = valorMetricaDepartamento(item, estadoMapaCalorDepto.metrica);
    const base = estiloBase || construirEstiloBaseDepartamento(capaConfig);

    return {
      ...base,
      fillColor: colorCalorPorValor(valor, estadoMapaCalorDepto.max),
      fillOpacity: valor > 0 ? Number(cfg.opacidad ?? 0.78) : 0.16,
      color: cfg.colorBorde || base.color || '#334155',
      weight: valor > 0 ? Number(cfg.grosorLinea ?? 1.2) : Math.max(0.5, Number(base.weight ?? 1)),
      opacity: 0.9
    };
  }

  function crearPopupDepartamentoCalor(feature, nombreCapa) {
    const nombre = obtenerNombreDepartamentoFeature(feature);
    const esCapaDepartamentos = normTxt(nombreCapa) === 'departamentos' || Boolean(feature?.properties?.DPTO_CNMBR);
    if (!nombre || !esCapaDepartamentos) return null;

    // Si el mapa de calor aún no recalculó estadísticas, las calculamos al vuelo
    // con los casos vigentes del filtro visual o de la consola avanzada.
    const registrosVigentes = window.SIG_STATE?.casosConsultados || [];
    if ((!estadoMapaCalorDepto.stats || !estadoMapaCalorDepto.stats.size) && registrosVigentes.length) {
      estadoMapaCalorDepto.stats = calcularEstadisticasDepartamentales(registrosVigentes);
      estadoMapaCalorDepto.max = Array.from(estadoMapaCalorDepto.stats.values()).reduce((max, item) => Math.max(max, valorMetricaDepartamento(item, estadoMapaCalorDepto.metrica)), 0);
      estadoMapaCalorDepto.departamentosConDato = Array.from(estadoMapaCalorDepto.stats.values()).filter(item => valorMetricaDepartamento(item, estadoMapaCalorDepto.metrica) > 0).length;
    }

    const codigo = obtenerCodigoDepartamentoFeature(feature);
    const item = estadoMapaCalorDepto.stats.get(normTxt(nombre)) || {
      nombre,
      casos: 0,
      personas: 0,
      mujeres: 0,
      hombres: 0,
      menores: 0,
      municipios: new Map(),
      macrotipos: new Map(),
      pueblos: new Map(),
      macroactores: new Map(),
      anios: new Set()
    };
    const metrica = estadoMapaCalorDepto.metrica === 'personas' ? 'personas' : 'casos';
    const valor = valorMetricaDepartamento(item, metrica);
    const pctMujeres = porcentajeSeguro(item.mujeres, item.personas);
    const pctMenores = porcentajeSeguro(item.menores, item.personas);
    const totalMunicipios = (item.municipios instanceof Map) ? item.municipios.size : 0;
    const tieneDatos = numeroSeguro(item.casos) > 0;
    const etiquetaIntensidad = metrica === 'personas' ? 'intensidad por personas' : 'intensidad por casos';

    const detalleHTML = tieneDatos ? `
        <div class="border rounded-3 p-2 mb-2 bg-light">
          <div class="fw-semibold small mb-1">Lectura territorial del filtro actual</div>
          <div class="small"><strong>Años:</strong> ${escapeHtml(etiquetaRangoAnios(item.anios))}</div>
          <div class="small"><strong>Municipios con registros:</strong> ${escapeHtml(formatearNumero(totalMunicipios))}</div>
          <div class="small"><strong>Municipios principales:</strong> ${textoTopConteos(item.municipios, 5)}</div>
        </div>
        <div class="small mb-1"><strong>Macrotipos principales:</strong> ${textoTopConteos(item.macrotipos, 4)}</div>
        <div class="small mb-1"><strong>Pueblos registrados:</strong> ${textoTopConteos(item.pueblos, 5)}</div>
        <div class="small mb-2"><strong>Macroactores:</strong> ${textoTopConteos(item.macroactores, 4)}</div>
      ` : `
        <div class="alert alert-light border py-2 small mb-2">
          Este departamento no tiene registros dentro del filtro o comando vigente.
        </div>
      `;

    return `
      <div class="sig-popup-departamento" style="min-width:310px;max-width:410px">
        <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
          <div>
            <div class="fw-bold fs-6">${escapeHtml(nombre)}</div>
            <div class="small text-muted">${codigo ? `Código DANE: ${escapeHtml(codigo)} · ` : ''}Mapa de calor departamental</div>
            <div class="small text-muted">${escapeHtml(etiquetaIntensidad)}</div>
          </div>
          <span class="badge text-bg-primary">${escapeHtml(formatearNumero(valor))}</span>
        </div>

        <div class="row g-1 mb-2 text-center">
          <div class="col-6"><div class="border rounded p-1"><div class="small text-muted">Casos</div><div class="fw-bold">${escapeHtml(formatearNumero(item.casos || 0))}</div></div></div>
          <div class="col-6"><div class="border rounded p-1"><div class="small text-muted">Personas</div><div class="fw-bold">${escapeHtml(formatearNumero(item.personas || 0))}</div></div></div>
          <div class="col-4"><div class="border rounded p-1"><div class="small text-muted">Mujeres</div><div class="fw-semibold">${escapeHtml(formatearNumero(item.mujeres || 0))}</div></div></div>
          <div class="col-4"><div class="border rounded p-1"><div class="small text-muted">Hombres</div><div class="fw-semibold">${escapeHtml(formatearNumero(item.hombres || 0))}</div></div></div>
          <div class="col-4"><div class="border rounded p-1"><div class="small text-muted">Menores</div><div class="fw-semibold">${escapeHtml(formatearNumero(item.menores || 0))}</div></div></div>
        </div>

        ${tieneDatos ? `
          <div class="d-flex gap-2 flex-wrap mb-2 small">
            <span class="badge rounded-pill text-bg-light border">Mujeres: ${escapeHtml(formatearNumero(pctMujeres))}%</span>
            <span class="badge rounded-pill text-bg-light border">Menores: ${escapeHtml(formatearNumero(pctMenores))}%</span>
          </div>` : ''}

        ${detalleHTML}

        <div class="small text-muted border-top pt-2">
          Cruce por <code>DPTO_CNMBR</code>. Los casos multidepartamentales se cuentan una vez por departamento. Los datos corresponden al filtro visual o comando de consola vigente.
        </div>
      </div>`;
  }

  function actualizarLeyendaMapaCalor(maximo, metrica) {
    const host = qs('heatDeptLeyendaSIG');
    if (!host) return;
    const cfg = obtenerConfiguracionCalorDepto();
    const colores = Array.isArray(cfg.colores) && cfg.colores.length ? cfg.colores : [];
    if (!estadoMapaCalorDepto.activo || !colores.length || !maximo) {
      host.classList.add('d-none');
      host.innerHTML = '';
      return;
    }

    host.classList.remove('d-none');
    host.innerHTML = colores.map((color, i) => {
      const desde = i === 0 ? 1 : Math.floor((maximo * i) / colores.length) + 1;
      const hasta = Math.max(desde, Math.ceil((maximo * (i + 1)) / colores.length));
      const etiqueta = i === colores.length - 1 ? `${formatearNumero(desde)}+` : `${formatearNumero(desde)}-${formatearNumero(hasta)}`;
      return `<div class="heat-legend-item" style="background:${escapeHtml(color)}" title="${escapeHtml(metrica)} ${escapeHtml(etiqueta)}">${escapeHtml(etiqueta)}</div>`;
    }).join('');
  }

  function actualizarEstadoMapaCalor({ metrica = estadoMapaCalorDepto.metrica, departamentos = 0, maximo = 0 } = {}) {
    const host = qs('heatDeptEstadoSIG');
    if (!host) return;

    if (!estadoMapaCalorDepto.activo) {
      host.textContent = 'Mapa de calor inactivo. Ejecuta un filtro o comando y luego aplica la intensidad departamental.';
      actualizarLeyendaMapaCalor(0, metrica);
      return;
    }

    const etiqueta = metrica === 'personas' ? 'personas' : 'casos';
    host.innerHTML = `Activo por <strong>${escapeHtml(etiqueta)}</strong>. Departamentos con dato: <strong>${formatearNumero(departamentos)}</strong>. Máximo: <strong>${formatearNumero(maximo)}</strong>.`;
    actualizarLeyendaMapaCalor(maximo, etiqueta);
  }

  function aplicarEstiloMapaCalorDepartamentos() {
    const state = window.SIG_STATE;
    const capa = state?.capasPorId?.get('departamentos');
    const capaConfig = window.SIG_CONFIG?.capas?.find(c => c.id === 'departamentos');
    if (!capa || !capaConfig) return false;

    capa.eachLayer(layer => {
      if (!layer?.setStyle) return;
      const estilo = estadoMapaCalorDepto.activo
        ? obtenerEstiloDepartamentoCalor(layer.feature, capaConfig, construirEstiloBaseDepartamento(capaConfig))
        : construirEstiloBaseDepartamento(capaConfig);
      layer.setStyle(estilo);
    });
    return true;
  }

  function refrescarMapaCalorDepartamentos(opciones = {}) {
    const state = window.SIG_STATE;
    if (!state) return false;

    if (estadoMapaCalorDepto.activo) {
      const stats = calcularEstadisticasDepartamentales(state.casosConsultados || []);
      estadoMapaCalorDepto.stats = stats;
      estadoMapaCalorDepto.max = Array.from(stats.values()).reduce((max, item) => Math.max(max, valorMetricaDepartamento(item, estadoMapaCalorDepto.metrica)), 0);
      estadoMapaCalorDepto.departamentosConDato = Array.from(stats.values()).filter(item => valorMetricaDepartamento(item, estadoMapaCalorDepto.metrica) > 0).length;
    }

    const aplicado = aplicarEstiloMapaCalorDepartamentos();
    if (!opciones.silencioso) {
      actualizarEstadoMapaCalor({
        metrica: estadoMapaCalorDepto.metrica,
        departamentos: estadoMapaCalorDepto.departamentosConDato,
        maximo: estadoMapaCalorDepto.max
      });
    }
    return aplicado;
  }

  async function asegurarCapaDepartamentosActiva() {
    const state = window.SIG_STATE;
    if (state?.capasPorId?.has('departamentos')) return true;
    if (window.SIG_CAPAS?.activarCapaPorId) {
      await window.SIG_CAPAS.activarCapaPorId('departamentos');
      return Boolean(state?.capasPorId?.has('departamentos'));
    }
    return false;
  }

  async function aplicarMapaCalorDepartamentos(opciones = {}) {
    const state = window.SIG_STATE;
    const registros = state?.casosConsultados || [];
    const metrica = opciones.metrica || qs('heatDeptMetricaSIG')?.value || 'casos';

    estadoMapaCalorDepto.activo = true;
    estadoMapaCalorDepto.metrica = metrica === 'personas' ? 'personas' : 'casos';
    if (qs('heatDeptMetricaSIG')) qs('heatDeptMetricaSIG').value = estadoMapaCalorDepto.metrica;

    await asegurarCapaDepartamentosActiva();
    refrescarMapaCalorDepartamentos({ silencioso: true });
    actualizarEstadoMapaCalor({
      metrica: estadoMapaCalorDepto.metrica,
      departamentos: estadoMapaCalorDepto.departamentosConDato,
      maximo: estadoMapaCalorDepto.max
    });

    if (!registros.length && !opciones.silencioso) {
      mostrarAvisoFiltros('warning', 'No hay registros vigentes para construir el mapa de calor. Ejecuta primero un filtro, “Mostrar todos” o una consulta de consola.');
    } else if (!opciones.silencioso) {
      mostrarAvisoFiltros('info', `Mapa de calor departamental aplicado por ${estadoMapaCalorDepto.metrica === 'personas' ? 'personas' : 'casos'}.`);
    }
  }

  function limpiarMapaCalorDepartamentos() {
    estadoMapaCalorDepto.activo = false;
    estadoMapaCalorDepto.stats = new Map();
    estadoMapaCalorDepto.max = 0;
    estadoMapaCalorDepto.departamentosConDato = 0;
    aplicarEstiloMapaCalorDepartamentos();
    actualizarEstadoMapaCalor();
    mostrarAvisoFiltros('secondary', 'Mapa de calor departamental limpiado. La capa Departamentos conserva su estilo base.');
  }

  // Limpia la capa de puntos del mapa, pero no borra la configuración de filtros del panel.
  function limpiarRegistrosMapa() {
    const state = window.SIG_STATE;
    if (!state) return;

    if (state.capaCasos) state.capaCasos.clearLayers();
    state.casosConsultados = [];
    if (estadoMapaCalorDepto.activo) refrescarMapaCalorDepartamentos({ silencioso: false });
    actualizarEstadisticasFiltros({
      registros: 0,
      casosConCoordenadas: 0,
      puntos: 0,
      personas: 0,
      mujeres: 0,
      hombres: 0,
      menores: 0
    });
    actualizarEstadoMapaCalor();
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


  // Consulta tablas ligeras en páginas. El SQL 10 usa tablas físicas livianas, no vistas pesadas ni RPC.
  async function consultarTablaPaginada(nombreTabla, columnas, opciones = {}) {
    const state = window.SIG_STATE;
    const cliente = state?.supabaseClient;
    if (!cliente) throw new Error('No hay cliente Supabase disponible.');

    const cfg = window.SIG_CONFIG?.supabase || {};
    const tamano = Number(opciones.tamanoPagina || cfg.tamanoPagina || 500);
    const maxPaginas = Number(opciones.maxPaginas || cfg.maxPaginas || 20);
    const timeoutMs = Number(opciones.timeoutMs || cfg.timeoutConsultaMs || 20000);
    const acumulado = [];
    let desde = 0;
    let pagina = 0;

    while (pagina < maxPaginas) {
      const hasta = desde + tamano - 1;
      actualizarEstado(`Consultando ${nombreTabla} ${desde + 1}-${hasta + 1}...`);

      let consulta = cliente.from(nombreTabla).select(columnas);
      if (typeof opciones.aplicarConsulta === 'function') consulta = opciones.aplicarConsulta(consulta);
      if (opciones.ordenFecha !== false) consulta = consulta.order('fecha_evento', { ascending: false, nullsFirst: false });
      consulta = consulta.range(desde, hasta);

      const respuesta = await conTimeout(
        consulta,
        timeoutMs,
        `La consulta a la tabla ${nombreTabla} superó ${Math.round(timeoutMs / 1000)} segundos.`
      );

      const { data, error } = respuesta || {};
      if (error) throw error;

      const lote = Array.isArray(data) ? data : [];
      acumulado.push(...lote);
      if (lote.length < tamano) break;

      pagina += 1;
      desde += tamano;
    }

    return acumulado;
  }

  function aplicarFiltrosPanelEnConsulta(consulta, filtros = {}) {
    if (filtros.anio) consulta = consulta.eq('anio', Number(filtros.anio));
    if (filtros.departamento) consulta = consulta.eq('departamento', filtros.departamento);
    if (filtros.macrotipo) consulta = consulta.eq('macrotipo', filtros.macrotipo);
    if (filtros.macroregion) consulta = consulta.eq('macroregion', filtros.macroregion);
    if (filtros.macroactor) consulta = consulta.eq('macroactor', filtros.macroactor);
    if (filtros.pueblo) consulta = consulta.ilike('pueblo_texto', `%${filtros.pueblo}%`);

    const poblacional = normTxt(filtros.poblacional);
    if (poblacional === 'personas') consulta = consulta.gt('npersonas', 0);
    if (poblacional === 'mujeres') consulta = consulta.gt('nmujeres', 0);
    if (poblacional === 'hombres') consulta = consulta.gt('nhombres', 0);
    if (poblacional === 'menores') consulta = consulta.gt('nmenores', 0);
    return consulta;
  }

  async function obtenerIdsCasosPorMunicipio(municipio) {
    const texto = String(municipio || '').trim();
    if (!texto) return null;
    const tabla = window.SIG_CONFIG?.supabase?.tablaPuntosLite || 'sig_puntos_lite_2026';
    const puntos = await consultarTablaPaginada(tabla, 'caso_id,municipio', {
      ordenFecha: false,
      tamanoPagina: 1000,
      aplicarConsulta: q => q.ilike('municipio', `%${texto}%`)
    });
    return Array.from(new Set((puntos || []).map(p => p.caso_id).filter(Boolean)));
  }

  function aplicarParametrosConsolaEnConsulta(consulta, parametros = {}, idsMunicipio = null) {
    const p = normalizarParametrosRpc(parametros);
    if (p.p_anio !== null) consulta = consulta.eq('anio', Number(p.p_anio));
    if (p.p_anio_inicio !== null) consulta = consulta.gte('anio', Number(p.p_anio_inicio));
    if (p.p_anio_fin !== null) consulta = consulta.lte('anio', Number(p.p_anio_fin));
    if (p.p_departamento) consulta = consulta.eq('departamento', p.p_departamento);
    if (p.p_pueblo) consulta = consulta.ilike('pueblo_texto', `%${p.p_pueblo}%`);
    if (p.p_macrotipo) consulta = consulta.eq('macrotipo', p.p_macrotipo);
    if (p.p_macroregion) consulta = consulta.eq('macroregion', p.p_macroregion);
    if (p.p_macroactor) consulta = consulta.eq('macroactor', p.p_macroactor);
    if (p.p_texto) consulta = consulta.ilike('texto_busqueda', `%${p.p_texto}%`);
    if (Array.isArray(idsMunicipio)) consulta = idsMunicipio.length ? consulta.in('caso_id', idsMunicipio) : consulta.eq('caso_id', '00000000-0000-0000-0000-000000000000');

    const poblacional = normTxt(p.p_poblacional);
    if (poblacional === 'personas') consulta = consulta.gt('npersonas', 0);
    if (poblacional === 'mujeres') consulta = consulta.gt('nmujeres', 0);
    if (poblacional === 'hombres') consulta = consulta.gt('nhombres', 0);
    if (poblacional === 'menores') consulta = consulta.gt('nmenores', 0);

    const rangos = [
      ['personas', 'npersonas'], ['mujeres', 'nmujeres'], ['hombres', 'nhombres'], ['menores', 'nmenores']
    ];
    for (const [campo, columna] of rangos) {
      const min = p[`p_min_${campo}`];
      const max = p[`p_max_${campo}`];
      if (min !== null) consulta = consulta.gte(columna, Number(min));
      if (max !== null) consulta = consulta.lte(columna, Number(max));
    }
    return consulta;
  }

  async function cargarPuntosPorCasos(casoIds = []) {
    const ids = Array.from(new Set((casoIds || []).map(String).filter(Boolean)));
    if (!ids.length) return new Map();

    const tabla = window.SIG_CONFIG?.supabase?.tablaPuntosLite || 'sig_puntos_lite_2026';
    const mapa = new Map();
    const tamanoLote = 450;

    for (let i = 0; i < ids.length; i += tamanoLote) {
      const loteIds = ids.slice(i, i + tamanoLote);
      const puntos = await consultarTablaPaginada(tabla, COLUMNAS_PUNTOS_SIG, {
        ordenFecha: false,
        tamanoPagina: 1000,
        aplicarConsulta: q => q.in('caso_id', loteIds)
      });
      (puntos || []).forEach(punto => {
        const key = String(punto.caso_id);
        if (!mapa.has(key)) mapa.set(key, []);
        mapa.get(key).push({
          municipio: punto.municipio,
          departamento: punto.departamento,
          macroregion: punto.macroregion,
          lat: punto.lat,
          lng: punto.lng
        });
      });
    }

    return mapa;
  }

  async function adjuntarLugaresARegistros(registros = []) {
    const mapaPuntos = await cargarPuntosPorCasos((registros || []).map(r => r.caso_id));
    return (registros || []).map(registro => ({
      ...registro,
      lugares: mapaPuntos.get(String(registro.caso_id)) || []
    }));
  }

  async function consultarCasosPublicosFiltrados(filtros = {}) {
    const tabla = window.SIG_CONFIG?.supabase?.tablaCasosLite || window.SIG_CONFIG?.supabase?.tablaCasosPublica || 'sig_casos_lite_2026';
    const registros = await consultarTablaPaginada(tabla, COLUMNAS_PUBLICAS_SIG, {
      aplicarConsulta: q => aplicarFiltrosPanelEnConsulta(q, filtros)
    });
    return adjuntarLugaresARegistros(registros);
  }

  async function consultarCasosAvanzadosFiltrados(parametros = {}) {
    const p = normalizarParametrosRpc(parametros);
    const idsMunicipio = p.p_municipio ? await obtenerIdsCasosPorMunicipio(p.p_municipio) : null;
    const tabla = window.SIG_CONFIG?.supabase?.tablaCasosDetalle || window.SIG_CONFIG?.supabase?.tablaCasosAvanzada || 'sig_casos_detalle_2026';
    const registros = await consultarTablaPaginada(tabla, COLUMNAS_AVANZADAS_SIG, {
      aplicarConsulta: q => aplicarParametrosConsolaEnConsulta(q, p, idsMunicipio)
    });
    return adjuntarLugaresARegistros(registros);
  }

  async function cargarCachePublicaSIG(opciones = {}) {
    const state = window.SIG_STATE;
    if (!state) throw new Error('SIG_STATE no está disponible.');
    if (!opciones.forzar && Array.isArray(state.cachePublicaSIG)) return state.cachePublicaSIG;
    const registros = await consultarCasosPublicosFiltrados({});
    state.cachePublicaSIG = registros;
    return registros;
  }

  async function cargarCacheAvanzadaSIG(opciones = {}) {
    const state = window.SIG_STATE;
    if (!state) throw new Error('SIG_STATE no está disponible.');
    if (!opciones.forzar && Array.isArray(state.cacheAvanzadaSIG)) return state.cacheAvanzadaSIG;
    const registros = await consultarCasosAvanzadosFiltrados({});
    state.cacheAvanzadaSIG = registros;
    return registros;
  }

  function extraerTextoPueblo(registro) {
    if (registro?.pueblo_texto) return String(registro.pueblo_texto || '');
    const partes = [];
    normalizarArregloJsonb(registro?.pueblo).forEach(item => {
      if (typeof item === 'string') partes.push(item);
      else if (item && typeof item === 'object') partes.push(item.nombre || item.pueblo || item.label || item.name || JSON.stringify(item));
    });
    if (typeof registro?.pueblo === 'string') partes.push(registro.pueblo);
    return partes.filter(Boolean).join(' | ');
  }

  function extraerValoresPueblo(registro) {
    if (registro?.pueblo_texto) {
      return String(registro.pueblo_texto || '').split('|').map(v => v.trim()).filter(Boolean);
    }
    const valores = [];
    normalizarArregloJsonb(registro?.pueblo).forEach(item => {
      if (typeof item === 'string') valores.push(item);
      else if (item && typeof item === 'object') valores.push(item.nombre || item.pueblo || item.label || item.name || '');
    });
    return valores.map(v => String(v || '').trim()).filter(Boolean);
  }

  function extraerMunicipiosRegistro(registro) {
    return normalizarArregloJsonb(registro?.lugares)
      .map(lugar => lugar?.municipio)
      .map(v => String(v || '').trim())
      .filter(Boolean);
  }

  function compararExactoONormalizado(valor, filtro) {
    if (!filtro) return true;
    return normTxt(valor) === normTxt(filtro);
  }

  function compararListaONormalizado(valores, filtro) {
    if (!filtro) return true;
    const nf = normTxt(filtro);
    return (valores || []).some(valor => normTxt(valor) === nf || normTxt(valor).includes(nf));
  }

  function registroCumpleFiltroPanel(registro, filtros = {}) {
    if (filtros.anio && Number(registro.anio || 0) !== Number(filtros.anio)) return false;

    if (filtros.departamento) {
      const departamentos = [registro.departamento, ...(Array.isArray(registro.departamentos) ? registro.departamentos : [])];
      normalizarArregloJsonb(registro.lugares).forEach(lugar => departamentos.push(lugar?.departamento));
      if (!compararListaONormalizado(departamentos, filtros.departamento)) return false;
    }

    if (filtros.pueblo && !compararListaONormalizado(extraerValoresPueblo(registro).concat(extraerTextoPueblo(registro)), filtros.pueblo)) return false;
    if (filtros.macrotipo && !compararExactoONormalizado(registro.macrotipo, filtros.macrotipo)) return false;
    if (filtros.macroregion) {
      const macroregiones = [registro.macroregion, ...(Array.isArray(registro.macroregiones) ? registro.macroregiones : [])];
      normalizarArregloJsonb(registro.lugares).forEach(lugar => macroregiones.push(lugar?.macroregion));
      if (!compararListaONormalizado(macroregiones, filtros.macroregion)) return false;
    }
    if (filtros.macroactor && !compararExactoONormalizado(registro.macroactor, filtros.macroactor)) return false;

    const poblacional = normTxt(filtros.poblacional);
    if (poblacional === 'personas' && numeroSeguro(registro.npersonas) <= 0) return false;
    if (poblacional === 'mujeres' && numeroSeguro(registro.nmujeres) <= 0) return false;
    if (poblacional === 'hombres' && numeroSeguro(registro.nhombres) <= 0) return false;
    if (poblacional === 'menores' && numeroSeguro(registro.nmenores) <= 0) return false;

    return true;
  }

  function registroCumpleParametrosConsola(registro, params = {}) {
    const p = normalizarParametrosRpc(params);
    const anio = Number(registro.anio || 0);

    if (p.p_anio !== null && anio !== Number(p.p_anio)) return false;
    if (p.p_anio_inicio !== null && anio < Number(p.p_anio_inicio)) return false;
    if (p.p_anio_fin !== null && anio > Number(p.p_anio_fin)) return false;

    if (p.p_departamento) {
      const departamentos = [registro.departamento, ...(Array.isArray(registro.departamentos) ? registro.departamentos : [])];
      normalizarArregloJsonb(registro.lugares).forEach(lugar => departamentos.push(lugar?.departamento));
      if (!compararListaONormalizado(departamentos, p.p_departamento)) return false;
    }

    if (p.p_municipio && !compararListaONormalizado(extraerMunicipiosRegistro(registro), p.p_municipio)) return false;
    if (p.p_pueblo && !compararListaONormalizado(extraerValoresPueblo(registro).concat(extraerTextoPueblo(registro)), p.p_pueblo)) return false;
    if (p.p_macrotipo && !compararExactoONormalizado(registro.macrotipo, p.p_macrotipo)) return false;
    if (p.p_macroregion) {
      const macroregiones = [registro.macroregion, ...(Array.isArray(registro.macroregiones) ? registro.macroregiones : [])];
      normalizarArregloJsonb(registro.lugares).forEach(lugar => macroregiones.push(lugar?.macroregion));
      if (!compararListaONormalizado(macroregiones, p.p_macroregion)) return false;
    }
    if (p.p_macroactor && !compararExactoONormalizado(registro.macroactor, p.p_macroactor)) return false;

    const poblacional = normTxt(p.p_poblacional);
    if (poblacional === 'personas' && numeroSeguro(registro.npersonas) <= 0) return false;
    if (poblacional === 'mujeres' && numeroSeguro(registro.nmujeres) <= 0) return false;
    if (poblacional === 'hombres' && numeroSeguro(registro.nhombres) <= 0) return false;
    if (poblacional === 'menores' && numeroSeguro(registro.nmenores) <= 0) return false;

    const rangos = [
      ['personas', 'npersonas'], ['mujeres', 'nmujeres'], ['hombres', 'nhombres'], ['menores', 'nmenores']
    ];
    for (const [campo, prop] of rangos) {
      const valor = numeroSeguro(registro[prop]);
      const min = p[`p_min_${campo}`];
      const max = p[`p_max_${campo}`];
      if (min !== null && valor < Number(min)) return false;
      if (max !== null && valor > Number(max)) return false;
    }

    if (p.p_texto) {
      const texto = normTxt([
        registro.detalle,
        registro.contextual_info,
        registro.detalle_lugar,
        registro.fuente,
        registro.enlace,
        registro.macrotipo,
        registro.macroactor,
        registro.departamento,
        registro.macroregion,
        extraerTextoPueblo(registro),
        extraerMunicipiosRegistro(registro).join(' ')
      ].join(' '));
      if (!texto.includes(normTxt(p.p_texto))) return false;
    }

    return true;
  }

  function construirOpcionesFiltrosDesdeRegistros(registros = []) {
    const opciones = {
      anios: [],
      departamentos: new Set(DEPARTAMENTOS_COLOMBIA),
      pueblos: new Set(),
      macrotipos: new Set(),
      macroregiones: new Set(MACROREGIONES_BASE),
      macroactores: new Set()
    };

    const anioActual = new Date().getFullYear();
    for (let anio = anioActual; anio >= 2016; anio -= 1) opciones.anios.push(String(anio));

    (registros || []).forEach(registro => {
      if (registro.departamento) opciones.departamentos.add(registro.departamento);
      if (registro.macrotipo) opciones.macrotipos.add(registro.macrotipo);
      if (registro.macroregion) opciones.macroregiones.add(registro.macroregion);
      if (registro.macroactor) opciones.macroactores.add(registro.macroactor);
      extraerValoresPueblo(registro).forEach(pueblo => opciones.pueblos.add(pueblo));
      normalizarArregloJsonb(registro.lugares).forEach(lugar => {
        if (lugar?.departamento) opciones.departamentos.add(lugar.departamento);
        if (lugar?.macroregion) opciones.macroregiones.add(lugar.macroregion);
      });
    });

    return {
      anios: opciones.anios,
      departamentos: Array.from(opciones.departamentos),
      pueblos: Array.from(opciones.pueblos),
      macrotipos: Array.from(opciones.macrotipos),
      macroregiones: Array.from(opciones.macroregiones),
      macroactores: Array.from(opciones.macroactores)
    };
  }

  // Consulta una RPC paginada hasta traer todos los registros disponibles.
  async function consultarRpcPaginada(nombreFuncion, parametros = {}, tamanoPagina = null) {
    const state = window.SIG_STATE;
    const cfg = window.SIG_CONFIG;
    const cliente = state?.supabaseClient;
    if (!cliente) throw new Error('No hay conexión Supabase configurada.');

    const tamano = Number(tamanoPagina || cfg?.supabase?.tamanoPagina || 1000);
    const maxPaginas = Number(cfg?.supabase?.maxPaginas || 20);
    const timeoutMs = Number(cfg?.supabase?.timeoutConsultaMs || 30000);
    const acumulado = [];
    let desde = 0;
    let pagina = 0;

    while (pagina < maxPaginas) {
      const hasta = desde + tamano - 1;
      actualizarEstado(`Consultando Supabase ${desde + 1}-${hasta + 1}...`);

      const respuesta = await conTimeout(
        cliente.rpc(nombreFuncion, parametros).range(desde, hasta),
        timeoutMs,
        `La consulta a ${nombreFuncion} superó ${Math.round(timeoutMs / 1000)} segundos. Revisa la función en Supabase o intenta un filtro más específico.`
      );

      const { data, error } = respuesta || {};
      if (error) throw error;

      const lote = Array.isArray(data) ? data : [];
      acumulado.push(...lote);

      if (lote.length < tamano) break;

      pagina += 1;
      desde += tamano;
    }

    if (pagina >= maxPaginas) {
      console.warn(`Consulta detenida al alcanzar ${maxPaginas} páginas. Registros acumulados: ${acumulado.length}`);
      mostrarAvisoFiltros('warning', `La consulta alcanzó el límite de ${maxPaginas} páginas. Se muestran ${formatearNumero(acumulado.length)} registros. Puedes aumentar maxPaginas en configlayers.js si lo necesitas.`);
    }

    return acumulado;
  }

  // Ejecuta la consulta filtrada usando la cache pública local y actualiza mapa, texto y conteos.
  async function consultarYPintarCasosSIG(filtros, opciones = {}) {
    const state = window.SIG_STATE;
    const boton = opciones.boton || null;
    const htmlOriginal = boton ? boton.innerHTML : '';

    try {
      if (boton) {
        boton.disabled = true;
        boton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Consultando...';
      }

      limpiarAvisoFiltros();
      actualizarEstado('Consultando tablas ligeras SIG...');
      mostrarAvisoFiltros('info', 'Aplicando filtros sobre tablas ligeras del SIG...');

      const registros = await consultarCasosPublicosFiltrados(filtros || {});
      state.casosConsultados = registros;
      actualizarOpcionesDesdeRegistros(registros);

      const resumen = pintarRegistrosEnMapa(registros);
      const poblacion = calcularTotalesPoblacion(registros);
      actualizarEstadisticasFiltros({ ...resumen, ...poblacion });
      if (estadoMapaCalorDepto.activo) refrescarMapaCalorDepartamentos({ silencioso: false });
      limpiarAvisoFiltros();

      if (resumen.puntos) {
        actualizarEstado(`${resumen.puntos} puntos en mapa · ${resumen.registros} registros vinculados`);
      } else {
        actualizarEstado(`${resumen.registros} registros vinculados, sin coordenadas para pintar`);
        mostrarAvisoFiltros('warning', 'La consulta encontró registros, pero ninguno tiene coordenadas válidas para el mapa.');
      }
    } catch (error) {
      console.error(error);
      const mensaje = error?.message || 'No fue posible consultar las tablas ligeras del SIG.';
      const ayuda = mensaje.includes('sig_casos_lite_2026') || mensaje.includes('sig_puntos_lite_2026') || mensaje.includes('relation') || mensaje.includes('does not exist') || mensaje.includes('404')
        ? ' Ejecuta el SQL 10 de tablas ligeras SIG y recarga con Ctrl+F5.'
        : '';
      mostrarAvisoFiltros('danger', `${mensaje}${ayuda}`);
      actualizarEstado('Error consultando tablas ligeras SIG');
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.innerHTML = htmlOriginal;
      }
    }
  }

  // Devuelve todos los filtros vacíos en una sola estructura.
  function crearFiltrosVacios() {
    return {
      anio: null,
      departamento: null,
      pueblo: null,
      macrotipo: null,
      macroregion: null,
      macroactor: null,
      poblacional: null
    };
  }

  // Acción directa: mostrar todos los registros equivale a consultar con filtros vacíos.
  async function mostrarTodosLosRegistros() {
    const filtros = crearFiltrosVacios();
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

  // Limpia los controles del panel y deja el mapa sin resultados.
  // Importante: limpiar filtros NO vuelve a consultar todos los registros.
  // Para cargar todo existe el botón independiente “Mostrar todos”.
  async function limpiarFiltrosSIG() {
    [
      'filtroAnioSIG',
      'filtroDepartamentoSIG',
      'filtroPuebloSIG',
      'filtroMacrotipoSIG',
      'filtroMacroregionSIG',
      'filtroMacroactorSIG',
      'filtroPoblacionalSIG'
    ].forEach(id => {
      const el = qs(id);
      if (el) el.value = '';
    });

    const filtros = crearFiltrosVacios();
    guardarFiltrosActivos(filtros);
    actualizarTextoFiltrosActivos(filtros);

    // Borra puntos, conteos y resultados vigentes sin lanzar consulta nueva.
    limpiarRegistrosMapa();

    // También limpia la intensidad departamental para que no queden colores
    // asociados a un filtro anterior.
    if (estadoMapaCalorDepto.activo) {
      limpiarMapaCalorDepartamentos();
    }

    mostrarAvisoFiltros('secondary', 'Filtros limpiados. El mapa quedó sin resultados. Usa “Mostrar todos” o “Aplicar filtros” para consultar de nuevo.');
    actualizarEstado('Filtros limpiados');
  }

  // Carga opciones de filtros locales sin consultar Supabase al iniciar.
  // Esto evita que una tabla bloqueada o una llamada lenta deje el SIG pegado en "Consultando...".
  async function cargarOpcionesFiltros() {
    const anioActual = new Date().getFullYear();
    const aniosFallback = [];
    for (let anio = anioActual; anio >= 2016; anio -= 1) aniosFallback.push(String(anio));

    llenarSelect('filtroAnioSIG', aniosFallback, 'Todos los años');
    llenarSelect('filtroDepartamentoSIG', DEPARTAMENTOS_COLOMBIA, 'Todos los departamentos');
    llenarSelect('filtroMacroregionSIG', MACROREGIONES_BASE, 'Todas las macroregiones');
    llenarDatalist('listaMacrotiposSIG', MACROTIPOS_BASE);
    llenarDatalist('listaPueblosSIG', []);
    llenarDatalist('listaMacroactoresSIG', []);

    actualizarEstado('Filtros locales cargados');
    mostrarAvisoFiltros('info', 'Filtros listos. Puedes escribir pueblo, macrotipo o macroactor manualmente; se autocompletan después de consultar resultados.');
  }

  // Llena un datalist para campos abiertos. No bloquea la escritura manual.
  function llenarDatalist(id, valores) {
    const lista = qs(id);
    if (!lista) return;
    const actuales = Array.from(lista.querySelectorAll('option')).map(opt => opt.value);
    const combinados = Array.from(new Set([...(actuales || []), ...(valores || [])]
      .map(v => String(v ?? '').trim())
      .filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'es'));
    lista.innerHTML = combinados.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
  }

  // Enriquecimiento de datalist con los valores que ya regresaron de una consulta.
  function actualizarOpcionesDesdeRegistros(registros = []) {
    const pueblos = [];
    const macrotipos = [];
    const macroactores = [];

    (registros || []).forEach(registro => {
      if (registro.macrotipo) macrotipos.push(registro.macrotipo);
      if (registro.macroactor) macroactores.push(registro.macroactor);
      String(registro.pueblo_texto || '').split('|').forEach(p => {
        const limpio = p.trim();
        if (limpio) pueblos.push(limpio);
      });
    });

    llenarDatalist('listaPueblosSIG', pueblos);
    llenarDatalist('listaMacrotiposSIG', macrotipos);
    llenarDatalist('listaMacroactoresSIG', macroactores);
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
    qs('btnAplicarMapaCalorDeptSIG')?.addEventListener('click', () => aplicarMapaCalorDepartamentos());
    qs('btnLimpiarMapaCalorDeptSIG')?.addEventListener('click', limpiarMapaCalorDepartamentos);
    qs('heatDeptMetricaSIG')?.addEventListener('change', () => {
      if (estadoMapaCalorDepto.activo) aplicarMapaCalorDepartamentos({ silencioso: true });
    });

    ['sigMarkerRadio', 'sigMarkerColor', 'sigMarkerLinea', 'sigMarkerGrosor', 'sigMarkerOpacidad', 'sigMarkerOpacidadLinea']
      .forEach(id => qs(id)?.addEventListener('input', actualizarEstiloPuntosEnMapa));

    qs('filtroPoblacionalSIG')?.addEventListener('change', () => {
      // No aplica automáticamente para que el usuario pueda terminar de combinar filtros.
      limpiarAvisoFiltros();
    });
  }


  // ========================
  // Consola avanzada SIG
  // ========================

  const historialConsola = [];

  function abrirConsolaAvanzada() {
    const panel = qs('panelConsolaSIG');
    if (!panel) return;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    setTimeout(() => qs('consolaComandoSIG')?.focus(), 80);
    window.SIG_STATE?.mapa?.invalidateSize();
  }

  function cerrarConsolaAvanzada() {
    const panel = qs('panelConsolaSIG');
    if (!panel) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    window.SIG_STATE?.mapa?.invalidateSize();
  }

  function setEstadoConsola(mensaje, tipo = 'secondary') {
    const host = qs('estadoConsolaSIG');
    if (!host) return;
    host.className = `small text-${tipo}`;
    host.textContent = mensaje;
  }

  function mostrarResumenConsola(html) {
    const host = qs('consolaResumenSIG');
    if (!host) return;
    host.innerHTML = html;
  }

  function limpiarAyudaConsola() {
    const host = qs('consolaAyudaSIG');
    if (!host) return;
    host.classList.add('d-none');
    host.innerHTML = '';
  }

  function mostrarAyudaConsola() {
    const host = qs('consolaAyudaSIG');
    if (!host) return;
    host.classList.remove('d-none');
    host.innerHTML = `
      <div class="alert alert-info py-2 mb-2">
        <div class="fw-semibold mb-1">Comandos disponibles</div>
        <div>Usa <code>buscar</code> y combina campos permitidos. La consola no ejecuta SQL libre: traduce el comando y filtra una cache autenticada segura.</div>
      </div>
      <div class="d-flex flex-column gap-1">
        <div><code>buscar año:2024 departamento:Cauca pueblo:Nasa mujeres&gt;0</code></div>
        <div><code>buscar macroregion:Pacífico macrotipo:Desplazamiento menores&gt;10</code></div>
        <div><code>buscar texto:"confinamiento" departamento:Chocó</code></div>
        <div><code>buscar municipio:Caloto personas&gt;100</code></div>
        <div><code>calor casos</code> · <code>calor personas</code> · <code>limpiar calor</code></div>
        <div><code>mostrar todos</code> · <code>limpiar mapa</code> · <code>limpiar</code> · <code>ayuda</code></div>
      </div>`;
    setEstadoConsola('Ayuda de comandos visible.', 'info');
  }

  function actualizarTablaConsola(registros = []) {
    const tbody = qs('consolaTablaSIG');
    const info = qs('consolaTablaInfoSIG');
    if (!tbody) return;

    if (!registros.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-secondary small">Sin resultados.</td></tr>';
      if (info) info.textContent = 'Sin resultados';
      return;
    }

    const limite = 60;
    const filas = registros.slice(0, limite).map(registro => {
      const lugares = normalizarArregloJsonb(registro.lugares);
      const municipios = textoLista(lugares.map(lugar => lugar?.municipio).filter(Boolean), 2);
      return `
        <tr>
          <td>${escapeHtml(registro.fecha_evento || '—')}</td>
          <td>${escapeHtml(registro.departamento || textoLista(registro.departamentos, 1))}</td>
          <td>${escapeHtml(municipios)}</td>
          <td>${escapeHtml(textoLista(registro.pueblo, 2))}</td>
          <td>${escapeHtml(registro.macrotipo || '—')}</td>
          <td>${escapeHtml(formatearNumero(registro.npersonas || 0))}</td>
          <td>${escapeHtml(recortarTexto(registro.detalle || registro.contextual_info || registro.fuente || '—', 120))}</td>
        </tr>`;
    }).join('');

    tbody.innerHTML = filas;
    if (info) info.textContent = registros.length > limite
      ? `Mostrando ${limite} de ${formatearNumero(registros.length)}`
      : `${formatearNumero(registros.length)} registros`;
  }

  async function obtenerSesionConsola() {
    const cliente = window.SIG_STATE?.supabaseClient;
    if (!cliente?.auth) return null;
    const { data } = await cliente.auth.getSession();
    return data?.session || null;
  }

  async function actualizarEstadoSesionConsola() {
    const sesion = await obtenerSesionConsola();
    const badge = qs('badgeSesionConsolaSIG');
    const email = qs('consolaEmailSIG');
    const password = qs('consolaPasswordSIG');
    const btnLogin = qs('btnLoginConsolaSIG');
    const btnLogout = qs('btnLogoutConsolaSIG');

    if (sesion?.user) {
      if (badge) badge.innerHTML = `<i class="bi bi-unlock"></i>${escapeHtml(sesion.user.email || 'Sesión activa')}`;
      if (email) {
        email.value = sesion.user.email || '';
        email.disabled = true;
      }
      if (password) {
        password.value = '';
        password.disabled = true;
      }
      if (btnLogin) btnLogin.disabled = true;
      if (btnLogout) btnLogout.disabled = false;
      setEstadoConsola('Sesión iniciada. Puedes ejecutar consultas avanzadas.', 'info');
    } else {
      if (badge) badge.innerHTML = '<i class="bi bi-lock"></i>Sin sesión';
      if (email) email.disabled = false;
      if (password) password.disabled = false;
      if (btnLogin) btnLogin.disabled = false;
      if (btnLogout) btnLogout.disabled = true;
      setEstadoConsola('Requiere iniciar sesión para consultar datos adicionales de casos_2026.', 'secondary');
    }
  }

  async function iniciarSesionConsola() {
    const cliente = window.SIG_STATE?.supabaseClient;
    if (!cliente?.auth) {
      setEstadoConsola('No hay cliente Supabase disponible.', 'danger');
      return;
    }

    const email = String(qs('consolaEmailSIG')?.value || '').trim();
    const password = String(qs('consolaPasswordSIG')?.value || '');
    if (!email || !password) {
      setEstadoConsola('Escribe usuario/correo y contraseña.', 'warning');
      return;
    }

    const boton = qs('btnLoginConsolaSIG');
    const htmlOriginal = boton?.innerHTML || '';
    try {
      if (boton) {
        boton.disabled = true;
        boton.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Ingresando...';
      }
      const { error } = await cliente.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await actualizarEstadoSesionConsola();
      setEstadoConsola('Sesión iniciada correctamente.', 'info');
    } catch (error) {
      console.error(error);
      setEstadoConsola(error?.message || 'No fue posible iniciar sesión.', 'danger');
    } finally {
      if (boton) boton.innerHTML = htmlOriginal;
      await actualizarEstadoSesionConsola();
    }
  }

  async function cerrarSesionConsola() {
    const cliente = window.SIG_STATE?.supabaseClient;
    if (!cliente?.auth) return;
    try {
      await cliente.auth.signOut();
      setEstadoConsola('Sesión cerrada.', 'secondary');
    } catch (error) {
      console.error(error);
      setEstadoConsola(error?.message || 'No fue posible cerrar sesión.', 'danger');
    } finally {
      await actualizarEstadoSesionConsola();
    }
  }

  function quitarComillas(valor) {
    const texto = String(valor ?? '').trim();
    if ((texto.startsWith('"') && texto.endsWith('"')) || (texto.startsWith("'") && texto.endsWith("'"))) {
      return texto.slice(1, -1);
    }
    return texto;
  }

  function nombreCampoConsola(campo) {
    const normalizado = normTxt(campo).replace(/[^a-z0-9_]/g, '');
    const mapa = {
      ano: 'anio', anio: 'anio', año: 'anio',
      departamento: 'departamento', depto: 'departamento',
      municipio: 'municipio', lugar: 'municipio',
      pueblo: 'pueblo', pueblos: 'pueblo',
      macrotipo: 'macrotipo', tipo: 'macrotipo',
      macroregion: 'macroregion', region: 'macroregion', macroregión: 'macroregion',
      macroactor: 'macroactor', actor: 'macroactor',
      poblacional: 'poblacional', categoria: 'poblacional', categoría: 'poblacional',
      texto: 'texto', buscar: 'texto', palabra: 'texto',
      personas: 'personas', persona: 'personas', victimas: 'personas', víctimas: 'personas',
      mujeres: 'mujeres', mujer: 'mujeres',
      hombres: 'hombres', hombre: 'hombres',
      menores: 'menores', menor: 'menores'
    };
    return mapa[normalizado] || null;
  }

  function aplicarRangoNumerico(params, campo, operador, valor) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) throw new Error(`El valor de ${campo} debe ser numérico.`);
    const n = Math.trunc(numero);
    const minKey = `p_min_${campo}`;
    const maxKey = `p_max_${campo}`;

    if (operador === '>' ) params[minKey] = Math.max(params[minKey] ?? -Infinity, n + 1);
    else if (operador === '>=') params[minKey] = Math.max(params[minKey] ?? -Infinity, n);
    else if (operador === '<') params[maxKey] = Math.min(params[maxKey] ?? Infinity, n - 1);
    else if (operador === '<=') params[maxKey] = Math.min(params[maxKey] ?? Infinity, n);
    else {
      params[minKey] = n;
      params[maxKey] = n;
    }

    if (params[minKey] === -Infinity) params[minKey] = null;
    if (params[maxKey] === Infinity) params[maxKey] = null;
  }

  function parsearComandoConsola(entrada) {
    const original = String(entrada || '').trim();
    if (!original) throw new Error('Escribe un comando. Ejemplo: buscar año:2024 mujeres>0');

    const bajo = normTxt(original);
    if (bajo === 'ayuda' || bajo === 'help' || bajo === '?') return { tipo: 'ayuda' };
    if (bajo === 'limpiar') return { tipo: 'limpiar' };
    if (bajo === 'limpiar mapa') return { tipo: 'limpiar_mapa' };
    if (bajo === 'limpiar calor' || bajo === 'limpiar mapa calor' || bajo === 'limpiar mapa de calor') return { tipo: 'limpiar_calor' };
    if (bajo === 'calor casos' || bajo === 'mapa calor casos' || bajo === 'mapa de calor casos') return { tipo: 'calor', metrica: 'casos' };
    if (bajo === 'calor personas' || bajo === 'mapa calor personas' || bajo === 'mapa de calor personas') return { tipo: 'calor', metrica: 'personas' };
    if (bajo === 'mostrar todos' || bajo === 'mostrar todo' || bajo === 'todos') {
      return { tipo: 'buscar', params: crearParametrosConsola(), descripcion: ['Todos los registros avanzados'] };
    }

    let cuerpo = original;
    if (/^buscar\b/i.test(cuerpo)) cuerpo = cuerpo.replace(/^buscar\b/i, '').trim();

    const params = crearParametrosConsola();
    const descripcion = [];
    const usados = [];
    const patron = /([a-zA-ZáéíóúÁÉÍÓÚüÜñÑ_]+)\s*(>=|<=|>|<|=|:)\s*("[^"]*"|'[^']*'|[^\s]+)/g;
    let match;

    while ((match = patron.exec(cuerpo)) !== null) {
      const campo = nombreCampoConsola(match[1]);
      const operador = match[2];
      const valor = quitarComillas(match[3]);
      usados.push(match[0]);

      if (!campo) throw new Error(`Campo no permitido: ${match[1]}. Usa ayuda para ver campos disponibles.`);

      if (campo === 'anio') {
        const n = Number(valor);
        if (!Number.isFinite(n)) throw new Error('El año debe ser numérico.');
        if (operador === '>' ) { params.p_anio_inicio = Math.trunc(n) + 1; descripcion.push(`Año > ${Math.trunc(n)}`); }
        else if (operador === '>=') { params.p_anio_inicio = Math.trunc(n); descripcion.push(`Año ≥ ${Math.trunc(n)}`); }
        else if (operador === '<') { params.p_anio_fin = Math.trunc(n) - 1; descripcion.push(`Año < ${Math.trunc(n)}`); }
        else if (operador === '<=') { params.p_anio_fin = Math.trunc(n); descripcion.push(`Año ≤ ${Math.trunc(n)}`); }
        else { params.p_anio = Math.trunc(n); descripcion.push(`Año ${Math.trunc(n)}`); }
        continue;
      }

      if (['personas', 'mujeres', 'hombres', 'menores'].includes(campo)) {
        aplicarRangoNumerico(params, campo, operador, valor);
        const simbolo = operador === ':' ? '=' : operador;
        descripcion.push(`${campo.charAt(0).toUpperCase() + campo.slice(1)} ${simbolo} ${valor}`);
        continue;
      }

      if (operador !== ':' && operador !== '=') {
        throw new Error(`El campo ${campo} solo admite : o =.`);
      }

      if (campo === 'departamento') params.p_departamento = valor;
      if (campo === 'municipio') params.p_municipio = valor;
      if (campo === 'pueblo') params.p_pueblo = valor;
      if (campo === 'macrotipo') params.p_macrotipo = valor;
      if (campo === 'macroregion') params.p_macroregion = valor;
      if (campo === 'macroactor') params.p_macroactor = valor;
      if (campo === 'poblacional') params.p_poblacional = valor;
      if (campo === 'texto') params.p_texto = valor;

      descripcion.push(`${campo.charAt(0).toUpperCase() + campo.slice(1)}: ${valor}`);
    }

    if (!descripcion.length) {
      const textoLibre = cuerpo.trim();
      if (textoLibre) {
        params.p_texto = textoLibre;
        descripcion.push(`Texto: ${textoLibre}`);
      } else {
        descripcion.push('Todos los registros avanzados');
      }
    }

    return { tipo: 'buscar', params, descripcion };
  }

  function crearParametrosConsola() {
    return {
      p_anio: null,
      p_anio_inicio: null,
      p_anio_fin: null,
      p_departamento: null,
      p_municipio: null,
      p_pueblo: null,
      p_macrotipo: null,
      p_macroregion: null,
      p_macroactor: null,
      p_poblacional: null,
      p_texto: null,
      p_min_personas: null,
      p_max_personas: null,
      p_min_mujeres: null,
      p_max_mujeres: null,
      p_min_hombres: null,
      p_max_hombres: null,
      p_min_menores: null,
      p_max_menores: null
    };
  }

  function normalizarParametrosRpc(params) {
    const limpio = {};
    Object.entries(params || {}).forEach(([clave, valor]) => {
      if (valor === undefined || valor === -Infinity || valor === Infinity) limpio[clave] = null;
      else if (typeof valor === 'string') limpio[clave] = valor.trim() || null;
      else limpio[clave] = valor;
    });
    return limpio;
  }

  function guardarHistorialConsola(comando) {
    const texto = String(comando || '').trim();
    if (!texto) return;
    const existente = historialConsola.indexOf(texto);
    if (existente >= 0) historialConsola.splice(existente, 1);
    historialConsola.unshift(texto);
    historialConsola.splice(12);

    const select = qs('consolaHistorialSIG');
    if (!select) return;
    select.innerHTML = '<option value="">Historial</option>';
    historialConsola.forEach(item => select.appendChild(new Option(item, item)));
  }

  function resumenHtmlConsola({ registros = 0, casosConCoordenadas = 0, puntos = 0, personas = 0, mujeres = 0, hombres = 0, menores = 0, descripcion = [] } = {}) {
    const textoConsulta = descripcion.length ? descripcion.join(' · ') : 'Todos los registros avanzados';
    return `
      <div class="fw-semibold mb-2"><i class="bi bi-activity me-1"></i>Resultado</div>
      <div class="small mb-2">Consulta: <code>${escapeHtml(textoConsulta)}</code></div>
      <div class="row g-2 small">
        <div class="col-6">Registros: <strong>${formatearNumero(registros)}</strong></div>
        <div class="col-6">Casos coord.: <strong>${formatearNumero(casosConCoordenadas)}</strong></div>
        <div class="col-6">Puntos mapa: <strong>${formatearNumero(puntos)}</strong></div>
        <div class="col-6">Personas: <strong>${formatearNumero(personas)}</strong></div>
        <div class="col-6">Mujeres: <strong>${formatearNumero(mujeres)}</strong></div>
        <div class="col-6">Hombres: <strong>${formatearNumero(hombres)}</strong></div>
        <div class="col-6">Menores: <strong>${formatearNumero(menores)}</strong></div>
      </div>`;
  }

  async function ejecutarComandoConsola() {
    const comandoEl = qs('consolaComandoSIG');
    const boton = qs('btnEjecutarConsolaSIG');
    const htmlOriginal = boton?.innerHTML || '';
    const comando = comandoEl?.value || '';

    try {
      limpiarAyudaConsola();
      const parsed = parsearComandoConsola(comando);

      if (parsed.tipo === 'ayuda') {
        mostrarAyudaConsola();
        return;
      }
      if (parsed.tipo === 'limpiar') {
        if (comandoEl) comandoEl.value = '';
        actualizarTablaConsola([]);
        mostrarResumenConsola('<div class="fw-semibold mb-2"><i class="bi bi-activity me-1"></i>Resultado</div><div class="text-secondary small">Comando y resultados limpiados.</div>');
        setEstadoConsola('Comando limpiado.', 'secondary');
        return;
      }
      if (parsed.tipo === 'limpiar_mapa') {
        limpiarRegistrosMapa();
        setEstadoConsola('Mapa limpiado desde consola.', 'secondary');
        return;
      }
      if (parsed.tipo === 'limpiar_calor') {
        limpiarMapaCalorDepartamentos();
        setEstadoConsola('Mapa de calor departamental limpiado.', 'secondary');
        return;
      }
      if (parsed.tipo === 'calor') {
        await aplicarMapaCalorDepartamentos({ metrica: parsed.metrica });
        setEstadoConsola(`Mapa de calor aplicado por ${parsed.metrica}.`, 'info');
        return;
      }

      const sesion = await obtenerSesionConsola();
      if (!sesion?.user) {
        abrirConsolaAvanzada();
        setEstadoConsola('Inicia sesión antes de ejecutar consultas avanzadas.', 'warning');
        return;
      }

      if (boton) {
        boton.disabled = true;
        boton.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Run...';
      }

      const parametros = normalizarParametrosRpc(parsed.params);
      setEstadoConsola('Consultando tablas ligeras avanzadas...', 'info');

      const registros = await consultarCasosAvanzadosFiltrados(parametros);
      window.SIG_STATE.casosConsultados = registros;
      const resumenMapa = pintarRegistrosEnMapa(registros);
      const poblacion = calcularTotalesPoblacion(registros);
      const resumen = { ...resumenMapa, ...poblacion, descripcion: parsed.descripcion };

      actualizarEstadisticasFiltros({ ...resumenMapa, ...poblacion });
      if (estadoMapaCalorDepto.activo) refrescarMapaCalorDepartamentos({ silencioso: false });
      mostrarResumenConsola(resumenHtmlConsola(resumen));
      actualizarTablaConsola(registros);
      guardarHistorialConsola(comando);

      if (resumenMapa.puntos) setEstadoConsola(`${formatearNumero(resumenMapa.puntos)} puntos pintados desde consola.`, 'info');
      else setEstadoConsola(`${formatearNumero(registros.length)} registros encontrados, sin coordenadas válidas.`, 'warning');
      actualizarEstado(`Consola: ${formatearNumero(registros.length)} registros`);
    } catch (error) {
      console.error(error);
      const mensaje = error?.message || 'No fue posible ejecutar el comando.';
      const ayuda = mensaje.includes('Could not find the function') || mensaje.includes('PGRST202')
        ? ' Ejecuta el SQL 10 de tablas ligeras SIG en Supabase y recarga con Ctrl+F5.'
        : '';
      setEstadoConsola(`${mensaje}${ayuda}`, 'danger');
      mostrarResumenConsola(`<div class="fw-semibold mb-2"><i class="bi bi-exclamation-triangle me-1"></i>Error</div><div class="small text-danger">${escapeHtml(mensaje + ayuda)}</div>`);
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.innerHTML = htmlOriginal;
      }
    }
  }

  function vincularConsolaAvanzada() {
    qs('btnAbrirConsolaSIG')?.addEventListener('click', abrirConsolaAvanzada);
    qs('btnCerrarConsolaSIG')?.addEventListener('click', cerrarConsolaAvanzada);
    qs('btnLoginConsolaSIG')?.addEventListener('click', iniciarSesionConsola);
    qs('btnLogoutConsolaSIG')?.addEventListener('click', cerrarSesionConsola);
    qs('btnEjecutarConsolaSIG')?.addEventListener('click', ejecutarComandoConsola);
    qs('btnLimpiarComandoSIG')?.addEventListener('click', () => {
      const cmd = qs('consolaComandoSIG');
      if (cmd) cmd.value = '';
      limpiarAyudaConsola();
      setEstadoConsola('Comando limpiado.', 'secondary');
    });
    qs('btnLimpiarMapaConsolaSIG')?.addEventListener('click', limpiarRegistrosMapa);
    qs('btnAyudaConsolaSIG')?.addEventListener('click', mostrarAyudaConsola);
    qs('consolaHistorialSIG')?.addEventListener('change', event => {
      const valor = event.target.value;
      if (valor && qs('consolaComandoSIG')) qs('consolaComandoSIG').value = valor;
      event.target.value = '';
    });
    qs('consolaComandoSIG')?.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') ejecutarComandoConsola();
    });

    const cliente = window.SIG_STATE?.supabaseClient;
    if (cliente?.auth) {
      cliente.auth.onAuthStateChange(() => actualizarEstadoSesionConsola());
      actualizarEstadoSesionConsola();
    }
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
    actualizarEstadisticasFiltros({
      registros: 0,
      casosConCoordenadas: 0,
      puntos: 0,
      personas: 0,
      mujeres: 0,
      hombres: 0,
      menores: 0
    });
    vincularPanelFiltros();
    vincularConsolaAvanzada();
    cargarOpcionesFiltros();
  }

  // API global mínima para que sigindex.html pueda inicializar el módulo.
  window.SIG_DATOS = {
    inicializar,
    mostrarTodosLosRegistros,
    aplicarFiltrosSIG,
    limpiarFiltrosSIG,
    limpiarRegistrosMapa,
    abrirConsolaAvanzada,
    cerrarConsolaAvanzada,
    ejecutarComandoConsola,
    pintarRegistrosEnMapa,
    aplicarMapaCalorDepartamentos,
    limpiarMapaCalorDepartamentos,
    refrescarMapaCalorDepartamentos,
    obtenerEstiloDepartamentoCalor,
    crearPopupDepartamentoCalor
  };
})();
