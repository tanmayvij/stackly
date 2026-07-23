import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";

export const health = onRequest((_request, response) => {
  logger.info("Health Check", {structuredData: true});
  response.json({success: true});
});
