import { NextResponse } from "next/server";
import { createRequire } from "node:module";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";

const require = createRequire(import.meta.url);
const { queryAccess } = require("../../../../../inference-access-log.cjs");

export const dynamic = "force-dynamic";

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const page = params.has("page") ? Number(params.get("page")) : 1;
  const pageSize = params.has("pageSize") ? Number(params.get("pageSize")) : 20;
  const status = params.get("status");
  const startDate = params.get("startDate");
  const endDate = params.get("endDate");
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      (status !== null && (!/^\d{3}$/.test(status) || Number(status) < 100 || Number(status) > 599)) ||
      (startDate && Number.isNaN(Date.parse(startDate))) || (endDate && Number.isNaN(Date.parse(endDate)))) {
    return NextResponse.json({ error: "Invalid filter" }, { status: 400 });
  }

  try {
    const result = queryAccess({
      apiKeyId: params.get("apiKeyId") || "",
      ip: params.get("ip") || "",
      startDate: startDate ? new Date(startDate).toISOString() : "",
      endDate: endDate ? new Date(endDate).toISOString() : "",
      status: status === null ? null : Number(status),
      page, pageSize,
    });
    const keys = await getApiKeys();
    const names = new Map(keys.map((key) => [key.id, key.name]));
    return NextResponse.json({
      ...result,
      rows: result.rows.map((row) => ({ ...row, apiKeyName: row.apiKeyId ? names.get(row.apiKeyId) || "Deleted key" : "No API key" })),
    });
  } catch (error) {
    console.error("[API] Failed to fetch IP access records:", error);
    return NextResponse.json({ error: "Failed to fetch IP access records" }, { status: 500 });
  }
}
