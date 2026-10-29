import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/shared/components/ZaiOAuthModal.js", import.meta.url),
  "utf-8"
);

describe("Z.AI OAuth modal", () => {
  it("uses one authorization button with an optional starter-plan checkbox", () => {
    expect(source.match(/Open Authorization Page/g)).toHaveLength(1);
    expect(source).not.toContain("Auth with Create Start Plan");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("Create Start Plan");
  });

  it("freezes the checkbox choice before polling starts", () => {
    expect(source).toContain("const checked = event.target.checked;");
    expect(source).toContain("initializeStartPlanRef.current = checked;");
    expect(source).toContain("setInitializeStartPlan(checked);");
    expect(source).toContain("initializeStartPlan: initializeStartPlanRef.current");
    expect(source).toContain("initializeStartPlanRef.current = initializeStartPlan;");
    expect(source).toContain("startPoll(flowId, pollDelayRef.current);");
    expect(source).not.toContain("startPoll(data.flowId");
    expect(source).toContain('disabled={step === "polling"}');
  });

  it("shows Start Plan success only when the server confirms it", () => {
    expect(source).toContain("setStartPlanInitialized(data.startPlanInitialized === true);");
    expect(source).toContain("{startPlanInitialized");
    expect(source).not.toContain("{initializeStartPlan && !successWarning");
  });
});
