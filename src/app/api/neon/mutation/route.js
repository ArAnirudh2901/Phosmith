import { NextResponse } from "next/server";
import { isDatabaseSetupError } from "@/lib/database-errors";
import { getNeonAuthContext } from "@/lib/neon/auth";
import { runNeonMutation } from "@/lib/neon/functions";

export async function POST(request) {
  try {
    const auth = await getNeonAuthContext();
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const name = body.name;
    if (!name) {
      return NextResponse.json({ error: "Missing mutation name" }, { status: 400 });
    }

    const data = await runNeonMutation(name, body.args || {}, { auth });
    return NextResponse.json({ data });
  } catch (error) {
    const setupRequired = isDatabaseSetupError(error);
    return NextResponse.json(
      {
        error: error?.message || "Neon mutation failed",
        code: error?.code,
        setupRequired,
      },
      { status: setupRequired ? 503 : 500 },
    );
  }
}
