import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

// Gemini Schema proto requires `type` on EVERY schema node. JSON Schema allows
// typeless nodes; Google upstream rejects them with
// "* GenerateContentRequest.tools[0].function_declarations[N].parameters...
//    .items.items: missing field." (HTTP 400 INVALID_ARGUMENT)

describe("cleanJSONSchemaForAntigravity — missing type repair", () => {
  it("assigns type=array to nodes that only have items", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        tags: { items: { type: "string" } },
      },
    });
    expect(out.properties.tags.type).toBe("array");
    expect(out.properties.tags.items.type).toBe("string");
  });

  it("repairs the nested items.items shape rejected by upstream", () => {
    // Mirrors: properties[query].properties[where].items.items: missing field
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        query: {
          type: "object",
          properties: {
            where: {
              type: "array",
              description: "filter clauses",
              items: {
                type: "array",
                items: { description: "a value" },
              },
            },
          },
        },
      },
    });
    const where = out.properties.query.properties.where;
    expect(where.type).toBe("array");
    expect(where.items.type).toBe("array");
    expect(where.items.items.type).toBeTruthy();
  });

  it("converts tuple items to a single schema (Gemini proto has no tuple)", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        pair: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        },
      },
    });
    const items = out.properties.pair.items;
    expect(Array.isArray(items)).toBe(false);
    expect(items.type).toBeTruthy();
  });

  it("defaults description-only leaf nodes to type=string", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        note: { description: "freeform note" },
      },
    });
    expect(out.properties.note.type).toBe("string");
  });

  it("leaves fully typed schemas untouched", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
      },
      required: ["name"],
    };
    const out = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(out).toEqual(schema);
  });
});
