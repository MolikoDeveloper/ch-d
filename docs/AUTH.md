# Autenticación e identidad legal

No se almacena ningún dato de identidad del operador dentro del código fuente.

Cuando una fuente oficial requiera autenticación:

- usar `.env` local;
- mantener tokens, RUT, correo y credenciales fuera de Git;
- usar únicamente credenciales obtenidas legítimamente por el operador;
- respetar términos de uso, cuotas y restricciones de tratamiento de datos;
- no intentar saltar controles de acceso ni reconstruir información protegida.

Variables preparadas: `CHILECOMPRA_TICKET`, `BCCH_API_KEY`, `BCCH_USER_EMAIL`, `LEGAL_NAME`, `LEGAL_RUT`, `LEGAL_EMAIL`.
