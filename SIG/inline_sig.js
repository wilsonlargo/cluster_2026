
    // Estado interno del SIG compartido con datasig.js.
    const SIG_STATE = window.SIG_STATE = {
      mapa: null,
      supabaseClient: null,
      capaCasos: null,
      capasPorId: new Map(),
      geojsonPorId: new Map(),
      cargandoPorId: new Set(),
      casosConsultados: [],
      mapaCalorDepartamentos: null,
      departamentosDestacados: null,
      macroregionesDestacadas: null,
      ultimoClickDepartamentoMs: 0
    };

    // Atajo para obtener elementos del DOM por id.
    function qs(id) {
      return document.getElementById(id);
    }

    // Escapa texto antes de insertarlo en HTML.
    function escapeHtml(valor) {
      return String(valor ?? '').replace(/[&<>"']/g, caracter => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[caracter]));
    }

    // Normaliza texto localmente para cruces entre GeoJSON y registros.
    function normTxtLocal(valor) {
      return String(valor ?? '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    }

    // Obtiene el nombre de departamento desde el GeoJSON. DPTO_CNMBR es la variable principal.
    function obtenerNombreDepartamentoFeature(feature) {
      const props = feature?.properties || {};
      return props.DPTO_CNMBR || props.DEPARTAMEN || props.DEPTO || props.NOMBRE_DPT || props.NOMBRE || props.nombre || '';
    }

    // Muestra avisos en el panel de capas.
    function mostrarAvisoCapas(tipo, mensaje) {
      const contenedor = qs('alertasCapas');
      if (!contenedor) return;
      contenedor.innerHTML = `<div class="alert alert-${tipo} py-2 mb-0" role="alert">${escapeHtml(mensaje)}</div>`;
    }

    // Actualiza el texto de estado en la barra superior.
    function actualizarEstado(texto) {
      const estado = qs('estadoSIG');
      if (estado) estado.textContent = texto;
    }

    // Crea los panes de Leaflet declarados en configlayers.js.
    function crearPanesLeaflet(mapa) {
      SIG_CONFIG.panes.forEach(paneConfig => {
        const pane = mapa.getPane(paneConfig.id) || mapa.createPane(paneConfig.id);
        pane.style.zIndex = String(paneConfig.zIndex);
        pane.style.pointerEvents = paneConfig.pointerEvents || 'auto';
      });
    }

    // Construye el estilo Leaflet de una capa GeoJSON.
    function obtenerEstiloCapa(capaConfig) {
      return {
        pane: capaConfig.pane,
        color: capaConfig.colorLinea,
        weight: Number(capaConfig.grosorLinea),
        opacity: Number(capaConfig.opacidad),
        fillColor: capaConfig.colorCapa,
        fillOpacity: Number(capaConfig.opacidad),
        lineCap: 'round',
        lineJoin: 'round'
      };
    }

    // Obtiene una propiedad por nombre exacto o equivalente, sin depender de mayúsculas/minúsculas.
    function obtenerPropiedadFlexible(props, campoSolicitado) {
      if (!props || !campoSolicitado) return undefined;
      const candidatos = Array.isArray(campoSolicitado) ? campoSolicitado : [campoSolicitado];
      const entradas = Object.entries(props);

      for (const campo of candidatos) {
        if (Object.prototype.hasOwnProperty.call(props, campo)) return props[campo];
      }

      for (const campo of candidatos) {
        const buscado = String(campo).trim().toLowerCase();
        const encontrado = entradas.find(([clave]) => String(clave).trim().toLowerCase() === buscado);
        if (encontrado) return encontrado[1];
      }

      for (const campo of candidatos) {
        const buscado = normTxtLocal(campo).replace(/[^a-z0-9]/g, '');
        const encontrado = entradas.find(([clave]) => normTxtLocal(clave).replace(/[^a-z0-9]/g, '') === buscado);
        if (encontrado) return encontrado[1];
      }

      return undefined;
    }

    function valorVisible(valor) {
      return valor !== null && valor !== undefined && String(valor).trim() !== '';
    }

    // Respaldo semántico para GeoJSON con nombres de campos distintos.
    // Mantiene los popups importantes de municipios y resguardos aunque el archivo cambie mayúsculas,
    // guiones bajos o nombres como NOM_MPIO / NOM_RESGUARDO.
    function obtenerPropiedadPorEtiqueta(props, etiqueta) {
      if (!props || !etiqueta) return undefined;
      const etiquetaNorm = normTxtLocal(etiqueta).replace(/[^a-z0-9]/g, '');
      const entradas = Object.entries(props);

      const patrones = [];
      if (etiquetaNorm.includes('municipio')) patrones.push('municip', 'mpio', 'muni');
      if (etiquetaNorm.includes('departamento') || etiquetaNorm === 'depto') patrones.push('depart', 'depto', 'dpto');
      if (etiquetaNorm.includes('pueblo')) patrones.push('pueblo', 'etnia', 'etnico');
      if (etiquetaNorm.includes('nombre')) patrones.push('nombre', 'name', 'nom', 'resguardo', 'resg');

      for (const patron of patrones) {
        const encontrado = entradas.find(([clave, valor]) => {
          if (!valorVisible(valor)) return false;
          const claveNorm = normTxtLocal(clave).replace(/[^a-z0-9]/g, '');
          return claveNorm.includes(patron);
        });
        if (encontrado) return encontrado[1];
      }

      return undefined;
    }

    function obtenerValorPopupConfigurado(props, item) {
      const directo = obtenerPropiedadFlexible(props, item?.campos || item?.campo);
      if (valorVisible(directo)) return directo;
      return obtenerPropiedadPorEtiqueta(props, item?.etiqueta || item?.campo);
    }

    function construirTablaPopupConfigurada(feature, capaConfig) {
      const props = feature?.properties || {};
      const camposConfigurados = Array.isArray(capaConfig?.popupCampos) ? capaConfig.popupCampos : [];

      if (camposConfigurados.length) {
        const filas = camposConfigurados.map(item => {
          const valor = obtenerValorPopupConfigurado(props, item);
          if (!valorVisible(valor)) return '';
          return `<tr><th class="text-muted pe-2">${escapeHtml(item.etiqueta || item.campo)}</th><td>${escapeHtml(valor)}</td></tr>`;
        }).join('');

        if (filas) return `<table class="table table-sm mb-0"><tbody>${filas}</tbody></table>`;
      }

      const filasGenericas = Object.entries(props)
        .filter(([, valor]) => valorVisible(valor))
        .slice(0, 8)
        .map(([clave, valor]) => `<tr><th class="text-muted pe-2">${escapeHtml(clave)}</th><td>${escapeHtml(valor)}</td></tr>`)
        .join('');

      return filasGenericas
        ? `<table class="table table-sm mb-0"><tbody>${filasGenericas}</tbody></table>`
        : '<div class="text-muted small">Sin información en los campos configurados.</div>';
    }


    function crearPopupMunicipiosExacto(feature, capaConfig) {
      const props = feature?.properties || {};
      const nombre = obtenerPropiedadFlexible(props, ['MPIO_CNMBR']);
      const departamento = obtenerPropiedadFlexible(props, ['DEPTO']);
      const filas = [
        ['Nombre', nombre],
        ['Departamento', departamento]
      ]
        .filter(([, valor]) => valorVisible(valor))
        .map(([clave, valor]) => `<tr><th class="text-muted pe-2">${escapeHtml(clave)}</th><td>${escapeHtml(valor)}</td></tr>`)
        .join('');

      const cuerpo = filas
        ? `<table class="table table-sm mb-0"><tbody>${filas}</tbody></table>`
        : '<div class="text-muted small">Sin información en MPIO_CNMBR / DEPTO.</div>';

      return `<div class="sig-popup-atributos" style="min-width:220px; max-width:420px"><div class="fw-bold mb-2">${escapeHtml(capaConfig?.nombre || 'Municipios')}</div>${cuerpo}</div>`;
    }

    function crearPopupResguardosExacto(feature, capaConfig) {
      const props = feature?.properties || {};
      const pueblo = obtenerPropiedadFlexible(props, ['PUEBLO', 'Pueblo', 'pueblo', 'ETNIA', 'ETNICO', 'COMUNIDAD']);
      const departamento = obtenerPropiedadFlexible(props, ['DEPARTAMENTO', 'DEPTO', 'DPTO_CNMBR', 'DPTO_NOMBRE', 'DEPARTAMEN', 'departamento']);
      const municipio = obtenerPropiedadFlexible(props, ['MUNICIPIO', 'MPIO_CNMBR', 'NOMBRE_MPI', 'NOM_MPIO', 'municipio']);
      const nombre = obtenerPropiedadFlexible(props, ['NOMBRE', 'nombre', 'NOMBRE_RES', 'NOM_RESGUARDO', 'RESGUARDO', 'NOM_RESG', 'NOM_RES']);
      const filas = [
        ['Pueblo', pueblo],
        ['Departamento', departamento],
        ['Municipio', municipio],
        ['Nombre', nombre]
      ]
        .filter(([, valor]) => valorVisible(valor))
        .map(([clave, valor]) => `<tr><th class="text-muted pe-2">${escapeHtml(clave)}</th><td>${escapeHtml(valor)}</td></tr>`)
        .join('');

      const cuerpo = filas
        ? `<table class="table table-sm mb-0"><tbody>${filas}</tbody></table>`
        : construirTablaPopupConfigurada(feature, capaConfig);

      return `<div class="sig-popup-atributos" style="min-width:240px; max-width:430px"><div class="fw-bold mb-2">${escapeHtml(capaConfig?.nombre || 'Resguardos')}</div>${cuerpo}</div>`;
    }

    function crearPopupAtributosGeoJSON(feature, capaConfig) {
      if (capaConfig?.id === 'municipios') return crearPopupMunicipiosExacto(feature, capaConfig);
      if (capaConfig?.id === 'resguardos') return crearPopupResguardosExacto(feature, capaConfig);
      const nombreCapa = typeof capaConfig === 'string' ? capaConfig : (capaConfig?.nombre || 'Capa');
      const tabla = construirTablaPopupConfigurada(feature, capaConfig);
      return `<div class="sig-popup-atributos" style="min-width:220px; max-width:420px"><div class="fw-bold mb-2">${escapeHtml(nombreCapa)}</div>${tabla}</div>`;
    }

    // Crea contenido de popup para atributos de GeoJSON usando la configuración de cada layer.
    // Si hay mapa de calor activo, solo se combina con la capa objetivo; no reemplaza los popups
    // configurados de municipios o resguardos.
    function crearPopupDesdePropiedades(feature, capaConfig) {
      const nombreCapa = typeof capaConfig === 'string' ? capaConfig : (capaConfig?.nombre || 'Capa');
      const popupAtributos = crearPopupAtributosGeoJSON(feature, capaConfig);
      const popupCalor = window.SIG_DATOS?.crearPopupMapaCalor?.(feature, capaConfig, nombreCapa)
        || window.SIG_DATOS?.crearPopupDepartamentoCalor?.(feature, capaConfig, nombreCapa);

      if (!popupCalor) return popupAtributos;

      // Departamentos conserva el popup enriquecido del mapa de calor como principal.
      if (capaConfig?.id === 'departamentos') return popupCalor;

      // Municipios conserva sus campos de capa y añade el bloque de calor cuando aplique.
      if (capaConfig?.id === 'municipios') {
        return `<div style="min-width:300px; max-width:460px">${popupAtributos}<hr class="my-2">${popupCalor}</div>`;
      }

      // Resguardos y demás capas nunca se reemplazan por el mapa de calor.
      return popupAtributos;
    }

    // Abre un popup Leaflet real sobre el punto exacto del clic.
    // Para departamentos usamos L.popup().openOn(mapa), no solo bindPopup(),
    // porque los polígonos multiparte pueden fallar al calcular un centro automático.
    function abrirPopupLeaflet(feature, layer, capaConfig, event) {
      const html = crearPopupDesdePropiedades(feature, capaConfig);
      const latlng = event?.latlng
        || (layer?.getBounds ? layer.getBounds().getCenter() : SIG_STATE.mapa.getCenter());

      if (event?.originalEvent) {
        L.DomEvent.stopPropagation(event.originalEvent);
        L.DomEvent.preventDefault(event.originalEvent);
      }

      L.popup({
        pane: 'panePopupsTop',
        maxWidth: 460,
        minWidth: 300,
        autoPan: true,
        closeButton: true,
        className: capaConfig.id === 'departamentos' ? 'sig-popup-leaflet-departamento' : ''
      })
        .setLatLng(latlng)
        .setContent(html)
        .openOn(SIG_STATE.mapa);
    }


    // Sube temporalmente la capa de departamentos por encima de municipios/resguardos
    // para que el clic sobre polígonos departamentales no quede capturado por otra capa.
    function asegurarDepartamentosClicables() {
      const paneCasos = SIG_STATE.mapa?.getPane('paneCasosTop') || SIG_STATE.mapa?.getPane('pane9');
      const panePopups = SIG_STATE.mapa?.getPane('panePopupsTop') || SIG_STATE.mapa?.createPane?.('panePopupsTop');
      if (paneCasos) {
        paneCasos.style.zIndex = '1000';
        paneCasos.style.pointerEvents = 'auto';
      }
      if (panePopups) {
        panePopups.style.zIndex = '1300';
        panePopups.style.pointerEvents = 'auto';
      }
    }

    // Fallback geométrico: si otra capa captura el clic y el evento directo del
    // departamento no se dispara, se identifica el departamento bajo el cursor.
    function puntoEnAnilloGeoJSON(punto, anillo) {
      const x = punto.lng;
      const y = punto.lat;
      let dentro = false;
      for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
        const xi = Number(anillo[i][0]);
        const yi = Number(anillo[i][1]);
        const xj = Number(anillo[j][0]);
        const yj = Number(anillo[j][1]);
        const intersecta = ((yi > y) !== (yj > y)) &&
          (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
        if (intersecta) dentro = !dentro;
      }
      return dentro;
    }

    function puntoEnPoligonoGeoJSON(punto, poligono) {
      if (!Array.isArray(poligono) || !poligono.length) return false;
      if (!puntoEnAnilloGeoJSON(punto, poligono[0])) return false;
      // Los anillos internos son huecos.
      for (let i = 1; i < poligono.length; i += 1) {
        if (puntoEnAnilloGeoJSON(punto, poligono[i])) return false;
      }
      return true;
    }

    function puntoEnFeatureDepartamento(punto, feature) {
      const geom = feature?.geometry;
      if (!geom) return false;
      if (geom.type === 'Polygon') return puntoEnPoligonoGeoJSON(punto, geom.coordinates);
      if (geom.type === 'MultiPolygon') return (geom.coordinates || []).some(poligono => puntoEnPoligonoGeoJSON(punto, poligono));
      return false;
    }

    function buscarDepartamentoEnLatLng(latlng) {
      const capa = SIG_STATE.capasPorId.get('departamentos');
      if (!capa || !latlng) return null;
      let encontrado = null;
      capa.eachLayer(layer => {
        if (encontrado || !layer?.feature) return;
        if (layer.getBounds && !layer.getBounds().contains(latlng)) return;
        if (puntoEnFeatureDepartamento(latlng, layer.feature)) encontrado = layer;
      });
      return encontrado;
    }

    function abrirPopupDepartamentoFallback(event) {
      const capaConfig = SIG_CONFIG.capas.find(capa => capa.id === 'departamentos');
      if (!capaConfig || !SIG_STATE.capasPorId.has('departamentos')) return;
      // Evita duplicar cuando el clic directo de cualquier capa sí funcionó.
      if (Date.now() - Number(SIG_STATE.ultimoClickCapaMs || 0) < 220) return;
      if (Date.now() - Number(SIG_STATE.ultimoClickDepartamentoMs || 0) < 220) return;
      const layer = buscarDepartamentoEnLatLng(event.latlng);
      if (!layer) return;
      abrirPopupLeaflet(layer.feature, layer, capaConfig, event);
    }

    // Crea una capa Leaflet desde un GeoJSON cargado.
    function crearCapaLeaflet(capaConfig, geojson) {
      const estilo = obtenerEstiloCapa(capaConfig);
      return L.geoJSON(geojson, {
        pane: capaConfig.pane,
        interactive: true,
        bubblingMouseEvents: false,
        style: feature => window.SIG_DATOS?.obtenerEstiloDepartamentoCalor?.(feature, capaConfig, estilo) || estilo,
        pointToLayer: (feature, latlng) => L.circleMarker(latlng, { ...estilo, radius: Math.max(4, Number(capaConfig.grosorLinea) + 3) }),
        onEachFeature: (feature, layer) => {
          layer._sigCapaId = capaConfig.id;

          if (capaConfig.id === 'departamentos') {
            // Popup con API nativa de Leaflet: L.popup().setLatLng().setContent().openOn(map).
            // También se deja bindPopup como respaldo para navegadores/capas multipolígono.
            layer.bindPopup(() => crearPopupDesdePropiedades(feature, capaConfig), {
              pane: 'panePopupsTop',
              maxWidth: 460,
              minWidth: 300,
              autoPan: true,
              closeButton: true,
              className: 'sig-popup-leaflet-departamento'
            });
            layer.on('click', event => {
              SIG_STATE.ultimoClickCapaMs = Date.now();
              SIG_STATE.ultimoClickDepartamentoMs = Date.now();
              abrirPopupLeaflet(feature, layer, capaConfig, event);
            });
            layer.on('mouseover', () => {
              if (layer.setStyle) {
                layer.setStyle({ weight: Math.max(2, Number(capaConfig.grosorLinea || 1) + 1), opacity: 1 });
              }
              if (layer.bringToFront) layer.bringToFront();
            });
            layer.on('mouseout', () => window.SIG_DATOS?.refrescarMapaCalorDepartamentos?.({ silencioso: true }));
          } else {
            layer.bindPopup(() => crearPopupDesdePropiedades(feature, capaConfig), {
              pane: 'panePopupsTop',
              maxWidth: 420,
              autoPan: true
            });
            layer.on('click', event => {
              SIG_STATE.ultimoClickCapaMs = Date.now();
              abrirPopupLeaflet(feature, layer, capaConfig, event);
            });
          }
        }
      });
    }

    // Carga un archivo GeoJSON una sola vez y lo conserva en memoria.
    async function cargarGeoJSON(capaConfig) {
      if (SIG_STATE.geojsonPorId.has(capaConfig.id)) return SIG_STATE.geojsonPorId.get(capaConfig.id);
      if (SIG_STATE.cargandoPorId.has(capaConfig.id)) return null;
      SIG_STATE.cargandoPorId.add(capaConfig.id);
      actualizarEstado(`Cargando ${capaConfig.nombre}...`);

      try {
        const respuesta = await fetch(capaConfig.archivo);
        if (!respuesta.ok) throw new Error(`No se pudo cargar ${capaConfig.archivo}`);
        const geojson = await respuesta.json();
        SIG_STATE.geojsonPorId.set(capaConfig.id, geojson);
        actualizarEstado(`${capaConfig.nombre} cargada`);
        return geojson;
      } catch (error) {
        mostrarAvisoCapas('warning', `No se encontró o no se pudo leer: ${capaConfig.archivo}`);
        actualizarEstado('Revisa archivos GeoJSON');
        const check = qs(`check-${capaConfig.id}`);
        if (check) check.checked = false;
        capaConfig.activa = false;
        return null;
      } finally {
        SIG_STATE.cargandoPorId.delete(capaConfig.id);
      }
    }

    // Activa una capa GeoJSON en el mapa.
    async function activarCapa(capaConfig) {
      const geojson = await cargarGeoJSON(capaConfig);
      if (!geojson || !SIG_STATE.mapa) return;

      if (SIG_STATE.capasPorId.has(capaConfig.id)) {
        SIG_STATE.mapa.removeLayer(SIG_STATE.capasPorId.get(capaConfig.id));
      }

      const capaLeaflet = crearCapaLeaflet(capaConfig, geojson).addTo(SIG_STATE.mapa);
      SIG_STATE.capasPorId.set(capaConfig.id, capaLeaflet);
      capaConfig.activa = true;
      actualizarColorIndicador(capaConfig);
      if (capaConfig.id === 'departamentos' || capaConfig.id === 'municipios') {
        asegurarDepartamentosClicables();
        window.SIG_DATOS?.refrescarMapaCalorDepartamentos?.({ silencioso: true });
      }
      actualizarEstado(`${capaConfig.nombre} activa`);
    }

    // Desactiva una capa quitándola del mapa.
    function desactivarCapa(capaConfig) {
      const capaLeaflet = SIG_STATE.capasPorId.get(capaConfig.id);
      if (capaLeaflet && SIG_STATE.mapa) SIG_STATE.mapa.removeLayer(capaLeaflet);
      SIG_STATE.capasPorId.delete(capaConfig.id);
      capaConfig.activa = false;
      actualizarEstado(`${capaConfig.nombre} desactivada`);
    }

    // Recrea una capa cuando se cambia su pane o posición.
    async function recrearCapaSiEstaActiva(capaConfig) {
      if (!capaConfig.activa) return;
      desactivarCapa(capaConfig);
      await activarCapa(capaConfig);
    }

    // Aplica cambios visuales a una capa activa.
    async function actualizarEstiloCapa(capaConfig, requiereRecrear = false) {
      if (requiereRecrear) {
        await recrearCapaSiEstaActiva(capaConfig);
        return;
      }

      const capaLeaflet = SIG_STATE.capasPorId.get(capaConfig.id);
      if (capaLeaflet) {
        capaLeaflet.setStyle(obtenerEstiloCapa(capaConfig));
        capaLeaflet.eachLayer(layer => {
          if (layer instanceof L.CircleMarker) {
            layer.setStyle({ ...obtenerEstiloCapa(capaConfig), radius: Math.max(4, Number(capaConfig.grosorLinea) + 3) });
          }
        });
      }
      if (capaConfig.id === 'departamentos' || capaConfig.id === 'municipios') {
        asegurarDepartamentosClicables();
        window.SIG_DATOS?.refrescarMapaCalorDepartamentos?.({ silencioso: true });
      }
      actualizarColorIndicador(capaConfig);
    }

    // Activa una capa por id desde módulos externos como datasig.js.
    async function activarCapaPorId(id) {
      const capaConfig = SIG_CONFIG.capas.find(capa => capa.id === id);
      if (!capaConfig) return null;
      const check = qs(`check-${id}`);
      if (check) check.checked = true;
      await activarCapa(capaConfig);
      return SIG_STATE.capasPorId.get(id) || null;
    }

    window.SIG_CAPAS = {
      activarCapaPorId,
      obtenerNombreDepartamentoFeature,
      normTxtLocal
    };

    // Actualiza el punto de color visible en la fila de la capa.
    function actualizarColorIndicador(capaConfig) {
      const dot = qs(`dot-${capaConfig.id}`);
      if (dot) dot.style.background = capaConfig.colorCapa;
    }

    // Crea un selector de color reutilizable para capa y línea.
    function crearSelectorColor({ id, etiqueta, valorInicial, onChange }) {
      const contenedor = document.createElement('div');
      contenedor.className = 'dropdown';

      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'color-picker-btn dropdown-toggle';
      boton.setAttribute('data-bs-toggle', 'dropdown');
      boton.setAttribute('aria-expanded', 'false');

      const muestra = document.createElement('span');
      muestra.className = 'color-sample';
      muestra.id = `${id}-muestra`;
      muestra.style.background = valorInicial;

      const texto = document.createElement('span');
      texto.textContent = etiqueta;
      boton.append(muestra, texto);

      const menu = document.createElement('div');
      menu.className = 'dropdown-menu color-palette-menu shadow';
      const grilla = document.createElement('div');
      grilla.className = 'color-grid';

      SIG_CONFIG.paletaColores.forEach(color => {
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
        });
        grilla.appendChild(opcion);
      });

      menu.appendChild(grilla);
      contenedor.append(boton, menu);
      return contenedor;
    }

    // Crea selector de opacidad para capas GeoJSON.
    function crearSelectorOpacidad(capaConfig) {
      const select = document.createElement('select');
      select.className = 'form-select';
      select.id = `opacidad-${capaConfig.id}`;
      for (let valor = 0; valor <= 100; valor += 10) {
        const option = document.createElement('option');
        option.value = String(valor / 100);
        option.textContent = `${valor}%`;
        if (Number(option.value) === Number(capaConfig.opacidad)) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', async () => {
        capaConfig.opacidad = Number(select.value);
        await actualizarEstiloCapa(capaConfig);
      });
      return select;
    }

    // Crea selector de grosor de línea para capas GeoJSON.
    function crearSelectorGrosor(capaConfig) {
      const select = document.createElement('select');
      select.className = 'form-select';
      select.id = `grosor-${capaConfig.id}`;
      for (let valor = 0; valor <= 10; valor += 1) {
        const option = document.createElement('option');
        option.value = String(valor);
        option.textContent = String(valor);
        if (Number(option.value) === Number(capaConfig.grosorLinea)) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', async () => {
        capaConfig.grosorLinea = Number(select.value);
        await actualizarEstiloCapa(capaConfig);
      });
      return select;
    }

    // Crea selector de pane o posición visual de capa.
    function crearSelectorPane(capaConfig) {
      const select = document.createElement('select');
      select.className = 'form-select';
      select.id = `pane-${capaConfig.id}`;
      SIG_CONFIG.panes.forEach(pane => {
        const option = document.createElement('option');
        option.value = pane.id;
        option.textContent = pane.nombre;
        if (pane.id === capaConfig.pane) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', async () => {
        capaConfig.pane = select.value;
        await actualizarEstiloCapa(capaConfig, true);
      });
      return select;
    }

    // Construye el bloque de configuración plegable de una capa.
    function crearPanelConfiguracionCapa(capaConfig) {
      const cuerpo = document.createElement('div');
      cuerpo.className = 'layer-settings';

      const colorCapa = crearSelectorColor({
        id: `color-capa-${capaConfig.id}`,
        etiqueta: 'Color de capa',
        valorInicial: capaConfig.colorCapa,
        onChange: async color => { capaConfig.colorCapa = color; await actualizarEstiloCapa(capaConfig); }
      });

      const colorLinea = crearSelectorColor({
        id: `color-linea-${capaConfig.id}`,
        etiqueta: 'Color de línea',
        valorInicial: capaConfig.colorLinea,
        onChange: async color => { capaConfig.colorLinea = color; await actualizarEstiloCapa(capaConfig); }
      });

      cuerpo.innerHTML = `
        <div class="d-flex flex-column gap-3">
          <div data-slot="color-capa"></div>
          <div data-slot="color-linea"></div>
          <div><label class="form-label fw-semibold mb-1" for="opacidad-${capaConfig.id}"><i class="bi bi-droplet-half me-1"></i>Opacidad / transparencia</label><div data-slot="opacidad"></div></div>
          <div><label class="form-label fw-semibold mb-1" for="grosor-${capaConfig.id}"><i class="bi bi-rulers me-1"></i>Grosor de línea</label><div data-slot="grosor"></div></div>
          <div><label class="form-label fw-semibold mb-1" for="pane-${capaConfig.id}"><i class="bi bi-list-ol me-1"></i>Posición de capa</label><div data-slot="pane"></div></div>
        </div>`;

      cuerpo.querySelector('[data-slot="color-capa"]').appendChild(colorCapa);
      cuerpo.querySelector('[data-slot="color-linea"]').appendChild(colorLinea);
      cuerpo.querySelector('[data-slot="opacidad"]').appendChild(crearSelectorOpacidad(capaConfig));
      cuerpo.querySelector('[data-slot="grosor"]').appendChild(crearSelectorGrosor(capaConfig));
      cuerpo.querySelector('[data-slot="pane"]').appendChild(crearSelectorPane(capaConfig));
      return cuerpo;
    }

    // Crea una fila de capa con check y botón de configuración.
    function crearItemCapa(capaConfig) {
      const item = document.createElement('div');
      item.className = 'layer-item';
      const collapseId = `config-${capaConfig.id}`;

      const encabezado = document.createElement('div');
      encabezado.className = 'layer-header';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'form-check-input m-0';
      check.id = `check-${capaConfig.id}`;
      check.checked = Boolean(capaConfig.activa);

      const dot = document.createElement('span');
      dot.className = 'layer-color-dot';
      dot.id = `dot-${capaConfig.id}`;
      dot.style.background = capaConfig.colorCapa;

      const label = document.createElement('label');
      label.className = 'form-check-label flex-grow-1 fw-semibold';
      label.setAttribute('for', check.id);
      label.textContent = capaConfig.nombre;

      const botonConfig = document.createElement('button');
      botonConfig.type = 'button';
      botonConfig.className = 'btn btn-outline-secondary btn-sm rounded-circle';
      botonConfig.setAttribute('data-bs-toggle', 'collapse');
      botonConfig.setAttribute('data-bs-target', `#${collapseId}`);
      botonConfig.title = 'Configurar capa';
      botonConfig.innerHTML = '<i class="bi bi-gear"></i>';

      check.addEventListener('change', async () => {
        if (check.checked) await activarCapa(capaConfig);
        else desactivarCapa(capaConfig);
      });

      encabezado.append(check, dot, label, botonConfig);
      const collapse = document.createElement('div');
      collapse.className = 'collapse';
      collapse.id = collapseId;
      collapse.appendChild(crearPanelConfiguracionCapa(capaConfig));
      item.append(encabezado, collapse);
      return item;
    }



    // ----------------- DEPARTAMENTOS DESTACADOS -----------------
    // Capa independiente para resaltar uno o varios departamentos sin alterar la capa base.
    function obtenerConfigDepartamentosDestacados() {
      return SIG_CONFIG.capas.find(capa => capa.id === 'departamentos') || null;
    }

    function asegurarEstadoDepartamentosDestacados() {
      if (!SIG_STATE.departamentosDestacados) {
        SIG_STATE.departamentosDestacados = {
          cargado: false,
          disponibles: [],
          featurePorKey: new Map(),
          seleccionados: new Map(),
          grupo: null
        };
      }
      return SIG_STATE.departamentosDestacados;
    }

    function asegurarPaneDepartamentosDestacados() {
      if (!SIG_STATE.mapa) return;
      const pane = SIG_STATE.mapa.getPane('paneDepartamentosSeleccionados') || SIG_STATE.mapa.createPane('paneDepartamentosSeleccionados');
      pane.style.zIndex = '900';
      pane.style.pointerEvents = 'auto';
    }

    function obtenerKeyDepartamentoDestacado(nombre) {
      return normTxtLocal(nombre).replace(/[^a-z0-9]/g, '');
    }

    function actualizarEstadoDepartamentosDestacados(texto) {
      const nodo = qs('estadoDepartamentosDestacados');
      if (nodo) nodo.textContent = texto;
    }

    function actualizarResumenDepartamentosDestacados() {
      const estado = asegurarEstadoDepartamentosDestacados();
      const resumen = qs('resumenDepartamentosDestacados');
      if (!resumen) return;
      resumen.innerHTML = `
        <div class="deptos-destacados-stat"><div class="value">${estado.disponibles.length}</div><div class="label">Disponibles</div></div>
        <div class="deptos-destacados-stat"><div class="value">${estado.seleccionados.size}</div><div class="label">En mapa</div></div>`;
    }

    function obtenerEstiloDepartamentoDestacado() {
      return {
        pane: 'paneDepartamentosSeleccionados',
        color: '#4b004b',
        weight: 3,
        opacity: 1,
        fillColor: '#facc15',
        fillOpacity: 0.48,
        dashArray: '',
        lineCap: 'round',
        lineJoin: 'round'
      };
    }

    function crearPopupDepartamentoDestacado(feature) {
      const nombre = obtenerNombreDepartamentoFeature(feature) || 'Departamento';
      return `<div style="min-width:220px; max-width:420px">
        <div class="fw-bold mb-2"><span class="depto-destacado-dot"></span>${escapeHtml(nombre)}</div>
        <div class="text-muted small">Departamento destacado en capa superior independiente.</div>
      </div>`;
    }

    function crearCapaDepartamentoDestacado(feature) {
      asegurarPaneDepartamentosDestacados();
      const estilo = obtenerEstiloDepartamentoDestacado();
      return L.geoJSON(feature, {
        pane: 'paneDepartamentosSeleccionados',
        interactive: true,
        bubblingMouseEvents: false,
        style: () => estilo,
        onEachFeature: (feat, layer) => {
          layer.bindPopup(() => crearPopupDepartamentoDestacado(feat), {
            pane: 'panePopupsTop',
            maxWidth: 420,
            autoPan: true
          });
          layer.on('click', event => {
            SIG_STATE.ultimoClickCapaMs = Date.now();
            if (event?.originalEvent) {
              L.DomEvent.stopPropagation(event.originalEvent);
              L.DomEvent.preventDefault(event.originalEvent);
            }
            layer.openPopup(event?.latlng);
          });
          layer.on('mouseover', () => {
            if (layer.setStyle) layer.setStyle({ weight: 4, fillOpacity: 0.62 });
            if (layer.bringToFront) layer.bringToFront();
          });
          layer.on('mouseout', () => {
            if (layer.setStyle) layer.setStyle(estilo);
          });
        }
      });
    }

    async function cargarDepartamentosDestacados() {
      const estado = asegurarEstadoDepartamentosDestacados();
      if (estado.cargado) return estado;
      const capaConfig = obtenerConfigDepartamentosDestacados();
      if (!capaConfig) {
        actualizarEstadoDepartamentosDestacados('No se encontró la configuración de la capa Departamentos.');
        return estado;
      }

      actualizarEstadoDepartamentosDestacados('Cargando listado de departamentos…');
      const geojson = await cargarGeoJSON(capaConfig);
      const features = Array.isArray(geojson?.features) ? geojson.features : [];
      const vistos = new Set();
      estado.disponibles = [];
      estado.featurePorKey = new Map();

      features.forEach(feature => {
        const nombre = String(obtenerNombreDepartamentoFeature(feature) || '').trim();
        const key = obtenerKeyDepartamentoDestacado(nombre);
        if (!nombre || !key || vistos.has(key)) return;
        vistos.add(key);
        const item = { key, nombre, feature };
        estado.disponibles.push(item);
        estado.featurePorKey.set(key, item);
      });

      estado.disponibles.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      estado.cargado = true;
      renderizarDepartamentosDestacadosDisponibles();
      renderizarDepartamentosDestacadosSeleccionados();
      actualizarResumenDepartamentosDestacados();
      actualizarEstadoDepartamentosDestacados(`${estado.disponibles.length} departamentos disponibles. Agrega uno o varios para verlos sobre el mapa.`);
      return estado;
    }

    function renderizarSelectDepartamentosDestacados(lista) {
      const select = qs('selectDepartamentoDestacado');
      if (!select) return;
      const estado = asegurarEstadoDepartamentosDestacados();
      const base = Array.isArray(lista) ? lista : estado.disponibles;
      select.innerHTML = '<option value="">— Selecciona departamento —</option>' + base.map(item =>
        `<option value="${escapeHtml(item.key)}">${escapeHtml(item.nombre)}</option>`
      ).join('');
    }

    function renderizarDepartamentosDestacadosDisponibles() {
      const estado = asegurarEstadoDepartamentosDestacados();
      const contenedor = qs('listaDepartamentosDestacadosDisponibles');
      const busqueda = normTxtLocal(qs('buscarDepartamentoDestacado')?.value || '');
      const filtrados = estado.disponibles.filter(item => !busqueda || normTxtLocal(item.nombre).includes(busqueda));

      renderizarSelectDepartamentosDestacados(filtrados);
      if (!contenedor) return;
      contenedor.innerHTML = '';

      if (!filtrados.length) {
        contenedor.innerHTML = '<div class="text-muted small">No hay departamentos con ese criterio.</div>';
        return;
      }

      filtrados.forEach(item => {
        const yaAgregado = estado.seleccionados.has(item.key);
        const row = document.createElement('div');
        row.className = 'depto-destacado-item';
        row.innerHTML = `
          <div>
            <div class="depto-destacado-title"><span class="depto-destacado-dot"></span>${escapeHtml(item.nombre)}</div>
            <div class="depto-destacado-meta">${yaAgregado ? 'Agregado al mapa' : 'Disponible para agregar'}</div>
          </div>
          <div class="depto-destacado-actions">
            <button class="btn btn-sm ${yaAgregado ? 'btn-outline-secondary' : 'btn-outline-primary'}" type="button" data-accion="agregar" ${yaAgregado ? 'disabled' : ''}>
              <i class="bi bi-plus-lg"></i>
            </button>
          </div>`;
        row.querySelector('[data-accion="agregar"]')?.addEventListener('click', () => agregarDepartamentoDestacado(item.key, { ajustar: true }));
        contenedor.appendChild(row);
      });
    }

    function renderizarDepartamentosDestacadosSeleccionados() {
      const estado = asegurarEstadoDepartamentosDestacados();
      const contenedor = qs('listaDepartamentosDestacadosSeleccionados');
      if (!contenedor) return;
      contenedor.innerHTML = '';

      if (!estado.seleccionados.size) {
        contenedor.innerHTML = '<div class="text-muted small">— Sin departamentos seleccionados —</div>';
        actualizarResumenDepartamentosDestacados();
        return;
      }

      Array.from(estado.seleccionados.values())
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
        .forEach(item => {
          const row = document.createElement('div');
          row.className = 'depto-destacado-item';
          row.innerHTML = `
            <div>
              <div class="depto-destacado-title"><span class="depto-destacado-dot"></span>${escapeHtml(item.nombre)}</div>
              <div class="depto-destacado-meta">Polígono activo en capa superior</div>
            </div>
            <div class="depto-destacado-actions">
              <button class="btn btn-sm btn-outline-secondary" type="button" data-accion="zoom"><i class="bi bi-arrows-fullscreen"></i></button>
              <button class="btn btn-sm btn-outline-danger" type="button" data-accion="quitar"><i class="bi bi-x-lg"></i></button>
            </div>`;
          row.querySelector('[data-accion="zoom"]')?.addEventListener('click', () => ajustarDepartamentoDestacado(item.key));
          row.querySelector('[data-accion="quitar"]')?.addEventListener('click', () => quitarDepartamentoDestacado(item.key));
          contenedor.appendChild(row);
        });
      actualizarResumenDepartamentosDestacados();
    }

    function agregarDepartamentoDestacado(key, opciones = {}) {
      const estado = asegurarEstadoDepartamentosDestacados();
      if (!key) key = qs('selectDepartamentoDestacado')?.value || '';
      const item = estado.featurePorKey.get(key);
      if (!item) {
        actualizarEstadoDepartamentosDestacados('Selecciona un departamento válido.');
        return;
      }
      if (estado.seleccionados.has(key)) {
        actualizarEstadoDepartamentosDestacados(`${item.nombre} ya está agregado.`);
        return;
      }

      if (!estado.grupo) {
        asegurarPaneDepartamentosDestacados();
        estado.grupo = L.layerGroup().addTo(SIG_STATE.mapa);
      }

      const capa = crearCapaDepartamentoDestacado(item.feature).addTo(estado.grupo);
      estado.seleccionados.set(key, { ...item, capa });
      renderizarDepartamentosDestacadosSeleccionados();
      renderizarDepartamentosDestacadosDisponibles();
      actualizarEstadoDepartamentosDestacados(`${item.nombre} agregado al mapa.`);
      if (opciones.ajustar) ajustarDepartamentoDestacado(key);
    }

    function quitarDepartamentoDestacado(key) {
      const estado = asegurarEstadoDepartamentosDestacados();
      const item = estado.seleccionados.get(key);
      if (!item) return;
      if (estado.grupo && item.capa) estado.grupo.removeLayer(item.capa);
      estado.seleccionados.delete(key);
      renderizarDepartamentosDestacadosSeleccionados();
      renderizarDepartamentosDestacadosDisponibles();
      actualizarEstadoDepartamentosDestacados(`${item.nombre} quitado del mapa.`);
    }

    function limpiarDepartamentosDestacados() {
      const estado = asegurarEstadoDepartamentosDestacados();
      if (estado.grupo) estado.grupo.clearLayers();
      estado.seleccionados.clear();
      renderizarDepartamentosDestacadosSeleccionados();
      renderizarDepartamentosDestacadosDisponibles();
      actualizarEstadoDepartamentosDestacados('Se limpiaron los departamentos destacados del mapa.');
    }

    function obtenerBoundsDepartamentosDestacados(keys = null) {
      const estado = asegurarEstadoDepartamentosDestacados();
      let bounds = null;
      const items = keys ? keys.map(key => estado.seleccionados.get(key)).filter(Boolean) : Array.from(estado.seleccionados.values());
      items.forEach(item => {
        if (!item?.capa?.getBounds) return;
        const b = item.capa.getBounds();
        if (!b?.isValid?.()) return;
        bounds = bounds ? bounds.extend(b) : b;
      });
      return bounds;
    }

    function ajustarDepartamentoDestacado(key) {
      const bounds = obtenerBoundsDepartamentosDestacados([key]);
      if (bounds && SIG_STATE.mapa) SIG_STATE.mapa.fitBounds(bounds.pad(0.08), { maxZoom: 9 });
    }

    function ajustarDepartamentosDestacados() {
      const bounds = obtenerBoundsDepartamentosDestacados();
      if (bounds && SIG_STATE.mapa) {
        SIG_STATE.mapa.fitBounds(bounds.pad(0.08), { maxZoom: 8 });
      } else {
        actualizarEstadoDepartamentosDestacados('No hay departamentos destacados para ajustar.');
      }
    }

    async function inicializarDepartamentosDestacados() {
      asegurarPaneDepartamentosDestacados();
      const estado = asegurarEstadoDepartamentosDestacados();
      estado.grupo = estado.grupo || L.layerGroup().addTo(SIG_STATE.mapa);

      qs('btnAgregarDepartamentoDestacado')?.addEventListener('click', () => agregarDepartamentoDestacado(null, { ajustar: true }));
      qs('btnLimpiarDepartamentosDestacados')?.addEventListener('click', () => limpiarDepartamentosDestacados());
      qs('btnAjustarDepartamentosDestacados')?.addEventListener('click', () => ajustarDepartamentosDestacados());
      qs('buscarDepartamentoDestacado')?.addEventListener('input', () => renderizarDepartamentosDestacadosDisponibles());
      qs('panelDepartamentosDestacados')?.addEventListener('shown.bs.offcanvas', async () => {
        await cargarDepartamentosDestacados();
        SIG_STATE.mapa?.invalidateSize();
      });

      await cargarDepartamentosDestacados();
    }

    // ----------------- MACROREGIONES DESTACADAS -----------------
    function asegurarEstadoMacroregionesDestacadas() {
      if (!SIG_STATE.macroregionesDestacadas) {
        SIG_STATE.macroregionesDestacadas = {
          disponibles: [],
          geojsonPorKey: new Map(),
          seleccionados: new Map(),
          grupo: null,
          cargado: false
        };
      }
      return SIG_STATE.macroregionesDestacadas;
    }

    function asegurarPaneMacroregionesDestacadas() {
      if (!SIG_STATE.mapa) return null;
      const pane = SIG_STATE.mapa.getPane('paneMacroregionesSeleccionadas') || SIG_STATE.mapa.createPane('paneMacroregionesSeleccionadas');
      pane.style.zIndex = '920';
      pane.style.pointerEvents = 'auto';
      return pane;
    }

    function obtenerKeyMacroregionDestacada(nombre) {
      return normTxtLocal(nombre).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    function actualizarEstadoMacroregionesDestacadas(texto) {
      const nodo = qs('estadoMacroregionesDestacadas');
      if (nodo) nodo.textContent = texto || '';
    }

    function actualizarResumenMacroregionesDestacadas() {
      const estado = asegurarEstadoMacroregionesDestacadas();
      const resumen = qs('resumenMacroregionesDestacadas');
      if (!resumen) return;
      resumen.innerHTML = `
        <div class="deptos-destacados-stat"><div class="value">${estado.disponibles.length}</div><div class="label">Disponibles</div></div>
        <div class="deptos-destacados-stat"><div class="value">${estado.seleccionados.size}</div><div class="label">En mapa</div></div>`;
    }

    function obtenerConfigMacroregionesDestacadas() {
      return Array.isArray(SIG_CONFIG.macroregionesDestacadas) ? SIG_CONFIG.macroregionesDestacadas : [];
    }

    function obtenerEstiloMacroregionDestacada(item) {
      return {
        pane: 'paneMacroregionesSeleccionadas',
        color: item?.colorLinea || '#1d4ed8',
        weight: 3,
        opacity: 1,
        fillColor: item?.colorCapa || '#60a5fa',
        fillOpacity: 0.34,
        dashArray: '8 5',
        lineCap: 'round',
        lineJoin: 'round'
      };
    }

    function obtenerDepartamentosMacroregionGeoJSON(geojson) {
      const features = Array.isArray(geojson?.features) ? geojson.features : [];
      const nombres = [];
      const vistos = new Set();
      features.forEach(feature => {
        const props = feature?.properties || {};
        const nombre = obtenerPropiedadFlexible(props, ['Departamen', 'DEPARTAMEN', 'DPTO_CNMBR', 'DEPARTAMENTO', 'DEPTO', 'NOMBRE', 'nombre']);
        const texto = String(nombre || '').trim();
        const key = normTxtLocal(texto);
        if (!texto || vistos.has(key)) return;
        vistos.add(key);
        nombres.push(texto);
      });
      return nombres.sort((a, b) => a.localeCompare(b, 'es'));
    }

    function crearPopupMacroregionDestacada(item, geojson) {
      const departamentos = obtenerDepartamentosMacroregionGeoJSON(geojson);
      const listado = departamentos.length ? departamentos.slice(0, 18).map(x => `<span class="badge text-bg-light border me-1 mb-1">${escapeHtml(x)}</span>`).join('') : '<span class="text-muted small">Sin departamentos listados.</span>';
      const extra = departamentos.length > 18 ? `<div class="text-muted small mt-1">+ ${departamentos.length - 18} departamentos adicionales</div>` : '';
      return `<div style="min-width:260px; max-width:430px">
        <div class="fw-bold mb-1"><span class="macro-destacado-dot" style="background:${escapeHtml(item.colorCapa || '#60a5fa')}; border-color:${escapeHtml(item.colorLinea || '#1d4ed8')}"></span>${escapeHtml(item.nombre)}</div>
        <div class="text-muted small mb-2">Macroregión destacada · ${departamentos.length} departamento(s)</div>
        <div>${listado}</div>${extra}
      </div>`;
    }

    function crearCapaMacroregionDestacada(item, geojson) {
      asegurarPaneMacroregionesDestacadas();
      const estilo = obtenerEstiloMacroregionDestacada(item);
      return L.geoJSON(geojson, {
        pane: 'paneMacroregionesSeleccionadas',
        interactive: true,
        bubblingMouseEvents: false,
        style: () => estilo,
        onEachFeature: (feature, layer) => {
          layer.bindPopup(() => crearPopupMacroregionDestacada(item, geojson), {
            pane: 'panePopupsTop',
            maxWidth: 460,
            minWidth: 300,
            autoPan: true,
            closeButton: true
          });
          layer.on('mouseover', () => {
            if (layer.setStyle) layer.setStyle({ weight: 5, opacity: 1, fillOpacity: 0.45 });
            if (layer.bringToFront) layer.bringToFront();
          });
          layer.on('mouseout', () => {
            if (layer.setStyle) layer.setStyle(estilo);
          });
          layer.on('click', event => {
            if (event?.originalEvent) {
              L.DomEvent.stopPropagation(event.originalEvent);
              L.DomEvent.preventDefault(event.originalEvent);
            }
          });
        }
      });
    }

    async function cargarMacroregionGeoJSON(item) {
      const estado = asegurarEstadoMacroregionesDestacadas();
      if (estado.geojsonPorKey.has(item.key)) return estado.geojsonPorKey.get(item.key);
      const respuesta = await fetch(item.archivo);
      if (!respuesta.ok) throw new Error(`No se pudo cargar ${item.archivo}`);
      const geojson = await respuesta.json();
      estado.geojsonPorKey.set(item.key, geojson);
      return geojson;
    }

    async function cargarMacroregionesDestacadas() {
      const estado = asegurarEstadoMacroregionesDestacadas();
      const configs = obtenerConfigMacroregionesDestacadas();
      if (!configs.length) {
        actualizarEstadoMacroregionesDestacadas('No hay macroregiones configuradas en configlayers.js.');
        return estado;
      }

      estado.disponibles = configs.map(cfg => ({
        ...cfg,
        key: cfg.id || obtenerKeyMacroregionDestacada(cfg.nombre)
      })).filter(item => item.key && item.nombre && item.archivo);
      estado.disponibles.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      estado.cargado = true;
      renderizarMacroregionesDestacadasDisponibles();
      renderizarMacroregionesDestacadasSeleccionadas();
      actualizarResumenMacroregionesDestacadas();
      actualizarEstadoMacroregionesDestacadas(`${estado.disponibles.length} macroregiones disponibles. Agrega una o varias para verlas sobre el mapa.`);
      return estado;
    }

    function renderizarSelectMacroregionesDestacadas(lista) {
      const select = qs('selectMacroregionDestacada');
      if (!select) return;
      const estado = asegurarEstadoMacroregionesDestacadas();
      const base = Array.isArray(lista) ? lista : estado.disponibles;
      select.innerHTML = '<option value="">— Selecciona macroregión —</option>' + base.map(item =>
        `<option value="${escapeHtml(item.key)}">${escapeHtml(item.nombre)}</option>`
      ).join('');
    }

    function renderizarMacroregionesDestacadasDisponibles() {
      const estado = asegurarEstadoMacroregionesDestacadas();
      const contenedor = qs('listaMacroregionesDestacadasDisponibles');
      const busqueda = normTxtLocal(qs('buscarMacroregionDestacada')?.value || '');
      const filtrados = estado.disponibles.filter(item => !busqueda || normTxtLocal(item.nombre).includes(busqueda));

      renderizarSelectMacroregionesDestacadas(filtrados);
      if (!contenedor) return;
      contenedor.innerHTML = '';

      if (!filtrados.length) {
        contenedor.innerHTML = '<div class="text-muted small">No hay macroregiones con ese criterio.</div>';
        return;
      }

      filtrados.forEach(item => {
        const yaAgregado = estado.seleccionados.has(item.key);
        const row = document.createElement('div');
        row.className = 'macro-destacado-item';
        row.innerHTML = `
          <div>
            <div class="macro-destacado-title"><span class="macro-destacado-dot" style="background:${escapeHtml(item.colorCapa || '#60a5fa')}; border-color:${escapeHtml(item.colorLinea || '#1d4ed8')}"></span>${escapeHtml(item.nombre)}</div>
            <div class="macro-destacado-meta">${yaAgregado ? 'Agregada al mapa' : 'Disponible para agregar'}</div>
          </div>
          <div class="macro-destacado-actions">
            <button class="btn btn-sm ${yaAgregado ? 'btn-outline-secondary' : 'btn-outline-primary'}" type="button" data-accion="agregar" ${yaAgregado ? 'disabled' : ''}>
              <i class="bi bi-plus-lg"></i>
            </button>
          </div>`;
        row.querySelector('[data-accion="agregar"]')?.addEventListener('click', () => agregarMacroregionDestacada(item.key, { ajustar: true }));
        contenedor.appendChild(row);
      });
    }

    function renderizarMacroregionesDestacadasSeleccionadas() {
      const estado = asegurarEstadoMacroregionesDestacadas();
      const contenedor = qs('listaMacroregionesDestacadasSeleccionadas');
      if (!contenedor) return;
      contenedor.innerHTML = '';

      if (!estado.seleccionados.size) {
        contenedor.innerHTML = '<div class="text-muted small">— Sin macroregiones seleccionadas —</div>';
        actualizarResumenMacroregionesDestacadas();
        return;
      }

      Array.from(estado.seleccionados.values())
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
        .forEach(item => {
          const row = document.createElement('div');
          row.className = 'macro-destacado-item';
          row.innerHTML = `
            <div>
              <div class="macro-destacado-title"><span class="macro-destacado-dot" style="background:${escapeHtml(item.colorCapa || '#60a5fa')}; border-color:${escapeHtml(item.colorLinea || '#1d4ed8')}"></span>${escapeHtml(item.nombre)}</div>
              <div class="macro-destacado-meta">Polígono activo en capa superior</div>
            </div>
            <div class="macro-destacado-actions">
              <button class="btn btn-sm btn-outline-secondary" type="button" data-accion="zoom"><i class="bi bi-arrows-fullscreen"></i></button>
              <button class="btn btn-sm btn-outline-danger" type="button" data-accion="quitar"><i class="bi bi-x-lg"></i></button>
            </div>`;
          row.querySelector('[data-accion="zoom"]')?.addEventListener('click', () => ajustarMacroregionDestacada(item.key));
          row.querySelector('[data-accion="quitar"]')?.addEventListener('click', () => quitarMacroregionDestacada(item.key));
          contenedor.appendChild(row);
        });
      actualizarResumenMacroregionesDestacadas();
    }

    async function agregarMacroregionDestacada(key, opciones = {}) {
      const estado = asegurarEstadoMacroregionesDestacadas();
      if (!key) key = qs('selectMacroregionDestacada')?.value || '';
      const item = estado.disponibles.find(x => String(x.key) === String(key));
      if (!item) {
        actualizarEstadoMacroregionesDestacadas('Selecciona una macroregión válida.');
        return;
      }
      if (estado.seleccionados.has(key)) {
        actualizarEstadoMacroregionesDestacadas(`${item.nombre} ya está agregada.`);
        return;
      }

      if (!estado.grupo) {
        asegurarPaneMacroregionesDestacadas();
        estado.grupo = L.layerGroup().addTo(SIG_STATE.mapa);
      }

      try {
        actualizarEstadoMacroregionesDestacadas(`Cargando ${item.nombre}…`);
        const geojson = await cargarMacroregionGeoJSON(item);
        const capa = crearCapaMacroregionDestacada(item, geojson).addTo(estado.grupo);
        estado.seleccionados.set(key, { ...item, geojson, capa });
        renderizarMacroregionesDestacadasSeleccionadas();
        renderizarMacroregionesDestacadasDisponibles();
        actualizarEstadoMacroregionesDestacadas(`${item.nombre} agregada al mapa.`);
        if (opciones.ajustar) ajustarMacroregionDestacada(key);
      } catch (error) {
        console.error('agregarMacroregionDestacada', error);
        actualizarEstadoMacroregionesDestacadas(`No se pudo cargar ${item.nombre}. Revisa que exista ${item.archivo}.`);
      }
    }

    function quitarMacroregionDestacada(key) {
      const estado = asegurarEstadoMacroregionesDestacadas();
      const item = estado.seleccionados.get(key);
      if (!item) return;
      if (estado.grupo && item.capa) estado.grupo.removeLayer(item.capa);
      estado.seleccionados.delete(key);
      renderizarMacroregionesDestacadasSeleccionadas();
      renderizarMacroregionesDestacadasDisponibles();
      actualizarEstadoMacroregionesDestacadas(`${item.nombre} quitada del mapa.`);
    }

    function limpiarMacroregionesDestacadas() {
      const estado = asegurarEstadoMacroregionesDestacadas();
      if (estado.grupo) estado.grupo.clearLayers();
      estado.seleccionados.clear();
      renderizarMacroregionesDestacadasSeleccionadas();
      renderizarMacroregionesDestacadasDisponibles();
      actualizarEstadoMacroregionesDestacadas('Se limpiaron las macroregiones destacadas del mapa.');
    }

    function obtenerBoundsMacroregionesDestacadas(keys = null) {
      const estado = asegurarEstadoMacroregionesDestacadas();
      let bounds = null;
      const items = keys ? keys.map(key => estado.seleccionados.get(key)).filter(Boolean) : Array.from(estado.seleccionados.values());
      items.forEach(item => {
        if (!item?.capa?.getBounds) return;
        const b = item.capa.getBounds();
        if (!b?.isValid?.()) return;
        bounds = bounds ? bounds.extend(b) : b;
      });
      return bounds;
    }

    function ajustarMacroregionDestacada(key) {
      const bounds = obtenerBoundsMacroregionesDestacadas([key]);
      if (bounds && SIG_STATE.mapa) SIG_STATE.mapa.fitBounds(bounds.pad(0.08), { maxZoom: 8 });
    }

    function ajustarMacroregionesDestacadas() {
      const bounds = obtenerBoundsMacroregionesDestacadas();
      if (bounds && SIG_STATE.mapa) {
        SIG_STATE.mapa.fitBounds(bounds.pad(0.08), { maxZoom: 7 });
      } else {
        actualizarEstadoMacroregionesDestacadas('No hay macroregiones destacadas para ajustar.');
      }
    }

    async function inicializarMacroregionesDestacadas() {
      asegurarPaneMacroregionesDestacadas();
      const estado = asegurarEstadoMacroregionesDestacadas();
      estado.grupo = estado.grupo || L.layerGroup().addTo(SIG_STATE.mapa);

      qs('btnAgregarMacroregionDestacada')?.addEventListener('click', () => agregarMacroregionDestacada(null, { ajustar: true }));
      qs('btnLimpiarMacroregionesDestacadas')?.addEventListener('click', () => limpiarMacroregionesDestacadas());
      qs('btnAjustarMacroregionesDestacadas')?.addEventListener('click', () => ajustarMacroregionesDestacadas());
      qs('buscarMacroregionDestacada')?.addEventListener('input', () => renderizarMacroregionesDestacadasDisponibles());
      qs('panelMacroregionesDestacadas')?.addEventListener('shown.bs.offcanvas', async () => {
        await cargarMacroregionesDestacadas();
        SIG_STATE.mapa?.invalidateSize();
      });

      await cargarMacroregionesDestacadas();
    }

    // Construye el panel lateral de capas desde configlayers.js.
    function renderizarPanelCapas() {
      const lista = qs('listaCapas');
      if (!lista) return;
      lista.innerHTML = '';
      SIG_CONFIG.capas.forEach(capaConfig => lista.appendChild(crearItemCapa(capaConfig)));
    }

    // Control de zoom con incrementos pequeños.
    function crearControlZoomSuave(pasoZoom) {
      const control = L.control({ position: 'bottomright' });
      control.onAdd = function (mapa) {
        const contenedor = L.DomUtil.create('div', 'leaflet-control-zoom leaflet-bar leaflet-control');
        const btnAcercar = L.DomUtil.create('a', 'leaflet-control-zoom-in', contenedor);
        btnAcercar.href = '#';
        btnAcercar.title = 'Acercar suavemente';
        btnAcercar.innerHTML = '<span aria-hidden="true">+</span>';
        const btnAlejar = L.DomUtil.create('a', 'leaflet-control-zoom-out', contenedor);
        btnAlejar.href = '#';
        btnAlejar.title = 'Alejar suavemente';
        btnAlejar.innerHTML = '<span aria-hidden="true">−</span>';
        L.DomEvent.disableClickPropagation(contenedor);
        L.DomEvent.disableScrollPropagation(contenedor);
        L.DomEvent.on(btnAcercar, 'click', L.DomEvent.stop).on(btnAcercar, 'click', () => mapa.setZoom(mapa.getZoom() + Number(pasoZoom || 0.25)));
        L.DomEvent.on(btnAlejar, 'click', L.DomEvent.stop).on(btnAlejar, 'click', () => mapa.setZoom(mapa.getZoom() - Number(pasoZoom || 0.25)));
        return contenedor;
      };
      return control;
    }

    // Inicializa mapa, panes, capas y módulo externo de filtros.
    document.addEventListener('DOMContentLoaded', async () => {
      if (!window.SIG_CONFIG) {
        mostrarAvisoCapas('danger', 'No cargó configlayers.js.');
        return;
      }

      const mapa = L.map('mapaSIG', {
        zoomControl: false,
        preferCanvas: true,
        minZoom: SIG_CONFIG.mapa.zoomMinimo,
        maxZoom: SIG_CONFIG.mapa.zoomMaximo,
        zoomSnap: SIG_CONFIG.mapa.zoomSnap || 0.25,
        zoomDelta: SIG_CONFIG.mapa.pasoZoom || 0.25,
        wheelPxPerZoomLevel: SIG_CONFIG.mapa.ruedaZoomSensibilidad || 180
      }).setView(SIG_CONFIG.mapa.centro, SIG_CONFIG.mapa.zoom);

      SIG_STATE.mapa = mapa;
      crearPanesLeaflet(mapa);
      SIG_STATE.capaCasos = L.layerGroup().addTo(mapa);
      crearControlZoomSuave(SIG_CONFIG.mapa.pasoZoom || 0.25).addTo(mapa);
      mapa.on('click', abrirPopupDepartamentoFallback);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(mapa);

      renderizarPanelCapas();
      await inicializarDepartamentosDestacados();
      await inicializarMacroregionesDestacadas();
      for (const capaConfig of SIG_CONFIG.capas.filter(capa => capa.activa)) {
        await activarCapa(capaConfig);
      }

      if (window.SIG_DATOS?.inicializar) {
        await window.SIG_DATOS.inicializar();
      }

      qs('btnAbrirMapaCalor')?.addEventListener('click', () => {
        window.setTimeout(() => {
          const target = qs('bloqueMapaCalorSIG');
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 350);
      });

      window.addEventListener('resize', () => mapa.invalidateSize());
      qs('panelCapas')?.addEventListener('hidden.bs.offcanvas', () => mapa.invalidateSize());
      qs('panelFiltros')?.addEventListener('hidden.bs.offcanvas', () => mapa.invalidateSize());
      qs('panelDepartamentosDestacados')?.addEventListener('hidden.bs.offcanvas', () => mapa.invalidateSize());
    });
  