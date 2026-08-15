import assert from "node:assert/strict";
import test from "node:test";
import {
  assessDisplayPriceMark,
  requiredCheck,
  resolveRpcUrl,
  summarizeReleaseChecks,
} from "./chain-check-policy";

test("the release gate prefers an operator RPC and falls back to the public endpoint", () => {
  assert.equal(
    resolveRpcUrl("https://public.example", "  https://commercial.example/key  "),
    "https://commercial.example/key",
  );
  assert.equal(resolveRpcUrl("https://public.example", "   "), "https://public.example");
  assert.equal(resolveRpcUrl("https://public.example"), "https://public.example");
});

test("an unavailable display-only price source warns without failing the release gate", () => {
  const mark = assessDisplayPriceMark(200, {
    unavailable: "DexScreener timed out after 5000ms",
  });
  const summary = summarizeReleaseChecks([
    requiredCheck("chain id", true),
    requiredCheck("router bytecode", true),
    mark,
  ]);

  assert.equal(mark.severity, "advisory");
  assert.deepEqual(summary, { failures: 0, warnings: 1, exitCode: 0 });
});

test("a required on-chain failure remains release-blocking even beside warnings", () => {
  const summary = summarizeReleaseChecks([
    requiredCheck("router bytecode", false),
    assessDisplayPriceMark(200, { unavailable: "HTTP 503" }),
  ]);

  assert.deepEqual(summary, { failures: 1, warnings: 1, exitCode: 1 });
});

test("a valid but materially divergent market mark preserves the hard sanity guard", () => {
  const mark = assessDisplayPriceMark(200, { mark: 250 });
  const summary = summarizeReleaseChecks([mark]);

  assert.equal(mark.severity, "required");
  assert.deepEqual(summary, { failures: 1, warnings: 0, exitCode: 1 });
});

test("a valid nearby market mark passes", () => {
  const mark = assessDisplayPriceMark(200, { mark: 201 });
  assert.deepEqual(summarizeReleaseChecks([mark]), {
    failures: 0,
    warnings: 0,
    exitCode: 0,
  });
});
