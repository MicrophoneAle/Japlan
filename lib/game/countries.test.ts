import { describe, expect, it } from "vitest";
import { countryForTimezone, countryForTrip } from "./countries";
import { lookupCityTimezone } from "./city-timezones";

describe("which country to ask for holidays", () => {
  it("uses the trip's own resolved timezone first", () => {
    expect(countryForTrip({ destination: "Tokyo", timezone: "Asia/Tokyo" })).toBe("JP");
    expect(countryForTrip({ destination: "Barcelona", timezone: "Europe/Madrid" })).toBe("ES");
    expect(countryForTrip({ destination: "Bali", timezone: "Asia/Makassar" })).toBe("ID");
  });

  it("falls back to the destination text when the trip has no timezone yet", () => {
    expect(countryForTrip({ destination: "kyoto", timezone: null })).toBe("JP");
    expect(countryForTrip({ destination: "mexico city", timezone: null })).toBe("MX");
    expect(countryForTrip({ destination: "lisbon, portugal", timezone: null })).toBe("PT");
  });

  it("maps every timezone of a multi-zone country back to the same code", () => {
    for (const zone of ["America/New_York", "America/Chicago", "America/Los_Angeles", "Pacific/Honolulu"]) {
      expect(countryForTimezone(zone)).toBe("US");
    }
    for (const zone of ["Australia/Sydney", "Australia/Perth", "Australia/Darwin"]) {
      expect(countryForTimezone(zone)).toBe("AU");
    }
  });

  it("says nothing rather than guessing a country it does not know", () => {
    expect(countryForTimezone("Antarctica/McMurdo")).toBeNull();
    expect(countryForTimezone(null)).toBeNull();
    expect(countryForTrip({ destination: "that place jess found", timezone: null })).toBeNull();
    expect(countryForTrip({ destination: null, timezone: null })).toBeNull();
  });

  // The holiday lookup is only as good as this map, so every destination the
  // alias table can name has to come out with a country.
  it("covers every alias the destination lookup can resolve", () => {
    const destinations = [
      "japan", "osaka", "seoul", "taiwan", "hong kong", "thailand", "vietnam", "bali",
      "singapore", "india", "uae", "turkey", "uk", "ireland", "france", "spain", "italy",
      "germany", "netherlands", "portugal", "greece", "croatia", "czechia", "austria",
      "switzerland", "hungary", "poland", "denmark", "sweden", "norway", "finland",
      "iceland", "belgium", "nyc", "boston", "austin", "las vegas", "hawaii", "montreal",
      "mexico city", "cancun", "peru", "colombia", "argentina", "rio", "chile", "morocco",
      "egypt", "kenya", "cape town", "new zealand", "fiji",
    ];
    const unmapped = destinations.filter((text) => {
      const zone = lookupCityTimezone(text)?.timezone;
      return !zone || !countryForTimezone(zone);
    });
    expect(unmapped).toEqual([]);
  });
});
