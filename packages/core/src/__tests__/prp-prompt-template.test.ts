import { describe, it, expect } from "vitest";
import { buildPrpPrompt, PRP_LIFECYCLE_PROMPT } from "../prp-prompt-template.js";
import type { PrpConfig } from "../types.js";

function makePrpConfig(overrides?: Partial<PrpConfig>): PrpConfig {
  return {
    enabled: true,
    gates: { plan: false, pr: false },
    writeback: { investigation: true, plan: true, implementation: true, pr: true },
    promptFile: null,
    ...overrides,
  };
}

describe("PRP_LIFECYCLE_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof PRP_LIFECYCLE_PROMPT).toBe("string");
    expect(PRP_LIFECYCLE_PROMPT.length).toBeGreaterThan(100);
  });

  it("covers all lifecycle steps", () => {
    expect(PRP_LIFECYCLE_PROMPT).toContain("Step 1: Investigate");
    expect(PRP_LIFECYCLE_PROMPT).toContain("Step 2: Plan");
    expect(PRP_LIFECYCLE_PROMPT).toContain("Step 3: Implement");
    expect(PRP_LIFECYCLE_PROMPT).toContain("Step 4: Create PR");
    expect(PRP_LIFECYCLE_PROMPT).toContain("Step 5: Self-Review");
  });

  it("includes enforcement rules", () => {
    expect(PRP_LIFECYCLE_PROMPT).toContain("NEVER skip");
    expect(PRP_LIFECYCLE_PROMPT).toContain("ALWAYS use the validation loop");
  });
});

describe("buildPrpPrompt", () => {
  it("includes lifecycle prompt", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig(),
      issueId: "#42",
      projectName: "My App",
    });
    expect(result).toContain(PRP_LIFECYCLE_PROMPT);
  });

  it("includes issue ID in commands", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig(),
      issueId: "#42",
      projectName: "My App",
    });
    expect(result).toContain("/prp-issue-investigate #42");
    expect(result).toContain("Issue: #42");
  });

  it("includes project name", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig(),
      issueId: "#42",
      projectName: "My App",
    });
    expect(result).toContain("Project: My App");
  });

  it("includes all PRP commands in order", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig(),
      issueId: "#42",
      projectName: "My App",
    });
    const investigateIdx = result.indexOf("/prp-issue-investigate");
    const planIdx = result.indexOf("/prp-plan");
    const ralphIdx = result.indexOf("/prp-ralph");
    const prIdx = result.indexOf("/prp-pr");
    const reviewIdx = result.indexOf("/prp-review");

    expect(investigateIdx).toBeLessThan(planIdx);
    expect(planIdx).toBeLessThan(ralphIdx);
    expect(ralphIdx).toBeLessThan(prIdx);
    expect(prIdx).toBeLessThan(reviewIdx);
  });

  it("omits gate instructions when gates are disabled", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig({ gates: { plan: false, pr: false } }),
      issueId: "#42",
      projectName: "My App",
    });
    expect(result).not.toContain("Plan Approval Gate");
    expect(result).not.toContain("PR Review Gate");
  });

  it("includes plan gate instructions when enabled", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig({ gates: { plan: true, pr: false } }),
      issueId: "#42",
      projectName: "My App",
    });
    expect(result).toContain("Plan Approval Gate");
    expect(result).toContain("STOP and wait");
    expect(result).not.toContain("PR Review Gate");
  });

  it("includes PR gate instructions when enabled", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig({ gates: { plan: false, pr: true } }),
      issueId: "#42",
      projectName: "My App",
    });
    expect(result).not.toContain("Plan Approval Gate");
    expect(result).toContain("PR Review Gate");
  });

  it("includes both gates when both enabled", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig({ gates: { plan: true, pr: true } }),
      issueId: "#42",
      projectName: "My App",
    });
    expect(result).toContain("Plan Approval Gate");
    expect(result).toContain("PR Review Gate");
  });

  it("works with different issue ID formats", () => {
    const result = buildPrpPrompt({
      prp: makePrpConfig(),
      issueId: "INT-1343",
      projectName: "My App",
    });
    expect(result).toContain("/prp-issue-investigate INT-1343");
    expect(result).toContain("Issue: INT-1343");
  });
});
