import { NextRequest, NextResponse } from "next/server";
import { setStatus, deleteTest, getTestFull } from "@/lib/tests";

// Gated by auth middleware.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const full = await getTestFull(id);
  if (!full) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(full);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { action } = await req.json();
    if (!["start", "pause", "end"].includes(action)) {
      return NextResponse.json({ error: "action must be start|pause|end" }, { status: 400 });
    }
    await setStatus(id, action);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteTest(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 400 });
  }
}
