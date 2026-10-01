import { z } from "zod";
import { actionBindingShape, idSchema, sha256Schema, timestampSchema } from "../typed-action-approval/contract.js";

export const requestAuthoritySchema = z.object({ ...actionBindingShape, attemptCreatedAt: timestampSchema }).strict();
export const reviewAuthoritySchema = z.object({
  ...actionBindingShape, result: z.enum(["PASS", "FAIL", "NEEDS_WORK"]), evidenceIntegrityValid: z.boolean(),
  issuedAt: timestampSchema, expiresAt: timestampSchema,
}).strict();
export const policyAuthoritySchema = z.object({
  targetId: idSchema, actionKind: actionBindingShape.actionKind, policySha256: sha256Schema,
  targetGeneration: actionBindingShape.targetGeneration, actionAllowed: z.boolean(), maintenanceWindowId: idSchema,
  maintenanceWindowStartsAt: timestampSchema, maintenanceWindowExpiresAt: timestampSchema,
}).strict();
