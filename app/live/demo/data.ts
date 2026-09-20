// Fictional fixture for /live/demo, the same role app/wrapped/data.ts plays
// for /wrapped: lets the page (and this feature's design) be built and
// demoed before it depends on a real trip. Shape matches LiveTripData
// exactly, so the same component renders both this and a real trip.
import type { LiveTripData } from "@/lib/live/data";

export const demo: LiveTripData = {
  trip: {
    id: "demo",
    name: "the long weekend that got competitive",
    destination: "Tokyo",
    day: 3,
    totalDays: 5,
    route: "Asakusa → Ueno",
    peopleCount: 4,
    teamCount: 2,
  },
  standings: [
    { id: "p1", name: "Sarah", rank: 1, score: 160, pointsToday: 25, tasksCompleted: 9, teamId: "tA", teamName: "Team Sigma" },
    { id: "p2", name: "Michael", rank: 2, score: 145, pointsToday: 40, tasksCompleted: 8, teamId: "tB", teamName: "Team Chud" },
    { id: "p3", name: "Dev", rank: 3, score: 132, pointsToday: 18, tasksCompleted: 7, teamId: "tB", teamName: "Team Chud" },
    { id: "p4", name: "Jess", rank: 4, score: 95, pointsToday: 5, tasksCompleted: 6, teamId: "tA", teamName: "Team Sigma" },
  ],
  teams: [
    { id: "tA", name: "Team Sigma", color: "#e8836b", memberNames: ["Sarah", "Jess"], score: 255, tasksCompleted: 15 },
    { id: "tB", name: "Team Chud", color: "#5b8a72", memberNames: ["Michael", "Dev"], score: 277, tasksCompleted: 15 },
  ],
  tasks: {
    active: [
      {
        id: "t1", code: "C3", title: "get from Senso-ji to Ueno without a train", tier: "Challenging",
        points: 30, multiplier: null, verification: "photo", status: "open",
        assignee: "Sarah + Jess", neighborhood: "Asakusa", expiresAt: "2026-09-20T08:20:00Z",
        completedBy: null, awardedPoints: null, photo: null,
      },
      {
        id: "t2", code: "C4", title: "find a vending machine selling something you can't name", tier: "Medium",
        points: 20, multiplier: { points: 40, label: "2x" }, verification: "photo", status: "open",
        assignee: "Michael", neighborhood: "Ueno", expiresAt: "2026-09-20T09:00:00Z",
        completedBy: null, awardedPoints: null, photo: null,
      },
      {
        id: "t3", code: "C5", title: "get a stranger to recommend their favorite ramen spot", tier: "Challenging",
        points: 28, multiplier: null, verification: "honor", status: "open",
        assignee: "Dev", neighborhood: "Ueno", expiresAt: "2026-09-20T07:00:00Z",
        completedBy: null, awardedPoints: null, photo: null,
      },
    ],
    completed: [
      {
        id: "t4", code: "C2", title: "eat something you can't pronounce", tier: "Medium",
        points: 20, multiplier: null, verification: "photo", status: "completed",
        assignee: "Sarah", neighborhood: "Asakusa", expiresAt: null,
        completedBy: "Sarah", awardedPoints: 20, photo: "/assets/images.jpg",
      },
      {
        id: "t5", code: "C1", title: "take the weirdest vending machine photo you can find", tier: "Light",
        points: 12, multiplier: null, verification: "photo", status: "completed",
        assignee: "Michael", neighborhood: "Asakusa", expiresAt: null,
        completedBy: "Michael", awardedPoints: 12, photo: "/assets/images (1).jpg",
      },
    ],
  },
  proof: [
    { id: "t4", code: "C2", title: "eat something you can't pronounce", tier: "Medium", points: 20, multiplier: null, verification: "photo", status: "completed", assignee: "Sarah", neighborhood: "Asakusa", expiresAt: null, completedBy: "Sarah", awardedPoints: 20, photo: "/assets/images.jpg" },
    { id: "t5", code: "C1", title: "take the weirdest vending machine photo you can find", tier: "Light", points: 12, multiplier: null, verification: "photo", status: "completed", assignee: "Michael", neighborhood: "Asakusa", expiresAt: null, completedBy: "Michael", awardedPoints: 12, photo: "/assets/images (1).jpg" },
  ],
  itinerary: [
    { order: 1, place: "Senso-ji", time: "10:00 AM", status: "done" },
    { order: 2, place: "Ueno Park", time: "2:00 PM", status: "current" },
    { order: 3, place: "Ameyoko", time: "7:00 PM", status: "upcoming" },
  ],
  activity: [
    { at: "2026-09-20T05:58:00Z", text: "Dev completed C3 · +30" },
    { at: "2026-09-20T05:50:00Z", text: "Japlan issued a sidequest to Sarah" },
    { at: "2026-09-20T05:44:00Z", text: "Sarah completed C2 · +20" },
    { at: "2026-09-20T05:30:00Z", text: "Team Sigma formed: Sarah + Jess" },
  ],
  stats: {
    questsCompleted: 17,
    questsAttempted: 19,
    photosSubmitted: 14,
    placesVisited: 11,
    totalPoints: 532,
  },
  japlanSays: "Michael is having a day: +40 so far.",
};
