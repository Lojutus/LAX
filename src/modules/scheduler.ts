import { createHash } from "node:crypto";
import { google, type calendar_v3 } from "googleapis";
import type { MoodleAssignment } from "./moodle-manager";

const TIMEZONE = process.env.GOOGLE_TIMEZONE ?? "America/Bogota";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? "primary";

export interface ScheduleEvent {
    id: string;
    title: string;
    description: string;
    start: string;
    end: string;
    status: string | null;
    transparency: string | null;
    managedByLax: boolean;
    laxType: string | null;
}

export interface CalendarEventInput {
    title: string;
    description: string;
}

function getCalendarClient() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error("Faltan credenciales de Google Calendar en .env");
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });

    return google.calendar({
        version: "v3",
        auth
    });
}

function toDateTime(value: Date | string, label: string): string {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (!Number.isFinite(date.getTime())) {
        throw new Error(`${label} no es una fecha válida.`);
    }

    return date.toISOString();
}

function validateRange(start: Date | string, end: Date | string) {
    const startDateTime = toDateTime(start, "La fecha de inicio");
    const endDateTime = toDateTime(end, "La fecha de finalización");

    if (new Date(startDateTime).getTime() >= new Date(endDateTime).getTime()) {
        throw new Error("La fecha de finalización debe ser posterior al inicio.");
    }

    return { startDateTime, endDateTime };
}

function getEventId(assignment: MoodleAssignment): string {
    return createHash("sha256")
        .update(`${assignment.course}:${assignment.id}`)
        .digest("hex")
        .slice(0, 32);
}

function getCalendarEventId(
    event: CalendarEventInput,
    start: string,
    end: string
): string {
    return `l${createHash("sha256")
        .update(JSON.stringify([event.title, event.description, start, end]))
        .digest("hex")
        .slice(0, 32)}`;
}

function cleanHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim();
}

function getErrorCode(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined;

    const candidate = error as {
        code?: unknown;
        response?: { status?: unknown };
    };
    const code = candidate.response?.status ?? candidate.code;

    return typeof code === "number" ? code : undefined;
}

async function getExistingEvent(
    calendar: ReturnType<typeof getCalendarClient>,
    eventId: string
): Promise<calendar_v3.Schema$Event | undefined> {
    try {
        const response = await calendar.events.get({
            calendarId: CALENDAR_ID,
            eventId
        });
        return response.data;
    } catch (error) {
        if (getErrorCode(error) === 404) return undefined;
        throw error;
    }
}

async function listEvents(
    calendar: ReturnType<typeof getCalendarClient>,
    start: string,
    end: string
): Promise<calendar_v3.Schema$Event[]> {
    const events: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined;

    do {
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: start,
            timeMax: end,
            timeZone: TIMEZONE,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 2500,
            pageToken,
            fields: "items(id,summary,description,start,end,status,transparency,extendedProperties(private)),nextPageToken"
        });

        events.push(...(response.data.items ?? []));
        pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return events;
}

function getEventDateTime(
    value: calendar_v3.Schema$EventDateTime | null | undefined,
    label: string
): string {
    const dateTime = value?.dateTime ?? value?.date;

    if (!dateTime || !Number.isFinite(new Date(dateTime).getTime())) {
        throw new Error(`Google Calendar devolvió un evento sin ${label} válido.`);
    }

    return dateTime;
}

function toScheduleEvent(event: calendar_v3.Schema$Event): ScheduleEvent {
    if (!event.id) {
        throw new Error("Google Calendar devolvió un evento sin ID.");
    }

    return {
        id: event.id,
        title: event.summary ?? "",
        description: event.description ?? "",
        start: getEventDateTime(event.start, "inicio"),
        end: getEventDateTime(event.end, "finalización"),
        status: event.status ?? null,
        transparency: event.transparency ?? null,
        managedByLax: event.extendedProperties?.private?.laxManaged === "true",
        laxType: event.extendedProperties?.private?.laxType ?? null
    };
}

function hasConflict(
    events: calendar_v3.Schema$Event[],
    start: string,
    end: string,
    excludedEventId?: string
): boolean {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();

    return events.some(event => {
        if (
            event.status === "cancelled" ||
            event.transparency === "transparent" ||
            event.id === excludedEventId
        ) {
            return false;
        }

        const eventStart = getEventDateTime(event.start, "inicio");
        const eventEnd = getEventDateTime(event.end, "finalización");
        const eventStartMs = new Date(eventStart).getTime();
        const eventEndMs = new Date(eventEnd).getTime();

        return startMs < eventEndMs && endMs > eventStartMs;
    });
}

export async function getSchedule(
    start: Date | string,
    end: Date | string
): Promise<ScheduleEvent[]> {
    const range = validateRange(start, end);
    const calendar = getCalendarClient();
    const events = await listEvents(calendar, range.startDateTime, range.endDateTime);

    return events.map(toScheduleEvent);
}

export async function scheduleEvent(
    assignment: MoodleAssignment,
    start: Date | string,
    end: Date | string
): Promise<string> {
    const range = validateRange(start, end);
    const calendar = getCalendarClient();
    const eventId = getEventId(assignment);

    const existing = await getExistingEvent(calendar, eventId);
    if (existing && existing.status !== "cancelled") return eventId;
    if (existing?.status === "cancelled") {
        throw new Error(`El evento determinista "${eventId}" está cancelado en Calendar.`);
    }

    const events = await listEvents(calendar, range.startDateTime, range.endDateTime);
    if (hasConflict(events, range.startDateTime, range.endDateTime)) {
        throw new Error("El horario indicado no está disponible en Google Calendar.");
    }

    try {
        await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                id: eventId,
                summary: assignment.name,
                description: cleanHtml(assignment.intro ?? ""),
                extendedProperties: {
                    private: {
                        laxManaged: "true",
                        laxType: "study"
                    }
                },
                start: {
                    dateTime: range.startDateTime,
                    timeZone: TIMEZONE
                },
                end: {
                    dateTime: range.endDateTime,
                    timeZone: TIMEZONE
                }
            }
        });

        return eventId;
    } catch (error) {
        if (getErrorCode(error) !== 409) throw error;

        const duplicate = await getExistingEvent(calendar, eventId);
        if (duplicate && duplicate.status !== "cancelled") return eventId;
        throw error;
    }
}

export async function createCalendarEvent(
    event: CalendarEventInput,
    start: Date | string,
    end: Date | string
): Promise<string> {
    if (!event.title.trim()) {
        throw new Error("El título del evento es obligatorio.");
    }

    const range = validateRange(start, end);
    if (new Date(range.startDateTime).getTime() <= Date.now()) {
        throw new Error("El inicio del evento debe estar en el futuro.");
    }

    const calendar = getCalendarClient();
    const eventId = getCalendarEventId(
        event,
        range.startDateTime,
        range.endDateTime
    );
    const existing = await getExistingEvent(calendar, eventId);
    if (existing && existing.status !== "cancelled") return eventId;
    if (existing?.status === "cancelled") {
        throw new Error(`El evento determinista "${eventId}" está cancelado en Calendar.`);
    }

    const events = await listEvents(calendar, range.startDateTime, range.endDateTime);
    if (hasConflict(events, range.startDateTime, range.endDateTime)) {
        throw new Error("El horario indicado no está disponible en Google Calendar.");
    }

    try {
        await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                id: eventId,
                summary: event.title,
                description: event.description,
                extendedProperties: {
                    private: {
                        laxManaged: "true",
                        laxType: "fixed"
                    }
                },
                start: {
                    dateTime: range.startDateTime,
                    timeZone: TIMEZONE
                },
                end: {
                    dateTime: range.endDateTime,
                    timeZone: TIMEZONE
                }
            }
        });
    } catch (error) {
        if (getErrorCode(error) !== 409) throw error;

        const duplicate = await getExistingEvent(calendar, eventId);
        if (duplicate && duplicate.status !== "cancelled") return eventId;
        throw error;
    }

    return eventId;
}

export async function moveEvent(
    eventId: string,
    start: Date | string,
    end: Date | string
): Promise<ScheduleEvent> {
    if (!eventId.trim()) {
        throw new Error("El ID del evento es obligatorio.");
    }

    const range = validateRange(start, end);
    const calendar = getCalendarClient();
    const existing = await getExistingEvent(calendar, eventId);

    if (!existing) {
        throw new Error(`No existe el evento "${eventId}" en Google Calendar.`);
    }
    if (existing.status === "cancelled") {
        throw new Error(`El evento "${eventId}" está cancelado en Google Calendar.`);
    }

    const events = await listEvents(calendar, range.startDateTime, range.endDateTime);
    if (hasConflict(events, range.startDateTime, range.endDateTime, eventId)) {
        throw new Error("El horario indicado no está disponible en Google Calendar.");
    }

    const response = await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId,
        requestBody: {
            start: {
                dateTime: range.startDateTime,
                timeZone: TIMEZONE
            },
            end: {
                dateTime: range.endDateTime,
                timeZone: TIMEZONE
            }
        }
    });

    return toScheduleEvent(response.data);
}

export async function deleteEvent(eventId: string): Promise<void> {
    if (typeof eventId !== "string" || !eventId.trim()) {
        throw new Error("El ID del evento es obligatorio.");
    }

    const calendar = getCalendarClient();
    const existing = await getExistingEvent(calendar, eventId);
    if (!existing) {
        throw new Error(`No existe el evento "${eventId}" en Google Calendar.`);
    }
    if (existing.status === "cancelled") {
        throw new Error(`El evento "${eventId}" ya está cancelado en Google Calendar.`);
    }

    await calendar.events.delete({
        calendarId: CALENDAR_ID,
        eventId
    });

    const remaining = await getExistingEvent(calendar, eventId);
    if (remaining && remaining.status !== "cancelled") {
        throw new Error(`Google Calendar no confirmó la eliminación de "${eventId}".`);
    }
}

export async function updateEvent(
    eventId: string,
    updates: {
        title?: string;
        description?: string;
    }
): Promise<ScheduleEvent> {
    if (typeof eventId !== "string" || !eventId.trim()) {
        throw new Error("El ID del evento es obligatorio.");
    }
    if (
        typeof updates !== "object" ||
        updates === null ||
        Array.isArray(updates)
    ) {
        throw new Error("Los campos de actualización no tienen un formato válido.");
    }

    const unexpectedFields = Object.keys(updates).filter(
        field => field !== "title" && field !== "description"
    );
    if (unexpectedFields.length > 0) {
        throw new Error("Solo se pueden actualizar título y descripción.");
    }

    const hasTitle = Object.prototype.hasOwnProperty.call(updates, "title");
    const hasDescription = Object.prototype.hasOwnProperty.call(updates, "description");
    if (!hasTitle && !hasDescription) {
        throw new Error("Indica al menos el título o la descripción que quieres actualizar.");
    }
    if (hasTitle && (typeof updates.title !== "string" || !updates.title.trim())) {
        throw new Error("El título actualizado debe ser un texto no vacío.");
    }
    if (hasDescription && typeof updates.description !== "string") {
        throw new Error("La descripción actualizada debe ser un texto.");
    }

    const calendar = getCalendarClient();
    const existing = await getExistingEvent(calendar, eventId);
    if (!existing) {
        throw new Error(`No existe el evento "${eventId}" en Google Calendar.`);
    }
    if (existing.status === "cancelled") {
        throw new Error(`El evento "${eventId}" está cancelado en Google Calendar.`);
    }

    const requestBody: calendar_v3.Schema$Event = {};
    if (hasTitle) requestBody.summary = updates.title;
    if (hasDescription) requestBody.description = updates.description;

    const response = await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId,
        requestBody
    });

    if (
        (hasTitle && response.data.summary !== updates.title) ||
        (hasDescription &&
            (response.data.description ?? "") !== updates.description)
    ) {
        throw new Error("Google Calendar no confirmó los metadatos solicitados.");
    }

    return toScheduleEvent(response.data);
}
