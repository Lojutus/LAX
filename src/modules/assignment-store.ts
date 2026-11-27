
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import type { MoodleAssignment } from "./moodle-manager";
import type { PlannerActivity, PlannerResult } from "./planner";

type AssignmentStatus = "pending" | "scheduled";

interface StoredAssignment extends MoodleAssignment {
    status: AssignmentStatus;
    calendarEventId?: string;
    movedCalendarEventIds?: string[];
}

interface AssignmentStoreData {
    assignments: StoredAssignment[];
}

// La ruta puede apuntar al volumen persistente.
const DATA_DIR = process.env.LAX_DATA_DIR ?? path.resolve("data");
const DATA_FILE = path.join(DATA_DIR, "assignments.json");
const TEMP_FILE = `${DATA_FILE}.tmp`;

/*
 * Serializa todas las operaciones sobre el archivo.
 * Así dos llamadas simultáneas no leen y escriben
 * estados desactualizados.
 */
let operationQueue: Promise<void> = Promise.resolve();

function serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation);

    operationQueue = result.then(
        () => undefined,
        () => undefined
    );

    return result;
}

function getBogotaDate(timestamp: number): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date(timestamp * 1000));
}

function isExpired(assignment: MoodleAssignment): boolean {
    if (assignment.duedate === 0) return false;

    const today = getBogotaDate(Date.now() / 1000);
    const dueDate = getBogotaDate(assignment.duedate);

    return dueDate < today;
}

async function readStore(initializeEmpty = true): Promise<AssignmentStoreData> {
    await mkdir(DATA_DIR, { recursive: true });

    let content: string;
    try {
        content = await readFile(DATA_FILE, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }

        const initialData: AssignmentStoreData = {
            assignments: []
        };

        if (initializeEmpty) await writeStore(initialData);
        return initialData;
    }

    if (!content.trim()) {
        const initialData: AssignmentStoreData = {
            assignments: []
        };

        if (initializeEmpty) await writeStore(initialData);
        return initialData;
    }

    return JSON.parse(content) as AssignmentStoreData;
}

/*
 * Escritura atómica:
 * 1. Escribe el contenido completo en un temporal.
 * 2. Renombra el temporal sobre el archivo original.
 *
 * El archivo original no queda parcialmente escrito.
 */
async function writeStore(data: AssignmentStoreData): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });

    const content = JSON.stringify(data, null, 2);

    await writeFile(TEMP_FILE, content, "utf-8");
    await rename(TEMP_FILE, DATA_FILE);
}

function getAssignmentKey(assignment: MoodleAssignment): string {
    return `${assignment.course}:${assignment.id}`;
}

export async function syncAssignments(
    incomingAssignments: MoodleAssignment[],
    planAssignment: (
        assignment: MoodleAssignment,
        previouslyMovedEventIds: string[]
    ) => Promise<PlannerResult>
): Promise<PlannerResult[]> {
    return serializeOperation(async () => {
        const store = await readStore();
        const results: PlannerResult[] = [];

        // 1. Eliminar actividades vencidas.
        store.assignments = store.assignments.filter(
            assignment => !isExpired(assignment)
        );

        // 2. Identificar actividades nuevas y pendientes.
        const assignmentsToPlan: StoredAssignment[] = [];

        for (const incoming of incomingAssignments) {
            const key = getAssignmentKey(incoming);

            const existing = store.assignments.find(
                assignment => getAssignmentKey(assignment) === key
            );

            if (!existing) {
                const newAssignment: StoredAssignment = {
                    ...incoming,
                    status: "pending",
                    movedCalendarEventIds: []
                };

                store.assignments.push(newAssignment);
                assignmentsToPlan.push(newAssignment);
                continue;
            }

            // Las ya agendadas nunca se vuelven a crear.
            if (existing.status === "scheduled") {
                continue;
            }

            // Si quedó pendiente por un error anterior, reintentamos.
            assignmentsToPlan.push(existing);
        }

        // 3. Guardar primero los registros pending.
        await writeStore(store);

        // 4. Planificar una por una y persistir solo las confirmadas.
        for (const assignment of assignmentsToPlan) {
            try {
                let result = await planAssignment(
                    assignment,
                    assignment.movedCalendarEventIds ?? []
                );

                if (result.scheduled && !result.calendarEventId) {
                    result = {
                        ...result,
                        scheduled: false,
                        reason: "El planner indicó éxito, pero no devolvió un ID de Calendar."
                    };
                }

                if (result.scheduled && result.calendarEventId) {
                    assignment.status = "scheduled";
                    assignment.calendarEventId = result.calendarEventId;
                } else {
                    assignment.status = "pending";
                    delete assignment.calendarEventId;
                }

                assignment.movedCalendarEventIds = [
                    ...new Set([
                        ...(assignment.movedCalendarEventIds ?? []),
                        ...result.movedEvents.map(event => event.eventId)
                    ])
                ];
                results.push(result);
            } catch (error) {
                assignment.status = "pending";
                delete assignment.calendarEventId;
                const dueTimestamp = assignment.duedate * 1000;
                const dueDate = Number.isFinite(dueTimestamp)
                    ? new Date(dueTimestamp)
                    : undefined;
                const activity: PlannerActivity = {
                    title: assignment.name,
                    dueAt: dueDate && Number.isFinite(dueDate.getTime())
                        ? dueDate.toISOString()
                        : "",
                    moodleId: assignment.id,
                    courseId: assignment.course
                };
                const message =
                    error instanceof Error ? error.message : "Error inesperado del planner.";
                const apiKey = process.env.OPENAI_API_KEY;
                const safeMessage = apiKey
                    ? message.split(apiKey).join("[redacted]")
                    : message;

                results.push({
                    activity,
                    scheduled: false,
                    reason: safeMessage,
                    movedEvents: []
                });
                console.error(
                    `Error agendando "${assignment.name}":`,
                    safeMessage
                );
            }

            // Persistir el resultado de cada intento.
            await writeStore(store);
        }

        return results;
    });
}

export async function getScheduledCalendarEventIds(): Promise<string[]> {
    return serializeOperation(async () => {
        const store = await readStore(false);
        return store.assignments
            .flatMap(
                assignment =>
                    assignment.status === "scheduled" &&
                    typeof assignment.calendarEventId === "string"
                        ? [assignment.calendarEventId]
                        : []
            )
    });
}
