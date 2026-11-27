import Fastify from "fastify";
import type { FastifyRequest, FastifyReply } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { routeRequest } from "./modules/router";
import type { IncomingEvent } from "./modules/planner";

const app = Fastify({
    logger: true
});
//SEGURIDAD 
async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void | FastifyReply> {
    const configuredKey = process.env.LAX_API_KEY;
    const providedKey = request.headers["x-lax-key"];
    const expected = configuredKey
        ? createHash("sha256").update(configuredKey, "utf8").digest()
        : undefined;
    const actual = typeof providedKey === "string"
        ? createHash("sha256").update(providedKey, "utf8").digest()
        : undefined;

    if (
        !expected ||
        !actual ||
        !timingSafeEqual(expected, actual)
    ) {
        return reply.code(401).send({
            success: false,
            message: "Unauthorized"
        });
    }
}
// Iniciar servidor
const start = async () => {
    try {
        await app.listen({
            port: 3000,
            host: "0.0.0.0"
        });

        console.log("LAX está escuchando en el puerto 3000");
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
};
//Salud
app.get("/health", async (request, reply) => {
    return {
        status: "ok",
        message: "LAX está funcionando correctamente"
    };
});


app.post("/events", { preHandler: authenticate }, async (request, reply) => {
    const event = request.body as IncomingEvent;

    return await routeRequest({
        type: "event",
        data: event
    });
});
app.post(
    "/schedule",
    { preHandler: authenticate },
    async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return reply.code(400).send({
            status: "invalid_request",
            message: 'El body debe ser un objeto JSON con el campo "text".'
            }
        );
    }

    const requestBody = body as Record<string, unknown>;
    const text = requestBody.text;
    if (typeof text !== "string" || !text.trim()) {
        return reply.code(400).send({
            status: "invalid_request",
            message: 'El campo "text" debe ser un texto no vacío.'
        });
    }

    const confirmationId = requestBody.confirmationId;
    if (
        confirmationId !== undefined &&
        (typeof confirmationId !== "string" ||
            !confirmationId.trim() ||
            confirmationId.length > 128)
    ) {
        return reply.code(400).send({
            status: "invalid_request",
            message: 'El campo "confirmationId" debe ser un identificador de texto válido.'
        });
    }

    try {
        const result = await routeRequest({
            type: "command",
            text,
            confirmationId:
                typeof confirmationId === "string" ? confirmationId : undefined
        });
<<<<<<< HEAD
        return reply.code(200).send(result);
=======
        let statusCode = 200;
        if (!Array.isArray(result)) {
            const requiresConfirmation =
                result.status === "conflict" ||
                ("confirmationRequired" in result &&
                    result.confirmationRequired === true);
            if (requiresConfirmation) statusCode = 409;
        }
        return reply.code(statusCode).send(result);
>>>>>>> master
    } catch (error) {
        request.log.error(
            { errorType: error instanceof Error ? error.name : "UnknownError" },
            "No se pudo procesar la solicitud de /schedule"
        );
        return reply.code(502).send({
            status: "processing_error",
            message: "No se pudo procesar la solicitud. Revisa los logs del servicio."
        });
    }
});

app.post(
    "/moodle-sync",
    { preHandler: authenticate },
    async () => routeRequest({ type: "moodle_sync" })
);





const POLLING_INTERVAL = process.env.MIN_REQUEST_INTERVAL ? parseInt(process.env.MIN_REQUEST_INTERVAL) : 300 * 60 * 1000; // 5 horas

async function startMoodlePolling() {
    try {
        await routeRequest({ type: "moodle_sync" });
    } catch (error) {
        console.error("Error en sincronización:", error);
    }

    setTimeout(startMoodlePolling, POLLING_INTERVAL);
}

startMoodlePolling();
start();
