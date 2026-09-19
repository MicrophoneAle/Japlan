import type { DestinationProfile } from "./destination";

export const TOKYO_HAND_PROFILE: DestinationProfile = {
  assembled_at: "2026-09-19T00:00:00.000Z",
  destination: "Tokyo",
  neighborhoods: [
    { name: "Asakusa", lat: 35.7148, lng: 139.7967 },
    { name: "Ueno", lat: 35.7142, lng: 139.7773 },
    { name: "Yanaka", lat: 35.728, lng: 139.769 },
    { name: "Shibuya", lat: 35.6595, lng: 139.7004 },
    { name: "Shimokitazawa", lat: 35.6616, lng: 139.6677 },
    { name: "Koenji", lat: 35.7054, lng: 139.6499 },
    { name: "Nakameguro", lat: 35.6442, lng: 139.6982 },
    { name: "Kichijoji", lat: 35.7022, lng: 139.5797 },
  ],
  transit_lines: [
    "Yamanote Line",
    "Ginza Line",
    "Chuo-Sobu Line",
    "Hibiya Line",
  ],
  dishes: [
    "ramen",
    "onigiri",
    "yakitori",
    "okonomiyaki",
    "monjayaki",
    "taiyaki",
    "udon",
    "tonkatsu",
  ],
  landmarks: [
    {
      name: "Senso-ji",
      lat: 35.7148,
      lng: 139.7967,
      category: "Shrine",
    },
    {
      name: "Tokyo Tower",
      lat: 35.6586,
      lng: 139.7454,
      category: "Landmark",
    },
    {
      name: "Ueno Park",
      lat: 35.7148,
      lng: 139.7714,
      category: "Park",
    },
    {
      name: "Meiji Jingu",
      lat: 35.6764,
      lng: 139.6993,
      category: "Shrine",
    },
    {
      name: "Shibuya Crossing",
      lat: 35.6595,
      lng: 139.7004,
      category: "Landmark",
    },
  ],
  price_bands: [1, 2, 3],
  center: { lat: 35.6812, lng: 139.7671 },
};
