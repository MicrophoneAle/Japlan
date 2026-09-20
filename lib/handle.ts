// A raw Linq handle is not a name.
//
// Linq hands back the phone number (or the Apple ID email) whenever the
// contact has no display name, and a participant keeps it until they answer
// the name question. Printing "+19057580877 asked for the shared board" in a
// group chat leaks someone's number to everyone in it, so every render site
// checks this before showing a stored display_name.
//
// One function on purpose. There were two, and they disagreed: the copy.ts
// one caught "(905) 758-0877", the payload.ts one did not, so the same value
// was a name in one message and a number in another.
//
// Its own module (like lib/timeout.ts) so both the transport adapter and the
// pure game layer can use it without either importing the other.

// mike@icloud.com. An Apple ID handle is exactly as personal as the number.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// +19057580877, 09057580877, (905) 758-0877, 905.758.0877: digits and
// dialling punctuation, nothing else. Seven digits is the shortest real
// number; anything shorter is more likely a nickname than a handle.
const DIAL_PUNCTUATION_ONLY_RE = /^[+()\-.\s0-9]+$/;
const MIN_PHONE_DIGITS = 7;

export function looksLikeRawHandle(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return false;
  if (EMAIL_RE.test(trimmed)) return true;
  if (!DIAL_PUNCTUATION_ONLY_RE.test(trimmed)) return false;
  return trimmed.replace(/[^0-9]/g, "").length >= MIN_PHONE_DIGITS;
}

// What to print instead. The fallback is per site: "the organizer" when the
// sentence is about the role, "someone" on a leaderboard row.
export function personLabel(
  name: string | null | undefined,
  fallback = "the organizer",
): string {
  const value = (name ?? "").trim();
  if (!value || looksLikeRawHandle(value)) return fallback;
  return value;
}
