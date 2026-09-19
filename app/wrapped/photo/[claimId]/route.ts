import { NextResponse } from "next/server";
import { wrappedPhotoRedirect } from "@/lib/wrapped/load";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const { claimId } = await params;
  const url = await wrappedPhotoRedirect(claimId);
  if (!url) return new NextResponse(null, { status: 404 });
  return NextResponse.redirect(url, 307);
}
