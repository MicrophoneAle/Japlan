import { ImageResponse } from "next/og";
import { demo } from "./data";

// Next's file convention: a sibling opengraph-image in this route segment is
// picked up automatically and wired into og:image (and the twitter card)
// with no manual metadata reference needed. Final standings, not the route
// map: it's the data this demo actually has, ranked, no map/geo needed.
export const alt = "Japlan Wrapped: final standings";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  // Top 4: five headline rows plus the header text doesn't fit 630px without
  // crowding. Scales to trips with fewer people too.
  const ranked = [...demo.people].sort((a, b) => a.rank - b.rank).slice(0, 4);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f5d4ff",
          color: "#281d52",
          fontFamily: "Arial, Helvetica, sans-serif",
          padding: "56px 76px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 22, fontWeight: 800, letterSpacing: 4, textTransform: "uppercase" }}>
            japlan wrapped
          </div>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 900, letterSpacing: -2, marginTop: 14 }}>
            final standings
          </div>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 700, marginTop: 14, color: "#f5519e" }}>
            {`${demo.trip.destination} · ${demo.trip.dates}`}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {ranked.map((person) => (
            <div
              key={person.name}
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                borderBottom: "3px solid #281d52",
                paddingBottom: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
                <div style={{ display: "flex", fontSize: 28, fontWeight: 900, width: 54 }}>{`#${person.rank}`}</div>
                <div style={{ display: "flex", fontSize: 34, fontWeight: 800 }}>{person.name}</div>
              </div>
              <div style={{ display: "flex", fontSize: 40, fontWeight: 900, letterSpacing: -1 }}>
                {person.score}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
