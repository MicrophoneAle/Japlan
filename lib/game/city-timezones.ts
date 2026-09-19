// Destination text to IANA timezone with no API. Two sources:
//  1. Every city the runtime's own zone database names ("Asia/Tokyo" ->
//     "tokyo", "America/New_York" -> "new york"), about 400 cities.
//  2. Popular trip destinations and countries whose zone is not named after
//     them (Osaka, Kyoto, Bali, Barcelona, "japan").
// Ambiguous or unknown text returns null and the caller falls back to Gemini.

const ALIASES: Record<string, string> = {
  // Japan
  japan: "Asia/Tokyo", osaka: "Asia/Tokyo", kyoto: "Asia/Tokyo", nara: "Asia/Tokyo",
  sapporo: "Asia/Tokyo", fukuoka: "Asia/Tokyo", okinawa: "Asia/Tokyo", naha: "Asia/Tokyo",
  hiroshima: "Asia/Tokyo", nagoya: "Asia/Tokyo", yokohama: "Asia/Tokyo", kobe: "Asia/Tokyo",
  hakone: "Asia/Tokyo", nikko: "Asia/Tokyo", kanazawa: "Asia/Tokyo", niseko: "Asia/Tokyo",
  // East and South-East Asia
  "south korea": "Asia/Seoul", korea: "Asia/Seoul", busan: "Asia/Seoul", jeju: "Asia/Seoul",
  china: "Asia/Shanghai", beijing: "Asia/Shanghai", shenzhen: "Asia/Shanghai",
  guangzhou: "Asia/Shanghai", chengdu: "Asia/Shanghai", "xi'an": "Asia/Shanghai",
  taiwan: "Asia/Taipei", "hong kong": "Asia/Hong_Kong", macau: "Asia/Macau",
  thailand: "Asia/Bangkok", "chiang mai": "Asia/Bangkok", phuket: "Asia/Bangkok",
  vietnam: "Asia/Ho_Chi_Minh", hanoi: "Asia/Ho_Chi_Minh", "ho chi minh city": "Asia/Ho_Chi_Minh",
  saigon: "Asia/Ho_Chi_Minh", "da nang": "Asia/Ho_Chi_Minh", "hoi an": "Asia/Ho_Chi_Minh",
  bali: "Asia/Makassar", denpasar: "Asia/Makassar", ubud: "Asia/Makassar",
  indonesia: "Asia/Jakarta", philippines: "Asia/Manila", cebu: "Asia/Manila",
  malaysia: "Asia/Kuala_Lumpur", cambodia: "Asia/Phnom_Penh", "siem reap": "Asia/Phnom_Penh",
  laos: "Asia/Vientiane", "luang prabang": "Asia/Vientiane",
  // South Asia and the Middle East
  india: "Asia/Kolkata", delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata",
  mumbai: "Asia/Kolkata", bangalore: "Asia/Kolkata", goa: "Asia/Kolkata", jaipur: "Asia/Kolkata",
  "sri lanka": "Asia/Colombo", nepal: "Asia/Kathmandu", maldives: "Indian/Maldives",
  uae: "Asia/Dubai", "abu dhabi": "Asia/Dubai", israel: "Asia/Jerusalem", "tel aviv": "Asia/Jerusalem",
  turkey: "Europe/Istanbul", "turkiye": "Europe/Istanbul", jordan: "Asia/Amman",
  // Europe
  uk: "Europe/London", "united kingdom": "Europe/London", england: "Europe/London",
  scotland: "Europe/London", edinburgh: "Europe/London", manchester: "Europe/London",
  ireland: "Europe/Dublin", france: "Europe/Paris", nice: "Europe/Paris", lyon: "Europe/Paris",
  marseille: "Europe/Paris", spain: "Europe/Madrid", barcelona: "Europe/Madrid",
  seville: "Europe/Madrid", ibiza: "Europe/Madrid", mallorca: "Europe/Madrid",
  italy: "Europe/Rome", milan: "Europe/Rome", florence: "Europe/Rome", venice: "Europe/Rome",
  naples: "Europe/Rome", "amalfi coast": "Europe/Rome", germany: "Europe/Berlin",
  munich: "Europe/Berlin", hamburg: "Europe/Berlin", frankfurt: "Europe/Berlin",
  netherlands: "Europe/Amsterdam", portugal: "Europe/Lisbon", porto: "Europe/Lisbon",
  greece: "Europe/Athens", santorini: "Europe/Athens", mykonos: "Europe/Athens",
  croatia: "Europe/Zagreb", split: "Europe/Zagreb", dubrovnik: "Europe/Zagreb",
  "czech republic": "Europe/Prague", czechia: "Europe/Prague", austria: "Europe/Vienna",
  switzerland: "Europe/Zurich", geneva: "Europe/Zurich", hungary: "Europe/Budapest",
  poland: "Europe/Warsaw", krakow: "Europe/Warsaw", denmark: "Europe/Copenhagen",
  sweden: "Europe/Stockholm", norway: "Europe/Oslo", finland: "Europe/Helsinki",
  iceland: "Atlantic/Reykjavik", belgium: "Europe/Brussels",
  // Americas
  "new york city": "America/New_York", nyc: "America/New_York", brooklyn: "America/New_York",
  boston: "America/New_York", miami: "America/New_York", "washington dc": "America/New_York",
  "washington d.c.": "America/New_York", philadelphia: "America/New_York",
  atlanta: "America/New_York", orlando: "America/New_York",
  "new orleans": "America/Chicago", austin: "America/Chicago", houston: "America/Chicago",
  dallas: "America/Chicago", nashville: "America/Chicago",
  "las vegas": "America/Los_Angeles", vegas: "America/Los_Angeles", la: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles", sf: "America/Los_Angeles", seattle: "America/Los_Angeles",
  "san diego": "America/Los_Angeles",
  hawaii: "Pacific/Honolulu", maui: "Pacific/Honolulu", oahu: "Pacific/Honolulu",
  montreal: "America/Toronto", quebec: "America/Toronto", ottawa: "America/Toronto",
  "mexico city": "America/Mexico_City", cdmx: "America/Mexico_City", cancun: "America/Cancun",
  tulum: "America/Cancun", "puerto rico": "America/Puerto_Rico",
  peru: "America/Lima", cusco: "America/Lima", colombia: "America/Bogota",
  medellin: "America/Bogota", argentina: "America/Argentina/Buenos_Aires",
  "rio de janeiro": "America/Sao_Paulo", rio: "America/Sao_Paulo", chile: "America/Santiago",
  // Africa and Oceania
  morocco: "Africa/Casablanca", marrakech: "Africa/Casablanca", egypt: "Africa/Cairo",
  kenya: "Africa/Nairobi", "cape town": "Africa/Johannesburg", "south africa": "Africa/Johannesburg",
  "new zealand": "Pacific/Auckland", queenstown: "Pacific/Auckland", fiji: "Pacific/Fiji",
};

// Zone-database cities that are also common place names elsewhere.
const AMBIGUOUS = new Set(["kingston", "vancouver", "victoria", "santiago", "cordoba", "mendoza"]);

// Combining accent marks left after NFD, so "Zürich" matches "zurich".
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

let zoneCities: Map<string, string> | null = null;

function citiesFromZoneDatabase(): Map<string, string> {
  if (zoneCities) return zoneCities;
  zoneCities = new Map();
  const zones =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  for (const zone of zones) {
    const city = zone.split("/").at(-1);
    if (!city || !zone.includes("/")) continue;
    const name = normalize(city.replace(/_/g, " "));
    if (AMBIGUOUS.has(name)) continue;
    if (!zoneCities.has(name)) zoneCities.set(name, zone);
  }
  return zoneCities;
}

export type CityTimezone = { timezone: string; matched: string; source: "alias" | "zone_database" };

// "Tokyo", "tokyo, japan", "Kyoto Japan", "  osaka!" all resolve.
export function lookupCityTimezone(text: string): CityTimezone | null {
  const whole = normalize(text);
  if (!whole) return null;
  // Whole text, then the part before a comma, then without a trailing word
  // ("kyoto japan"). Never the first word alone: "la paz" is not LA.
  const candidates = [
    whole,
    normalize(whole.split(",")[0]),
    whole.split(" ").slice(0, -1).join(" "),
  ].filter((c, i, all) => c && all.indexOf(c) === i);

  for (const candidate of candidates) {
    const alias = ALIASES[candidate];
    if (alias) return { timezone: alias, matched: candidate, source: "alias" };
    const zone = citiesFromZoneDatabase().get(candidate);
    if (zone) return { timezone: zone, matched: candidate, source: "zone_database" };
  }
  return null;
}
