// Destination text to an ISO 3166-1 alpha-2 country code, with no network.
//
// Public holidays are a per-country, per-year dataset (lib/holidays/nager.ts),
// so the holiday lookup needs a country. We already resolve every destination
// to an IANA timezone at setup (lib/game/city-timezones.ts), and in the IANA
// database a zone belongs to exactly one country, so the zone is the country
// key we already have. A country with several zones (the US, Brazil) maps
// every one of them back to the same code.
//
// Unknown text returns null and the caller does nothing: a trip with no
// country still gets its weekend multipliers, which need no lookup at all.

import { lookupCityTimezone } from "./city-timezones";

// IANA zone -> ISO 3166-1 alpha-2. Every zone lib/game/city-timezones.ts can
// produce from its alias table, plus the zone-database cities a destination is
// likely to resolve to. Anything missing is a miss, never a wrong country.
const ZONE_COUNTRY: Record<string, string> = {
  // East and South-East Asia
  "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Shanghai": "CN", "Asia/Taipei": "TW",
  "Asia/Hong_Kong": "HK", "Asia/Macau": "MO", "Asia/Bangkok": "TH",
  "Asia/Ho_Chi_Minh": "VN", "Asia/Jakarta": "ID", "Asia/Makassar": "ID",
  "Asia/Jayapura": "ID", "Asia/Manila": "PH", "Asia/Kuala_Lumpur": "MY",
  "Asia/Singapore": "SG", "Asia/Phnom_Penh": "KH", "Asia/Vientiane": "LA",
  "Asia/Yangon": "MM", "Asia/Ulaanbaatar": "MN", "Asia/Brunei": "BN",
  // South Asia and the Middle East
  "Asia/Kolkata": "IN", "Asia/Colombo": "LK", "Asia/Kathmandu": "NP",
  "Asia/Dhaka": "BD", "Asia/Karachi": "PK", "Indian/Maldives": "MV",
  "Asia/Dubai": "AE", "Asia/Qatar": "QA", "Asia/Kuwait": "KW", "Asia/Riyadh": "SA",
  "Asia/Muscat": "OM", "Asia/Bahrain": "BH", "Asia/Jerusalem": "IL",
  "Asia/Amman": "JO", "Asia/Beirut": "LB", "Asia/Baku": "AZ",
  "Asia/Tbilisi": "GE", "Asia/Yerevan": "AM", "Asia/Tashkent": "UZ",
  "Asia/Almaty": "KZ",
  // Europe
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR",
  "Europe/Madrid": "ES", "Europe/Rome": "IT", "Europe/Berlin": "DE",
  "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Luxembourg": "LU",
  "Europe/Lisbon": "PT", "Atlantic/Madeira": "PT", "Atlantic/Azores": "PT",
  "Europe/Athens": "GR", "Europe/Istanbul": "TR", "Europe/Zagreb": "HR",
  "Europe/Prague": "CZ", "Europe/Vienna": "AT", "Europe/Zurich": "CH",
  "Europe/Budapest": "HU", "Europe/Warsaw": "PL", "Europe/Copenhagen": "DK",
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Helsinki": "FI",
  "Atlantic/Reykjavik": "IS", "Europe/Bucharest": "RO", "Europe/Sofia": "BG",
  "Europe/Belgrade": "RS", "Europe/Ljubljana": "SI", "Europe/Bratislava": "SK",
  "Europe/Sarajevo": "BA", "Europe/Skopje": "MK", "Europe/Tirane": "AL",
  "Europe/Vilnius": "LT", "Europe/Riga": "LV", "Europe/Tallinn": "EE",
  "Europe/Malta": "MT", "Asia/Nicosia": "CY", "Europe/Moscow": "RU",
  "Europe/Kyiv": "UA", "Europe/Kiev": "UA", "Europe/Minsk": "BY",
  "Europe/Monaco": "MC", "Europe/Andorra": "AD",
  // North America
  "America/New_York": "US", "America/Detroit": "US", "America/Chicago": "US",
  "America/Denver": "US", "America/Phoenix": "US", "America/Los_Angeles": "US",
  "America/Anchorage": "US", "Pacific/Honolulu": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA",
  "America/Winnipeg": "CA", "America/Halifax": "CA", "America/St_Johns": "CA",
  "America/Mexico_City": "MX", "America/Cancun": "MX", "America/Tijuana": "MX",
  "America/Monterrey": "MX",
  // Central America and the Caribbean
  "America/Guatemala": "GT", "America/Belize": "BZ", "America/Costa_Rica": "CR",
  "America/Panama": "PA", "America/El_Salvador": "SV", "America/Tegucigalpa": "HN",
  "America/Managua": "NI", "America/Havana": "CU", "America/Jamaica": "JM",
  "America/Santo_Domingo": "DO", "America/Puerto_Rico": "PR",
  "America/Port_of_Spain": "TT", "America/Barbados": "BB", "America/Nassau": "BS",
  // South America
  "America/Lima": "PE", "America/Bogota": "CO", "America/Sao_Paulo": "BR",
  "America/Manaus": "BR", "America/Argentina/Buenos_Aires": "AR",
  "America/Santiago": "CL", "America/Montevideo": "UY", "America/Asuncion": "PY",
  "America/La_Paz": "BO", "America/Caracas": "VE", "America/Guayaquil": "EC",
  // Africa
  "Africa/Casablanca": "MA", "Africa/Cairo": "EG", "Africa/Tunis": "TN",
  "Africa/Algiers": "DZ", "Africa/Nairobi": "KE", "Africa/Dar_es_Salaam": "TZ",
  "Africa/Kampala": "UG", "Africa/Addis_Ababa": "ET", "Africa/Lagos": "NG",
  "Africa/Accra": "GH", "Africa/Dakar": "SN", "Africa/Johannesburg": "ZA",
  "Africa/Windhoek": "NA", "Africa/Harare": "ZW", "Indian/Mauritius": "MU",
  // Oceania
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU",
  "Australia/Perth": "AU", "Australia/Adelaide": "AU", "Australia/Hobart": "AU",
  "Australia/Darwin": "AU", "Pacific/Auckland": "NZ", "Pacific/Fiji": "FJ",
  "Pacific/Port_Moresby": "PG", "Pacific/Guam": "GU", "Pacific/Tahiti": "PF",
};

export function countryForTimezone(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  return ZONE_COUNTRY[timezone] ?? null;
}

// The trip's own resolved timezone first: setup already validated it, and a
// destination string can be anything ("that place jess found"). Falls back to
// resolving the destination text the same way setup does.
export function countryForTrip(trip: {
  destination?: string | null;
  timezone?: string | null;
}): string | null {
  const fromZone = countryForTimezone(trip.timezone);
  if (fromZone) return fromZone;
  const destination = trip.destination?.trim();
  if (!destination) return null;
  return countryForTimezone(lookupCityTimezone(destination)?.timezone);
}
