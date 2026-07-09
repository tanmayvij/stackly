import { setGlobalOptions } from "firebase-functions";
import { onRequest } from "firebase-functions/https";
import * as logger from "firebase-functions/logger";


setGlobalOptions({ maxInstances: 10 });

export const health = onRequest((_request, response) => {
    logger.info("Health Check", { structuredData: true });
    response.json({ success: true });
});
