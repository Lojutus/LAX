# LAX

Asistente de calendario que integra actividades de Moodle, OpenAI y Google Calendar. El servidor escucha en el puerto `3000`.

## Configuración

Requisito: Docker Desktop con Docker Compose.

1. Crea un archivo `.env` en la raíz y configura las credenciales:

   ```dotenv
   OPENAI_API_KEY=your-openai-api-key

   GOOGLE_CLIENT_ID=your-google-oauth-client-id
   GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
   GOOGLE_REFRESH_TOKEN=your-google-refresh-token
   GOOGLE_CALENDAR_ID=primary
   GOOGLE_TIMEZONE=America/Bogota

   MOODLE_TOKEN=your-moodle-webservice-token
   LAX_API_KEY=your-lax-api-key
   ```

   No compartas ni subas `.env` al repositorio. `LAX_API_KEY` debe tener un valor secreto y configurado; no reutilices una clave de Google o OpenAI. `OPENAI_MODEL` es opcional; por defecto se usa `gpt-4.1-mini`. `GOOGLE_CALENDAR_ID` y `GOOGLE_TIMEZONE` son opcionales; sus valores predeterminados son `primary` y `America/Bogota`.

   `GOOGLE_WORK_START` y `GOOGLE_WORK_END` son opcionales, pero deben configurarse juntos en formato `HH:mm`. Se aplican a la planificación de tareas flexibles, no a eventos con hora fija.

   `MIN_REQUEST_INTERVAL` es opcional y se expresa en milisegundos; el valor predeterminado es `18000000` (cinco horas). `LAX_DATA_DIR` cambia el directorio de persistencia; por defecto es `data`.

2. Desde la raíz del proyecto, construye e inicia el contenedor:

   ```sh
   docker compose up --build
   ```

   Docker instala pnpm y las dependencias dentro del contenedor. El servicio queda disponible en `http://localhost:3000`. Para dejarlo ejecutándose en segundo plano:

   ```sh
   docker compose up --build -d
   ```

   Para consultar los logs:

   ```sh
   docker compose logs -f lax
   ```

   Para detener el servicio:

   ```sh
   docker compose down
   ```

   **Importante:** al iniciar el servidor se intenta sincronizar Moodle inmediatamente y luego según `MIN_REQUEST_INTERVAL`. La sincronización puede planificar actividades y crear eventos en el calendario.

## Peticiones HTTP

### Estado del servicio

`GET http://localhost:3000/health`

### Petición en lenguaje natural

`POST http://localhost:3000/schedule`

Envía el body como JSON con `Content-Type: application/json`:

Este endpoint requiere el encabezado `x-lax-key` con el mismo valor de `LAX_API_KEY` configurado en el servidor.

```json
{
  "text": "Tengo una reunión el viernes de 3 a 4 de la tarde"
}
```

Este endpoint interpreta consultas, creaciones, movimientos y otras solicitudes del calendario. Las fechas sin zona explícita se interpretan con `America/Bogota`. Si falta información, responde con una pregunta.

También entiende compromisos recurrentes semanales, por ejemplo: `"Bloquea estudio todos los lunes a las 3 pm por dos horas"`. Si no se especifica una fecha final, la serie continúa indefinidamente en Google Calendar. Antes de crearla, LAX revisa conflictos en las próximas 52 ocurrencias y no reubica eventos para hacerle espacio.

Cuando una respuesta pida confirmación, conserva el `confirmationId` y envíalo junto con la respuesta:

```json
{
  "text": "sí",
  "confirmationId": "id-recibido-en-la-respuesta"
}
```

Las confirmaciones expiran después de 15 minutos y se guardan en memoria; un reinicio del servidor las invalida.
Si el conflicto se inició en `/events`, también puedes responder por `/schedule` con el `confirmationId` devuelto.

### Enviar un evento estructurado

`POST http://localhost:3000/events`

También requiere el encabezado `x-lax-key: <valor-configurado-en-LAX_API_KEY>`.

Evento con hora fija:

```json
{
  "kind": "fixed_time_event",
  "title": "Cita médica",
  "description": "Cita de seguimiento",
  "startAt": "2026-11-27T15:00:00-05:00",
  "endAt": "2026-11-27T16:00:00-05:00"
}
```

Para repetir un evento fijo cada semana, incluye `recurrence` y establece el inicio en la primera ocurrencia. Si no se especifica un fin, se repite indefinidamente:

```json
{
  "kind": "fixed_time_event",
  "title": "Estudio",
  "description": "Bloque semanal de estudio",
  "startAt": "2026-11-30T15:00:00-05:00",
  "endAt": "2026-11-30T17:00:00-05:00",
  "recurrence": {
    "frequency": "weekly",
    "dayOfWeek": "MO"
  }
}
```

`dayOfWeek` acepta `MO`, `TU`, `WE`, `TH`, `FR`, `SA` o `SU`. LAX comprueba conflictos en las próximas 52 ocurrencias y no mueve otros eventos para acomodar la serie.

Tarea flexible con fecha límite:

```json
{
  "kind": "flexible_task",
  "title": "Preparar presentación",
  "description": "Preparar las diapositivas",
  "dueAt": "2026-11-27T15:00:00-05:00"
}
```

Las fechas deben incluir un offset ISO 8601. Una tarea flexible tiene fecha límite; un evento fijo necesita inicio y finalización.

### Sincronizar Moodle manualmente

`POST http://localhost:3000/moodle-sync`

Este endpoint también requiere el encabezado:

```text
x-lax-key: <valor-configurado-en-LAX_API_KEY>
```

No necesita body.

## Seguridad

`x-lax-key` protege todos los endpoints `POST`; `/health` queda público para comprobaciones de disponibilidad. No expongas el servicio a redes públicas sin TLS y una política segura para almacenar y rotar `LAX_API_KEY`.
