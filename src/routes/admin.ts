import { Router, Request, Response } from "express";
import {
  getClientConfig,
  upsertClientConfig,
} from "../services/clientConfigService";
import { Algorithm } from "@prisma/client";

const router = Router();

// TODO: Admin routes are currently unprotected. Adding authentication/API-key protection in a future phase.

router.post(
  "/admin/clients/:clientKey",
  async (req: Request, res: Response) => {
    const { clientKey } = req.params;
    const { algorithm, requestsPerSecond, burstSize, windowMs } = req.body;

    // Validate algorithm
    if (
      algorithm !== Algorithm.TOKEN_BUCKET &&
      algorithm !== Algorithm.SLIDING_WINDOW
    ) {
      res.status(400).json({
        error:
          "Invalid algorithm. Allowed values: TOKEN_BUCKET, SLIDING_WINDOW.",
      });
      return;
    }

    // Validate requestsPerSecond
    // NOTE: For the SLIDING_WINDOW algorithm, requestsPerSecond is currently ignored
    // because burstSize acts as the request limit within windowMs. We still require
    // and validate it here to remain consistent with the database model/config schema.
    if (
      typeof requestsPerSecond !== "number" ||
      requestsPerSecond <= 0 ||
      isNaN(requestsPerSecond)
    ) {
      res
        .status(400)
        .json({ error: "requestsPerSecond must be a positive number." });
      return;
    }

    // Validate burstSize
    if (
      typeof burstSize !== "number" ||
      burstSize <= 0 ||
      !Number.isInteger(burstSize)
    ) {
      res.status(400).json({ error: "burstSize must be a positive integer." });
      return;
    }

    // Validate windowMs
    if (algorithm === Algorithm.SLIDING_WINDOW) {
      if (
        typeof windowMs !== "number" ||
        windowMs <= 0 ||
        !Number.isInteger(windowMs)
      ) {
        res.status(400).json({
          error:
            "windowMs must be a positive integer for SLIDING_WINDOW algorithm.",
        });
        return;
      }
    }

    try {
      const savedConfig = await upsertClientConfig(clientKey, {
        algorithm,
        requestsPerSecond,
        burstSize,
        windowMs: algorithm === Algorithm.SLIDING_WINDOW ? windowMs : null,
      });

      // Atomic creation status detection (to prevent TOCTOU bugs)
      const isNew =
        savedConfig.createdAt.getTime() === savedConfig.updatedAt.getTime();
      res.status(isNew ? 201 : 200).json(savedConfig);
    } catch (error) {
      console.error("Error saving client config:", error);
      res
        .status(500)
        .json({ error: "Internal server error while saving client config." });
    }
  },
);

router.get("/admin/clients/:clientKey", async (req: Request, res: Response) => {
  const { clientKey } = req.params;

  try {
    const config = await getClientConfig(clientKey);
    if (!config) {
      res
        .status(404)
        .json({
          error: `Configuration not found for client key: ${clientKey}`,
        });
      return;
    }
    res.status(200).json(config);
  } catch (error) {
    console.error("Error fetching client config:", error);
    res
      .status(500)
      .json({ error: "Internal server error while fetching client config." });
  }
});

export default router;
