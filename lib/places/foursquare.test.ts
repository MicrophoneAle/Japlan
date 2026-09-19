import { describe, expect, it } from "vitest";
import { parseFoursquarePlace, SEARCH_FIELDS } from "./foursquare";

describe("Foursquare place parse", () => {
  it("projects only core fields, not Premium attributes", () => {
    const fields = SEARCH_FIELDS.split(",");
    expect(fields).toEqual([
      "fsq_place_id",
      "name",
      "latitude",
      "longitude",
      "location",
      "categories",
    ]);
    for (const premium of [
      "photos",
      "tips",
      "rating",
      "popularity",
      "price",
      "tastes",
      "hours",
    ]) {
      expect(fields).not.toContain(premium);
    }
  });
  it("stores fsq_place_id and ignores fsq_id", () => {
    const place = parseFoursquarePlace({
      fsq_id: "legacy-id",
      fsq_place_id: "place-id",
      name: "Senso-ji",
      latitude: 35.71,
      longitude: 139.79,
      location: { neighborhood: ["Asakusa"], locality: "Tokyo" },
      categories: [{ name: "Shrine" }],
      price: 1,
      tastes: [],
    });
    expect(place?.fsq_place_id).toBe("place-id");
    expect(place?.name).toBe("Senso-ji");
    expect(place?.neighborhood).toBe("Asakusa");
  });

  it("drops a result that only has the legacy fsq_id", () => {
    expect(
      parseFoursquarePlace({
        fsq_id: "legacy-id",
        name: "Senso-ji",
      }),
    ).toBeNull();
  });
});
