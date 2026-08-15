export type ReleaseCheckSeverity = "required" | "advisory";

export type ReleaseCheck = Readonly<{
  label: string;
  ok: boolean;
  severity: ReleaseCheckSeverity;
  detail?: string;
}>;

export type ReleaseCheckSummary = Readonly<{
  failures: number;
  warnings: number;
  exitCode: 0 | 1;
}>;

export type DisplayPriceObservation =
  | Readonly<{ mark: number }>
  | Readonly<{ unavailable: string }>;

export const requiredCheck = (
  label: string,
  ok: boolean,
  detail = "",
): ReleaseCheck => ({ label, ok, severity: "required", detail });

/** Select the operator-supplied RPC without ever making it part of output. */
export function resolveRpcUrl(publicRpc: string, override?: string): string {
  return override?.trim() || publicRpc;
}

export function summarizeReleaseChecks(
  checks: readonly ReleaseCheck[],
): ReleaseCheckSummary {
  let failures = 0;
  let warnings = 0;
  for (const check of checks) {
    if (check.ok) continue;
    if (check.severity === "required") failures++;
    else warnings++;
  }
  return { failures, warnings, exitCode: failures === 0 ? 0 : 1 };
}

/**
 * DexScreener is a display-only market sanity source, not an execution
 * dependency. An unavailable/malformed mark therefore produces an advisory
 * check. When a valid mark is available, preserve the existing hard drift
 * guard: it can still expose an on-chain quoter, token-decimal, or fee-ladder
 * misconfiguration.
 */
export function assessDisplayPriceMark(
  implied: number,
  observation: DisplayPriceObservation,
  maxDrift = 0.02,
): ReleaseCheck {
  if ("unavailable" in observation) {
    return {
      label: "DexScreener price-mark comparison is available",
      ok: false,
      severity: "advisory",
      detail: observation.unavailable,
    };
  }

  const mark = observation.mark;
  if (!Number.isFinite(mark) || mark <= 0) {
    return {
      label: "DexScreener price-mark comparison is available",
      ok: false,
      severity: "advisory",
      detail: `invalid mark ${String(mark)}`,
    };
  }

  const drift = Math.abs(implied - mark) / mark;
  return requiredCheck(
    `quoted price within ${(maxDrift * 100).toFixed(0)}% of the DexScreener mark`,
    Number.isFinite(implied) && implied > 0 && drift < maxDrift,
    `quote $${implied.toFixed(2)} vs mark $${mark.toFixed(2)} (${(drift * 100).toFixed(2)}%)`,
  );
}
