import { WrappedExperience } from "./wrapped-experience";

export const metadata = {
  title: "Japlan Wrapped: Demo",
  description: "A demo of Japlan's end-of-trip story.",
  // og:image comes from the sibling opengraph-image.tsx (Next's file
  // convention picks it up automatically); title/description still need to
  // be explicit, or a bare link posted in iMessage stays a bare link.
  openGraph: {
    title: "Japlan Wrapped: Demo",
    description: "Final standings, quests, and the trip's best moments.",
    type: "website",
  },
};

export default function WrappedDemoPage() {
  return <WrappedExperience />;
}
