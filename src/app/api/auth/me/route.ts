import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function GET() {
  await ensureSchema();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({ user });
}

