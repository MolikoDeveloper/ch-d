# Registro inicial de fuentes

La lista ejecutable vive en `src/domain/sources.ts`. Esta primera versión distingue entre **fuente registrada** y **conector implementado**. Registrar una fuente no implica que sus datos ya estén normalizados.

## Conectores automáticos implementados

- **Datos.gob.cl / CKAN**: descubre todos los datasets y recursos publicados en el catálogo, guardando metadatos y URLs de cada recurso.
- **Mercado Público / ChileCompra**: descarga órdenes de compra por fecha usando el ticket configurado en `CHILECOMPRA_TICKET` y conserva cada OC como transacción independiente.
- **Banco Central BDE**: valida configuración/credenciales y mantiene un archivo de series; el endpoint REST definitivo queda deliberadamente bloqueado hasta validarlo con una cuenta real para no inventar un contrato de API.

## Fuentes registradas para adaptadores específicos

Datos.gob.cl, ChileCompra, Presupuesto Abierto, DIPRES, Hacienda/Deuda, Banco Central, SII, SERVEL, Senado, Cámara, BCN/LeyChile, InfoLobby, InfoProbidad, SINIM, INE, CASEN, IDE Chile, MINVU, CEAD, Fiscalía, Poder Judicial, DEIS, MINEDUC, Agencia de Calidad, Dirección del Trabajo, Superintendencia de Pensiones, SINIA, SNIFA, DGA, SBAP, Energía Abierta, SUBTEL, SECTRA, DTPM/GTFS, CONASET, CMF, Aduanas, Fondos.gob.cl, CORFO, MOP, Diario Oficial y Contraloría.

## Prioridad de implementación sugerida

1. Datos.gob.cl (catálogo completo)
2. ChileCompra/OCDS/órdenes de compra
3. Presupuesto Abierto/DIPRES
4. SERVEL
5. Senado/Cámara/BCN
6. InfoLobby/InfoProbidad
7. INE/CASEN/SINIM
8. IDE Chile para geometrías
9. Salud, educación, seguridad y justicia
10. Medio ambiente, agua, energía, transporte e infraestructura

## Principio de procedencia

Cada conector debe almacenar el archivo/respuesta original en `data/raw`, registrar URL, fecha, HTTP status, tipo MIME, tamaño y SHA-256. Nunca se sustituye el original con una versión "limpia".
