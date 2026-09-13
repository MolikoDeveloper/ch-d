# Modelo de datos

## Principio

No guardar sólo agregados. El sistema conserva unidades mínimas observables:

- `source_records`: fila original de cualquier CSV/XLSX/JSON todavía no interpretado.
- `transactions`: actos con identidad propia (orden de compra, transferencia, pago, aporte, gasto electoral, etc.).
- `projects`: proyectos de ley, inversión, programas u otras unidades de trabajo.
- `observations`: mediciones (IPC, desempleo, participación, población, etc.).
- `relationships`: vínculos explícitos entre entidades, siempre con fuente/procedencia.
- `raw_snapshots`: bytes originales descargados y hash SHA-256.

Una visualización agregada se calcula desde estas tablas; nunca sustituye los registros base.
