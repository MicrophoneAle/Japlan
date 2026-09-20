import { LiveExperience } from "../[tripId]/live-experience";
import { demo } from "./data";

export const metadata = {
  title: "Japlan Live: Demo",
  description: "A demo of Japlan's live trip companion.",
};

export default function LiveDemoPage() {
  return <LiveExperience initialData={demo} poll={false} />;
}
