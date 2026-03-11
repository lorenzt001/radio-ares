import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearSessionCookie, deleteSession } from "@/lib/auth";

export async function POST() {
  const cookieStore = await cookies();
  const token = cookieStore.get("ra_session")?.value;
  if (token) {
    await deleteSession(token).catch(() => null);
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
