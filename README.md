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

# descargar y almacenar fila por fila un recurso CSV/XLSX/JSON descubierto
bun src/cli/index.ts sync datos-resource --id=<resource-id>

# órdenes de compra de Mercado Público (requiere CHILECOMPRA_TICKET)
bun run sync:chilecompra -- --from=2026-09-01 --to=2026-09-13

# Banco Central (requiere BCCH_API_KEY y BCCH_USER_EMAIL)
bun run sync:bcentral

# todas las fuentes automáticas disponibles
bun run sync
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

Esta primera versión incluye:

- Esquema SQLite normalizado y orientado a transacciones.
- Registro de fuentes públicas chilenas por dominio y formato.
- Conector CKAN `datos.gob.cl` para descubrir datasets y recursos.
- Ingestor tabular genérico CSV/XLSX/JSON que conserva cada fila individualmente en `source_records`.
- Conector Mercado Público para órdenes de compra diarias.
- Conector Banco Central preparado para series configuradas.
- API HTTP de consulta.
- Dashboard inicial panel + mapa/territorio, con pestañas para gasto, política, proyectos y eventos.

El inventario contiene fuentes que todavía requieren adaptadores específicos. Ver `docs/SOURCES.md`.
