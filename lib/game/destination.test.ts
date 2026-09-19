import { describe, expect, it } from "vitest";
import {
  cachedDestinationProfile,
  needsFoursquareFetch,
} from "./destination";
import { TOKYO_HAND_PROFILE } from "./tokyo-profile";

describe("destination profile cache", () => {
  it("skips Foursquare when destination_profile_json is already present", () => {
    expect(
      needsFoursquareFetch({ destination_profile_json: TOKYO_HAND_PROFILE }),
    ).toBe(false);
    expect(needsFoursquareFetch({ destination_profile_json: null })).toBe(true);
    const cached = cachedDestinationProfile({
      destination_profile_json: TOKYO_HAND_PROFILE,
    });
    expect(cached?.destination).toBe("Tokyo");
    expect(cached?.neighborhoods.length).toBeGreaterThan(0);
    expect(cached?.landmarks[0]).toMatchObject({
      name: expect.any(String),
      lat: expect.any(Number),
      lng: expect.any(Number),
    });
    expect(cached?.center).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(cached?.price_bands).toEqual([1, 2, 3]);
  });
});
