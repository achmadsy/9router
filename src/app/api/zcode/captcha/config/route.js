import { NextResponse } from "next/server";
import { getCaptchaManager } from "@/lib/zcode/captcha-service.js";

export async function GET() {
  try {
    const manager = getCaptchaManager();
    const config = await manager.fetchCaptchaConfig();
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
