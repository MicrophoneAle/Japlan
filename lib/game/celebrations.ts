// Small, loopable celebration GIFs used after a task earns points.
// GIPHY's 200w renditions keep each message lightweight.
const CELEBRATION_GIFS = [
  "https://media.giphy.com/media/9ieKwMkvD5O3yeFBeA/200w.gif", // happy dance
  "https://media.giphy.com/media/aOF5DW9GJvVk2xwKW2/200w.gif", // dancing robot
  "https://media.giphy.com/media/l0IygWpszunxnkMAo/200w.gif", // party confetti
  "https://media.giphy.com/media/Ng9p1jkeU1uBrvR8VX/200w.gif", // applause
  "https://media.giphy.com/media/3o6vY59GeufMIQRcGc/200w.gif", // victory dance
] as const;

export function pickCelebrationGif(): string {
  return CELEBRATION_GIFS[Math.floor(Math.random() * CELEBRATION_GIFS.length)];
}
