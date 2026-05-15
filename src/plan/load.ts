import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Env } from "../env-runtime/env.js";
import { BankaiPlanV1Schema, type BankaiPlanV1 } from "./schema.js";

export interface LoadPlanOk {
  ok: true;
  plan: BankaiPlanV1;
  planPath: string;
}

export interface LoadPlanErr {
  ok: false;
  reason: string;
  detail?: Record<string, unknown>;
  planPath: string;
}

export type LoadPlanResult = LoadPlanOk | LoadPlanErr;

export async function loadPlan(opts: { env: Env; planPath: string }): Promise<LoadPlanResult> {
  const planPath = isAbsolute(opts.planPath) ? opts.planPath : resolve(opts.env.cwd, opts.planPath);
  let raw: string;
  try {
    raw = await readFile(planPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `could not read plan at ${planPath}: ${(err as Error).message}`,
      planPath,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `plan at ${planPath} is not valid JSON: ${(err as Error).message}`,
      planPath,
    };
  }
  const result = BankaiPlanV1Schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: `plan at ${planPath} failed validation`,
      detail: {
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      planPath,
    };
  }
  return { ok: true, plan: result.data, planPath };
}
