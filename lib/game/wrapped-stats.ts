export function wrappedQuestCount(
  claims: { status: string; awarded_points?: number | null; capped?: boolean }[],
): number {
  return claims.filter((claim) => claim.status === "awarded").length;
}
