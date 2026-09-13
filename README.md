# Chile Transparente

Plataforma experimental de datos públicos chilenos, construida con Bun + TypeScript + SQLite.

La regla del proyecto es **dato transaccional primero**: se conserva cada registro individual y su procedencia. Los dashboards son vistas derivadas, no la fuente de verdad.

## Inicio

```bash
bun install
cp .env.example .env
bun run db:init
bun run dev
```

Abre `http://localhost:3000`.

## Sincronización

```bash
# catálogo CKAN de datos.gob.cl
bun run sync:datos

# descargar y almacenar fila por fila un recurso descubierto
bun src/cli/index.ts sync datos-resource --id=<resource-id>

# descarga masiva reanudable de recursos estructurados
bun run sync:datos:resources

# órdenes de compra de Mercado Público (requiere CHILECOMPRA_TICKET)
bun run sync:chilecompra -- --from=2026-09-01 --to=2026-09-13

# Banco Central (requiere BCCH_API_KEY y BCCH_USER_EMAIL)
bun run sync:bcentral
```

## Filosofía de ingestión

1. Se descarga el material original y se guarda en `data/raw/<fuente>/...`.
2. Se calcula SHA-256 para trazabilidad.
3. Se registra un snapshot inmutable en SQLite.
4. Se normaliza sin borrar el valor original.
5. Las relaciones y métricas derivadas quedan separadas de los hechos originales.

## Credenciales

El proyecto **no incorpora identidades ni secretos**. Fuentes que requieran registro oficial se configuran en `.env`. Nunca publiques ese archivo.

## Estado

Esta versión incluye:

- Esquema SQLite normalizado y orientado a transacciones.
- Registro de fuentes públicas chilenas por dominio y formato.
- Conector CKAN `datos.gob.cl` para descubrir datasets y recursos.
- Ingestor genérico CSV/TSV/JSON/GeoJSON/XLS/XLSX/XML/ZIP que conserva cada fila individualmente en `source_records`.
- Sincronización masiva reanudable con estados por recurso.
- Conector Mercado Público para órdenes de compra diarias.
- Conector Banco Central preparado para series configuradas.
- API HTTP de consulta.
- Dashboard panel + mapa geográfico real Leaflet/OpenStreetMap.

El inventario contiene fuentes que todavía requieren adaptadores específicos. Ver `docs/SOURCES.md`.

## Ingesta masiva de Datos.gob.cl

Después de indexar el catálogo con `bun run sync:datos`, descarga y parsea automáticamente los recursos estructurados pendientes:

```bash
bun run sync:datos:resources
```

El proceso es reanudable. Cada recurso mantiene `sync_status`, último intento, último error, snapshot, SHA-256 y cantidad de registros importados. Estados: `pending`, `downloading`, `parsed`, `downloaded`, `unsupported`, `failed`.

Opciones útiles:

```bash
bun src/cli/index.ts sync datos-resources --concurrency=4
bun src/cli/index.ts sync datos-resources --limit=100
bun src/cli/index.ts sync datos-resources --retry-failed
bun src/cli/index.ts sync datos-resources --include-raw
bun src/cli/index.ts sync datos-resources --force
```

Formatos estructurados soportados: CSV/TSV/TXT, JSON/GeoJSON, XLS/XLSX, XML y ZIP que contenga archivos tabulares compatibles.

La primera ejecución completa puede descargar una cantidad importante de información. No borres `data/raw/`: es la evidencia original inmutable utilizada para auditar cada importación.

## Mapa real

El frontend utiliza Leaflet sobre cartografía OpenStreetMap y consume `/api/map/features`. Las transacciones y observaciones vinculadas a un `geo_area` con coordenadas aparecen automáticamente en el mapa.

El siguiente nivel geográfico consiste en normalizar las geometrías oficiales de INE/IDE Chile hacia `geo_areas.geometry_json`; el frontend puede dibujar esas capas GeoJSON sobre el mismo mapa sin cambiar el modelo de datos.
