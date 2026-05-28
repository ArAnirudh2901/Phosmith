import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getNeonAuthContext } from "@/lib/neon/auth";
import { runNeonMutation } from "@/lib/neon/functions";

export async function POST() {
    const { userId, has } = await auth();

    if (!userId) {
        return NextResponse.json(
            { error: "Unauthorized" },
            { status: 401 },
        );
    }

    const plan = has?.({ plan: "pro" }) ? "pro" : "free";
    const neonAuth = await getNeonAuthContext();

    await runNeonMutation("users.syncPlan", { plan }, { auth: neonAuth });

    return NextResponse.json({ plan });
}
