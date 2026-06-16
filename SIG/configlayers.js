/*
  configlayers.js
  Configuración general de capas del módulo SIG.

  Este archivo concentra las rutas de los archivos GeoJSON, el orden visual
  de los panes de Leaflet y los estilos iniciales de cada capa. La idea es
  que el archivo sigindex.html pueda leer esta configuración y construir la
  interfaz de capas sin tener que modificar la lógica principal del mapa.
*/

// Se crea un objeto global para que sigindex.html pueda leerlo después de cargar este archivo.
window.SIG_CONFIG_VERSION = '20260615-sig-panel-filtros-blanco-v2';
window.SIG_CONFIG = {
  // Configuración inicial del mapa: centro aproximado de Colombia y zoom nacional.
  mapa: {
    centro: [4.5709, -74.2973],
    zoom: 6,
    zoomMinimo: 4,
    zoomMaximo: 19,
    // Zoom fraccionado para evitar saltos bruscos al acercar o alejar.
    zoomSnap: 0.25,
    pasoZoom: 0.25,
    ruedaZoomSensibilidad: 180
  },


  // Conexión pública controlada a Supabase para reconstrucción del módulo SIG.
  // No usar usuario, contraseña ni service_role en archivos del navegador.
  // Se cuenta casos_2026 como datos core y se consulta sig_casos_public_2026 para puntos del mapa.
  supabase: {
    url: 'https://sjvuxlcgeswapbphsqkv.supabase.co',
    clavePublica: 'sb_publishable_Ft_DEmGA6t0uOdu73wrvVg_-_Z8cnPg',
    vistaCasos: 'sig_casos_public_2026',
    tablaCasos: 'casos_2026',
    timeoutConsultaMs: 15000,
    batchPuntosMapa: 1000,
    batchCasosCore: 1000
  },

  // Estilo inicial de los circleMarker de casos. Usan un pane propio por encima de todas las capas.
  casos: {
    pane: 'paneCasosTop',
    zoomMaximoAjuste: 9,
    estiloPunto: {
      radio: 5,
      colorRelleno: '#0d6efd',
      colorLinea: '#052c65',
      grosorLinea: 1,
      opacidadRelleno: 0.65,
      opacidadLinea: 0.9
    }
  },

  // Configuración del mapa de calor departamental. Se alimenta desde los registros
  // filtrados en el panel.
  mapaCalorDepartamentos: {
    propiedadNombre: 'DPTO_CNMBR',
    metricaInicial: 'casos',
    colorSinDato: '#f8fafc',
    colorBorde: '#334155',
    opacidad: 1,
    grosorLinea: 1.2,
    colores: ['#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0284c7', '#075985']
  },

  // Definición de panes Leaflet. Los panes controlan el orden de dibujo de las capas.
  // Un zIndex menor queda más abajo; un zIndex mayor queda más arriba.
  panes: [
    { id: 'pane0', nombre: 'Nivel 0 · Fondo inferior', zIndex: 410 },
    { id: 'pane1', nombre: 'Nivel 1', zIndex: 420 },
    { id: 'pane2', nombre: 'Nivel 2', zIndex: 430 },
    { id: 'pane3', nombre: 'Nivel 3', zIndex: 440 },
    { id: 'pane4', nombre: 'Nivel 4', zIndex: 450 },
    { id: 'pane5', nombre: 'Nivel 5', zIndex: 460 },
    { id: 'pane6', nombre: 'Nivel 6', zIndex: 470 },
    { id: 'pane7', nombre: 'Nivel 7', zIndex: 480 },
    { id: 'pane8', nombre: 'Nivel 8', zIndex: 490 },
    { id: 'pane9', nombre: 'Nivel 9 · Superior', zIndex: 500 },
    { id: 'labels', nombre: 'Labels · Etiquetas', zIndex: 650, pointerEvents: 'none' },
    { id: 'paneCasosTop', nombre: 'Casos · Puntos superiores', zIndex: 1000 },
    { id: 'panePopupsTop', nombre: 'Popups · Sobre marcadores', zIndex: 1300 }
  ],

  // Paleta reutilizable para controles de color. Se usa para color de relleno y color de línea.
  // Los colores están organizados para tener neutros, pasteles, tonos medios y tonos fuertes.
  paletaColores: [
    '#ffffff', '#f4cccc', '#d5a6bd', '#c9bedf', '#bdd7ee', '#b7e1e1', '#d9ead3', '#fffcc4', '#fce5cd', '#f9cb9c', '#f6b26b',
    '#f3f3f3', '#d9d9d9', '#b7b7b7', '#f4b183', '#c27ba0', '#b4a7d6', '#a2c4d4', '#a4d2c9', '#b7f7c6', '#ffffcc', '#ffe0b2',
    '#ffa64d', '#ff7f2a', '#cccccc', '#bfbfbf', '#999999', '#ff8a65', '#a779a3', '#8e8abd', '#61a8d1', '#66c2a5', '#66e6a3',
    '#ffff99', '#f9d493', '#ff7f27', '#ff6600', '#b3b3b3', '#8c8c8c', '#737373', '#ff5c47', '#8e44ad', '#6f63ad', '#3d8fc2',
    '#45b07a', '#00c49a', '#ffff66', '#ffbd80', '#ff6b00', '#e04b00', '#909090', '#666666', '#4d4d4d', '#ee3b2f', '#5e4aa5',
    '#674ea7', '#1f77b4', '#238b45', '#009966', '#ffff00', '#ff7f50', '#d94801', '#a63603', '#777777', '#4f4f4f', '#222222',
    '#d7191c', '#54278f', '#4b004b', '#005a9c', '#006d2c', '#00614f', '#fff200', '#f04e37', '#b73d00', '#7f2704', '#555555',
    '#222222', '#000000'
  ],

  // Lista de capas GeoJSON que aparecerán en el panel lateral.
  // La ruta se calcula desde sigindex.html; por eso se usa ./Layers/nombre.geojson.
  capas: [
    {
      id: 'tablero',
      nombre: 'Tablero',
      archivo: './Layers/001tablero.geojson',
      activa: false,
      pane: 'pane0',
      colorCapa: '#000000',
      colorLinea: '#000000',
      opacidad: 1,
      grosorLinea: 1
    },
    {
      id: 'basemap',
      nombre: 'Basemap',
      archivo: './Layers/002basemap.geojson',
      activa: false,
      pane: 'pane0',
      colorCapa: '#d9ead3',
      colorLinea: '#6aa84f',
      opacidad: 1,
      grosorLinea: 1
    },
    {
      id: 'departamentos',
      nombre: 'Departamentos',
      archivo: './Layers/003departamentos.geojson',
      activa: false,
      // Se ubica debajo de municipios y resguardos para que esas capas también reciban clic.
      // Los puntos de casos usan paneCasosTop y quedan por encima de todas las capas.
      pane: 'pane3',
      colorCapa: '#bdd7ee',
      colorLinea: '#1f77b4',
      opacidad: 1,
      grosorLinea: 1,
      popupCampos: [
        { etiqueta: 'Departamento', campos: ['DPTO_CNMBR', 'DPTO_NOMBRE', 'DEPARTAMEN', 'DEPTO', 'DEPARTAMENTO', 'NOMBRE_DPT', 'NOMBRE', 'nombre'] }
      ]
    },
    {
      id: 'municipios',
      nombre: 'Municipios',
      archivo: './Layers/004municipios.geojson',
      activa: false,
      pane: 'pane4',
      colorCapa: '#fffcc4',
      colorLinea: '#d94801',
      opacidad: 1,
      grosorLinea: 1,
      popupCampos: [
        { etiqueta: 'Municipio', campos: ['MPIO_CNMBR', 'MUNICIPIO', 'NOMBRE_MPI', 'NOMBRE', 'nombre'] },
        { etiqueta: 'Nombre', campos: ['nombre', 'NOMBRE', 'NOMBRE_MPI', 'MPIO_CNMBR'] },
        { etiqueta: 'DEPTO', campos: ['DEPTO', 'DPTO_CNMBR', 'DEPARTAMEN', 'DEPARTAMENTO'] },
        { etiqueta: 'Departamento', campos: ['departamento', 'DEPARTAMENTO', 'DPTO_CNMBR', 'DEPARTAMEN', 'DEPTO'] }
      ]
    },
    {
      id: 'resguardos',
      nombre: 'Resguardos',
      archivo: './Layers/004resguardos.geojson',
      activa: false,
      pane: 'pane6',
      colorCapa: '#b7f7c6',
      colorLinea: '#006d2c',
      opacidad: 1,
      grosorLinea: 2,
      popupCampos: [
        { etiqueta: 'Pueblo', campos: ['PUEBLO', 'Pueblo', 'pueblo'] },
        { etiqueta: 'Departamento', campos: ['DEPARTAMENTO', 'DEPTO', 'DPTO_CNMBR', 'departamento'] },
        { etiqueta: 'Municipio', campos: ['MUNICIPIO', 'MPIO_CNMBR', 'municipio'] },
        { etiqueta: 'Nombre', campos: ['NOMBRE', 'nombre', 'NOMBRE_RES', 'RESGUARDO'] }
      ]
    }
  ]
};

