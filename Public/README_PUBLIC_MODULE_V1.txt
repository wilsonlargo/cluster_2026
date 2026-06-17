MÓDULO PÚBLICO · OBSERVATORIO · V1

Archivos incluidos:
- public.html
- public.js

Ubicación recomendada:
Public/public.html
Public/public.js

Rutas esperadas para capas:
Public/SIG/Layers/001tablero.geojson
Public/SIG/Layers/002basemap.geojson
Public/SIG/Layers/003departamentos.geojson
Public/SIG/Layers/004municipios.geojson

Consultas Supabase:
- casos_2026 para estadísticas públicas agregadas.
- sig_casos_public_2026 para puntos del mapa.

La vista sig_casos_public_2026 se consulta únicamente con las columnas que existen actualmente:
punto_id, caso_id, id_old, fecha_evento, anio, macrotipo, departamento, macroregion, municipio, lat, lng, pueblo, npersonas, nmujeres, nhombres, nmenores, macroactor, contextual_type.

No se consultan datos personales ni la tabla personas_2026.

Funcionalidades:
- Encabezado con casos acumulados y personas acumuladas desde 2016 hasta el año actual.
- Encabezado con casos y personas del año vigente.
- Microinforme histórico automático.
- Microinforme del año vigente automático.
- Rankings por departamento, macrotipo, macroactor y pueblo.
- Mapa único con tres modos: departamentos, municipios y puntos.
- Mapas de calor por IDR, casos o personas.
- Tabla pública territorial por departamento.
- Botón para copiar tabla en formato tabulado.

Versión base:
20260617-public-v1
