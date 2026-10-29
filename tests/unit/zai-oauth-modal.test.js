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

  it("keeps the running poll synchronized with the checkbox", () => {
    expect(source).toContain("const checked = event.target.checked;");
    expect(source).toContain("initializeStartPlanRef.current = checked;");
    expect(source).toContain("setInitializeStartPlan(checked);");
    expect(source).toContain("initializeStartPlan: initializeStartPlanRef.current");
  });
});
