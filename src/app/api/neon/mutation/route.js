import { NextResponse } from "next/server";
import { isDatabaseSetupError } from "@/lib/database-errors";
import { getNeonAuthContext } from "@/lib/neon/auth";
import { toSafeErrorMessage } from "@/lib/neon/safe-error";
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
    console.error(`[neon] ${error?.message || error}`);
    return NextResponse.json(
      {
        error: toSafeErrorMessage(error, "Could not save your change. Please try again."),
        code: error?.code,
        setupRequired,
      },
      { status: setupRequired ? 503 : 500 },
    );
  }
}
