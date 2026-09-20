import { describe, expect, it } from "vitest";
import { looksLikeRawHandle, personLabel } from "./handle";

// A number in a group message is a leak, not a cosmetic glitch. There used to
// be two of these guards that disagreed about the same value.
describe("a raw handle is not a name", () => {
  it("catches every phone shape Linq has handed back", () => {
    for (const value of [
      "+19057580877",
      "19057580877",
      "09057580877",
      "(905) 758-0877",
      "905-758-0877",
      "905.758.0877",
      "+81 90 1234 5678",
      " +19057580877 ",
    ]) {
      expect(looksLikeRawHandle(value)).toBe(true);
    }
  });

  it("catches an Apple ID email, which is just as personal", () => {
    expect(looksLikeRawHandle("mike@icloud.com")).toBe(true);
    expect(looksLikeRawHandle("m.liu+trips@gmail.co.uk")).toBe(true);
  });

  it("leaves real names alone, including ones with digits or punctuation", () => {
    for (const value of ["Mike", "Sam O'Brien", "Anne-Marie", "J", "mike2", "3LAU", "会長"]) {
      expect(looksLikeRawHandle(value)).toBe(false);
    }
  });

  it("does not call a short number a handle", () => {
    // Too few digits to be a phone number, so more likely a nickname.
    expect(looksLikeRawHandle("101")).toBe(false);
  });

  it("is empty-safe", () => {
    expect(looksLikeRawHandle("")).toBe(false);
    expect(looksLikeRawHandle(null)).toBe(false);
    expect(looksLikeRawHandle(undefined)).toBe(false);
  });
});

describe("what gets printed instead", () => {
  it("swaps a handle for the site's own fallback", () => {
    expect(personLabel("+19057580877")).toBe("the organizer");
    expect(personLabel("(905) 758-0877", "someone")).toBe("someone");
    expect(personLabel("mike@icloud.com", "someone")).toBe("someone");
    expect(personLabel(null, "someone")).toBe("someone");
    expect(personLabel("   ", "someone")).toBe("someone");
  });

  it("passes a real name straight through, trimmed", () => {
    expect(personLabel("Mike")).toBe("Mike");
    expect(personLabel("  Sam  ", "someone")).toBe("Sam");
  });
});
