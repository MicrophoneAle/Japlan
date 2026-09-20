import { describe, expect, it } from "vitest";
import {
  classifyUrl,
  cleanTrackingParams,
  findUrls,
  isShortMapsLink,
  parseGoogleMapsUrl,
} from "./urls";

describe("finding links in a message", () => {
  it("picks links out of ordinary chat", () => {
    expect(findUrls("look at this https://www.tiktok.com/@a/video/123 fire")).toEqual([
      "https://www.tiktok.com/@a/video/123",
    ]);
    expect(findUrls("no links here lol")).toEqual([]);
  });

  it("drops the punctuation someone typed after the link", () => {
    expect(findUrls("go here https://example.com/a-place.")).toEqual(["https://example.com/a-place"]);
    expect(findUrls("(https://example.com/x)")).toEqual(["https://example.com/x"]);
  });

  it("returns each link once even when it is pasted twice", () => {
    const text = "https://example.com/a and again https://example.com/a";
    expect(findUrls(text)).toEqual(["https://example.com/a"]);
  });

  it("finds several links in one message, which is the failure case to survive", () => {
    const text = [
      "https://www.tiktok.com/@a/video/1",
      "https://www.instagram.com/reel/AAA/",
      "https://maps.app.goo.gl/xyz",
    ].join(" then ");
    expect(findUrls(text)).toHaveLength(3);
  });
});

describe("which route a link takes", () => {
  it("routes each platform to the thing that actually works for it", () => {
    // TikTok blocks a headless fetch, so it goes to oEmbed.
    expect(classifyUrl("https://www.tiktok.com/@user/video/123")).toBe("tiktok");
    expect(classifyUrl("https://vm.tiktok.com/ZSabc/")).toBe("tiktok");
    // Instagram's logged-out page still carries the caption.
    expect(classifyUrl("https://www.instagram.com/reel/DIL2xrXTj3f/")).toBe("instagram");
    expect(classifyUrl("https://instagram.com/p/ABC/")).toBe("instagram");
    // Maps never touches a browser at all.
    expect(classifyUrl("https://www.google.com/maps/place/Ramen/@35.6,139.7,17z")).toBe("maps");
    expect(classifyUrl("https://maps.app.goo.gl/abc123")).toBe("maps");
    // Anything else is an article.
    expect(classifyUrl("https://www.timeout.com/tokyo/best-ramen")).toBe("article");
    // A non-maps Google link is just a page.
    expect(classifyUrl("https://www.google.com/search?q=ramen")).toBe("article");
  });

  it("says nothing about text that is not a link", () => {
    expect(classifyUrl("not a url")).toBeNull();
    expect(classifyUrl("")).toBeNull();
  });

  it("knows which maps links need a redirect hop first", () => {
    expect(isShortMapsLink("https://maps.app.goo.gl/abc")).toBe(true);
    expect(isShortMapsLink("https://www.google.com/maps/place/X/@1.0,2.0,17z")).toBe(false);
  });
});

describe("reading a google maps link with no browser", () => {
  it("takes the name and the coordinates straight off the url", () => {
    expect(
      parseGoogleMapsUrl("https://www.google.com/maps/place/Ramen+Break+Beats/@35.6321,139.6987,17z/data=x"),
    ).toEqual({ name: "Ramen Break Beats", lat: 35.6321, lng: 139.6987 });
  });

  it("reads a query-style link", () => {
    expect(parseGoogleMapsUrl("https://www.google.com/maps/search/?api=1&query=35.6321,139.6987")).toEqual({
      name: null,
      lat: 35.6321,
      lng: 139.6987,
    });
    expect(parseGoogleMapsUrl("https://maps.google.com/?q=Tokyo+Tower")).toMatchObject({
      name: "Tokyo Tower",
    });
  });

  it("does not mistake a coordinate pair for a place name", () => {
    const found = parseGoogleMapsUrl("https://www.google.com/maps/place/35.6,139.7/@35.6,139.7,17z");
    expect(found?.name).toBeNull();
    expect(found?.lat).toBe(35.6);
  });

  it("refuses coordinates that are not real, rather than storing them", () => {
    const found = parseGoogleMapsUrl("https://www.google.com/maps/place/X/@999.0,139.7,17z");
    expect(found?.name).toBe("X");
    expect(found?.lat).toBeNull();
    expect(found?.lng).toBeNull();
  });

  it("says nothing when the url says nothing", () => {
    expect(parseGoogleMapsUrl("https://www.google.com/maps")).toBeNull();
    expect(parseGoogleMapsUrl("not a url")).toBeNull();
  });

  it("decodes the escaping google puts in a place name", () => {
    expect(parseGoogleMapsUrl("https://www.google.com/maps/place/Caf%C3%A9+de+Paris/@48.8,2.3,17z")).toMatchObject({
      name: "Café de Paris",
    });
  });
});

describe("cleaning share links", () => {
  it("strips the tracking junk a share sheet adds", () => {
    const cleaned = cleanTrackingParams(
      "https://www.tiktok.com/@a/video/123?_t=8l7uftx5zLy&_r=1&utm_source=x",
    );
    expect(cleaned).not.toMatch(/_t=|_r=|utm_/);
    expect(cleaned).toContain("/@a/video/123");
  });

  it("leaves a link that carries no junk alone", () => {
    const url = "https://www.google.com/maps/place/X/@1.0,2.0,17z";
    expect(cleanTrackingParams(url)).toBe(url);
  });
});
