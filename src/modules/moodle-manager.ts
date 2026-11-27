export interface MoodleAttachment {
    filename: string;
    filepath: string;
    filesize: number;
    fileurl: string;
    mimetype: string;
}

export interface MoodleAssignment {
    id: number;
    cmid: number;
    course: number;
    name: string;
    duedate: number;
    allowsubmissionsfromdate: number;
    timemodified: number;
    intro: string;
    introattachments: MoodleAttachment[];
}
const MOODLE_URL =
    "https://campusvirtual.univalle.edu.co/moodle/webservice/rest/server.php";

function getBogotaDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);

    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);

    const values = Object.fromEntries(
        parts.map(part => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
} //fUNCION GENERICA PARA TENER FECHA DE BOGOTA EN FORMATO YYYY-MM-DD

function isUpcoming(assignment: MoodleAssignment): boolean {
    // Una tarea sin fecha límite no entra en este filtro.
    if (assignment.duedate === 0) return false;

    const today = getBogotaDate(Date.now() / 1000);
    const dueDate = getBogotaDate(assignment.duedate);

    return dueDate >= today;
}

export async function getUpcomingAssignments(): Promise<MoodleAssignment[]> {
    const token = process.env.MOODLE_TOKEN;

    if (!token) {
        throw new Error("MOODLE_TOKEN no está configurado");
    }

    const body = new URLSearchParams({
        wstoken: token,
        wsfunction: "mod_assign_get_assignments",
        moodlewsrestformat: "json"
    });

    const response = await fetch(MOODLE_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body
    });

    if (!response.ok) {
        throw new Error(`Error HTTP de Moodle: ${response.status}`);
    }

    const data = await response.json();

    if (data.exception || !Array.isArray(data.courses)) {
        throw new Error(
            data.message || "Respuesta inesperada de Moodle"
        );
    }

    const assignments: MoodleAssignment[] =
        data.courses.flatMap((course: any) => course.assignments ?? []);

    return assignments
        .filter(isUpcoming)
        .sort((a, b) => a.duedate - b.duedate);
}
