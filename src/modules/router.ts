import { getUpcomingAssignments } from "./moodle-manager";
import {
    planAssignment,
    planIncomingEvent,
    planUserRequest
} from "./planner";
import type {
    CalendarRequestResult,
    IncomingEvent
} from "./planner";
import {
    getScheduledCalendarEventIds,
    syncAssignments
} from "./assignment-store";

export type LaxRequest =
    | {
        type: "event";
        data: IncomingEvent;
    }
    | {
        type: "command";
        text: string;
        confirmationId?: string;
    }
    | { type: "moodle_sync" };

function toConversationResponse(result: CalendarRequestResult) {
    if (result.status === "needs_clarification") {
        return {
            status: result.status,
            message: result.question,
            ...(result.confirmationRequired
                ? { confirmationRequired: true }
                : {}),
            ...(result.confirmationId
                ? { confirmationId: result.confirmationId }
                : {})
        };
    }

    if (result.status === "failed") {
        const detail = result.message.toLocaleLowerCase("es-CO");
        const message = detail.includes("no está disponible")
            ? "Ese horario está ocupado; no pude completar el cambio."
            : detail.includes("no existe el evento")
                ? "No encuentro ese evento. Indica su título y el día."
                : detail.includes("la hora solicitada ya pasó") ||
                    detail.includes("la fecha límite ya pasó") ||
                    detail.includes("no encontré un horario disponible") ||
                    detail.includes("no puedo reubicar de forma segura") ||
                    detail.includes("no puedo reubicar tantos compromisos") ||
                    detail.includes("no pude determinar la duración") ||
                    detail.includes("no pude completar la operación al") ||
                    detail.includes("moví el compromiso, pero") ||
                    detail.includes("la serie semanal coincide")
                    ? result.message
                    : "No pude completar la operación. Revisa tu calendario e inténtalo de nuevo.";
        return {
            status: result.status,
            message,
            ...(result.confirmationId
                ? {
                    confirmationRequired: true,
                    confirmationId: result.confirmationId
                }
                : {})
        };
    }

    return {
        status: result.status,
        message: result.message,
        ...(result.status === "conflict" && result.confirmationId
            ? {
                confirmationRequired: true,
                confirmationId: result.confirmationId
            }
            : {})
    };
}

export async function routeRequest(request: LaxRequest) {
    switch (request.type) {
        case "event": {
            const knownLaxStudyEventIds =
                request.data.kind === "fixed_time_event"
                    ? await getScheduledCalendarEventIds()
                    : [];
            const result = await planIncomingEvent(
                request.data,
                knownLaxStudyEventIds
            );
            if (
                result.status === "event_created" ||
                result.status === "task_planned"
            ) {
                return toConversationResponse({
                    status: "created",
                    eventId: result.eventId,
                    title: result.title,
                    start: result.start,
                    end: result.end,
                    message: result.message,
                    movedEvents: result.movedEvents
                });
            }
            if (result.status === "needs_clarification") {
                return toConversationResponse(result);
            }
            if (result.status === "decision_required") {
                return toConversationResponse({
                    status: "conflict",
                    message: result.question,
                    conflicts: result.conflicts,
                    movedEvents: result.movedEvents,
                    confirmationId: result.confirmationId
                });
            }
            return toConversationResponse({
                status: "failed",
                message: result.message,
                movedEvents: result.movedEvents
            });
        }

        case "command": {
            if (typeof request.text !== "string" || !request.text.trim()) {
                return {
                    status: "needs_clarification",
                    message: "Cuéntame qué evento quieres consultar o modificar."
                };
            }

            console.info("[Router] Procesando operación de calendario.");
            const result = await planUserRequest(
                request.text,
                request.confirmationId
            );
            console.info(`[Router] Operación finalizada: ${result.status}.`);
            return toConversationResponse(result);
        }

        case "moodle_sync": {
            console.log("Iniciando sincronización de Moodle");

            const assignments = await getUpcomingAssignments();
            const results = await syncAssignments(assignments, planAssignment);
            const pendingResults = results.filter(result => !result.scheduled);

            console.log(
                `Sincronización de Moodle finalizada: ${results.length - pendingResults.length} agendadas y ${pendingResults.length} pendientes.`
            );

            for (const result of pendingResults) {
                console.warn(
                    `Actividad pendiente "${result.activity.title}": ${result.reason ?? "El planner no indicó un motivo."}`
                );
            }

            return results;
        }
    }
}