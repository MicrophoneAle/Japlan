"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { demo, type Person, type WrappedSlide } from "./data";
import styles from "./wrapped.module.css";

const ENTER = "animate-in";

function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let frame = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - began) / 900);
      setShown(Math.round(value * (1 - (1 - p) ** 3)));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{shown}</>;
}

function Photo({ photo, className, priority = false }: { photo: { src: string; alt: string } | null; className?: string; priority?: boolean }) {
  if (!photo) return null;
  return <img className={className} src={photo.src} alt={photo.alt} loading={priority ? "eager" : "lazy"} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />;
}

// Live names and recaps are longer than the demo copy. These phone-only
// guardrails reserve a readable copy zone before artwork fills the remainder.
function MobileLayoutGuards() {
  return <style>{`
    @media (max-width: 700px) {
      .${styles.slide} { padding-top: 4.6rem; padding-bottom: 5.6rem; }
      .${styles.kicker} { margin-bottom: .7rem; font-size: 9px; }
      .${styles.introCopy} { max-width: 92%; }
      .${styles.intro} h1,
      .${styles.stats} h2,
      .${styles.places} h2,
      .${styles.quests} h2,
      .${styles.leaderboard} h2,
      .${styles.photos} h2,
      .${styles.finale} h2,
      .${styles.personPhoto} h2,
      .${styles.personType} h2,
      .${styles.personCollage} h2 { font-size: clamp(2.65rem, 12.5vw, 4.25rem); line-height: .88; }

      .${styles.stats} h2 { max-width: 85%; }
      .${styles.statList} { bottom: 5.2rem; grid-template-columns: 1fr 1fr; }
      .${styles.stat} { min-height: 76px; padding: .7rem; }
      .${styles.stat} strong { font-size: clamp(2.4rem, 11vw, 3.5rem); }
      .${styles.stat} em { font-size: 9px; line-height: 1.1; margin-top: 6px; }
      .${styles.statHalo} { opacity: .34; bottom: 21vh; font-size: 12rem; }

      .${styles.places} h2 { max-width: 84%; }
      .${styles.placeNames} { z-index: 5; bottom: 10.2rem; max-width: 64%; gap: 4px; }
      .${styles.placeNames} span { font-size: clamp(.9rem, 5vw, 1.3rem); line-height: 1.05; overflow-wrap: anywhere; }
      .${styles.mapBlob} { z-index: 6; width: 43vw; right: -7vw; bottom: 1.1rem; gap: 4px; }
      .${styles.mapBlob} b { font-size: clamp(3rem, 15vw, 4.8rem); }
      .${styles.mapBlob} span { max-width: 52px; font-size: 8px; line-height: 1.05; }
      .${styles.placesMarks} { opacity: .5; }

      .${styles.quests} h2 { max-width: 86%; }
      .${styles.questWall} { top: auto; bottom: 4.4rem; height: 38vh; }
      .${styles.quest} { gap: 3px; }
      .${styles.quest}>div { border-width: 4px; box-shadow: 6px 6px 0 #16165e; }
      .${styles.quest} b { font-size: .72rem; line-height: 1; }
      .${styles.quest} span, .${styles.quest} em { font-size: 8px; }

      .${styles.leaderboard} h2 { max-width: 80%; }
      .${styles.ranks} { left: 1.1rem; right: 1.1rem; bottom: 5rem; width: auto; }
      .${styles.rank} { grid-template-columns: 30px minmax(0, 1fr) auto; gap: 5px; padding: 7px 0; }
      .${styles.rank} b { min-width: 0; font-size: clamp(1rem, 6vw, 1.55rem); overflow-wrap: anywhere; }
      .${styles.rank} strong { font-size: clamp(1.35rem, 8vw, 2rem); }
      .${styles.rankStamp} { top: 4.7rem; right: 1rem; }
      .${styles.confetti} { top: 4.8rem; right: 1rem; font-size: 1.6rem; opacity: .6; }
      .${styles.leaderboard}:after { bottom: 3rem; }

      .${styles.personShot} { z-index: 0; opacity: .48; top: 7.2rem; height: 47vh; right: -25vw; }
      .${styles.personCopy} { margin-top: 36vh; max-width: 88%; }
      .${styles.personalMoment} { max-width: 88%; margin-top: 1.1rem; font-size: .9rem; line-height: 1.2; overflow-wrap: anywhere; }
      .${styles.scoreSticker} { width: 108px; right: .9rem; bottom: 4.7rem; box-shadow: 4px 5px 0 #2b1032; }
      .${styles.scoreSticker} strong { font-size: 2.8rem; }
      .${styles.personType} h2 { max-width: 82%; }
      .${styles.hugeScore} { bottom: 19vh; font-size: 7.2rem; opacity: .88; }
      .${styles.personFact} { bottom: 5rem; max-width: 70%; font-size: .88rem; overflow-wrap: anywhere; }
      .${styles.typePhoto} { opacity: .45; right: -2%; top: 6.5rem; }
      .${styles.personCollage} h2 { max-width: 78%; }
      .${styles.collageOne} { opacity: .58; top: 8rem; }
      .${styles.personalCard} { left: 1.1rem; right: 1.1rem; bottom: 4.7rem; max-width: none; padding: 13px; transform: rotate(-2deg); }
      .${styles.personalCard} b { overflow-wrap: anywhere; }

      .${styles.photos} h2 { max-width: 90%; }
      .${styles.photoSpread} { inset: 43% 1.1rem 4.8rem; gap: 5px; }
      .${styles.spreadPhoto} { min-height: 84px; }
      .${styles.finaleCopy} { justify-content:flex-end; padding-bottom: .9rem; }
      .${styles.finaleCopy} > p:last-of-type { max-width: 80%; line-height: 1.25; overflow-wrap: anywhere; }
      .${styles.finaleCta} { margin-top: 1rem; }
      .${styles.controls} { bottom: 12px; right: 12px; }
      .${styles.controls} button { width: 40px; height: 40px; }
      .${styles.finaleActions} { right: 62px; bottom: 12px; }
    }
  `}</style>;
}

function PersonSlide({ person, layout }: { person: Person; layout: 0 | 1 | 2 }) {
  if (layout === 0) return <section className={`${styles.slide} ${styles.personPhoto}`}>
    <div className={styles.personBackdrop} /><div className={styles.personShot}><Photo photo={person.photo} priority /></div>
    <div className={styles.personCopy}><p className={styles.kicker}>PERSONAL BEST</p><h2>{person.name.toUpperCase()},<br />YOU GOT IT.</h2><p className={styles.personalMoment}>Signature moment<br /><b>{person.recap ?? person.moment}</b></p></div>
    <div className={styles.scoreSticker}><strong><CountUp value={person.score} /></strong><span>XP EARNED</span></div>
  </section>;
  if (layout === 1) return <section className={`${styles.slide} ${styles.personType}`}>
    <div className={styles.arc} /><p className={styles.kicker}>THE {person.rank === 1 ? "PACE-SETTER" : "PLOT TWIST"}</p>
    <h2>{person.name.toUpperCase()}<br /><span>WENT</span><br />OFF.</h2><div className={styles.hugeScore}><CountUp value={person.score} /><small>XP</small></div>
    <div className={styles.personFact}><b>{person.quests} quests done.</b><br />Most into {person.favorite.toLowerCase()}.</div>
    <div className={styles.typePhoto}><Photo photo={person.photo} /></div>
  </section>;
  return <section className={`${styles.slide} ${styles.personCollage}`}>
    <p className={styles.kicker}>THE EVIDENCE</p><h2>{person.name.toUpperCase()}<br />CHOSE<br /><i>CHAOS.</i></h2>
    <div className={styles.collageOne}><Photo photo={person.photo} /></div>
    <div className={styles.personalCard}><span>FAVOURITE ENERGY</span><b>{person.favorite}</b><em>{person.quests} quests · {person.score} XP</em></div>
  </section>;
}

function Slide({ slide, data, onReplay, onShare }: { slide: WrappedSlide; data: typeof demo; onReplay: () => void; onShare: () => void }) {
  const hero = data.photos[0] ?? data.people.find((person) => person.photo)?.photo ?? null;
  const photos = data.photos;
  if (slide.type === "intro") return <section className={`${styles.slide} ${styles.intro}`}>
    {hero && <div className={styles.introImage}><Photo photo={hero} priority /></div>}<div className={styles.introShade} />
    <div className={styles.brand}>JAPLAN <span>WRAPPED</span></div><div className={styles.introCopy}>{data === demo && <p className={styles.demoFlag}>DEMO STORY · FICTIONAL FIXTURE</p>}<h1>YOU ACTUALLY<br />MADE IT OUT<br /><i>OF THE GROUP CHAT.</i></h1><p className={styles.destination}>{data.trip.name}<br />{data.trip.destination} <span>·</span> {data.trip.dates}</p></div><div className={styles.scrollCue}>START THE STORY <span>↓</span></div>
  </section>;
  if (slide.type === "stats") return <section className={`${styles.slide} ${styles.stats}`}><div className={styles.dotGrid} /><div className={styles.statHalo}>{data.stats[2]?.value ?? "0"}</div><p className={styles.kicker}>THE RECEIPTS</p><h2>THIS WASN’T<br />A <i>CASUAL</i><br />WEEKEND.</h2><div className={styles.statList}>{data.stats.map((stat, i) => <div className={styles.stat} key={stat.label}><span>0{i + 1}</span><strong>{stat.value}</strong><em>{stat.label}</em></div>)}</div></section>;
  if (slide.type === "places") {
    const placeLabel = data.stats[1]?.label ?? "places saved";
    return <section className={`${styles.slide} ${styles.places}`}><div className={styles.placeTape}>WE WENT OUT · WE STAYED OUT · WE FOUND THINGS · </div><div className={styles.placesMarks}><span>✦</span><span>→</span><span>✦</span><i /></div><p className={styles.kicker}>EXPLORATION MODE</p><h2>THE CITY<br />DIDN’T KNOW<br />WHAT <i>HIT IT.</i></h2><div className={styles.placeNames}>{data.places.map((place, i) => <span key={place} style={{ "--i": i } as React.CSSProperties}>{place}</span>)}</div><div className={styles.mapBlob}><b>{data.stats[1]?.value ?? "0"}</b><span>{placeLabel.toUpperCase()}</span></div></section>;
  }
  if (slide.type === "quests") return <section className={`${styles.slide} ${styles.quests}`}><p className={styles.kicker}>{data.stats[2]?.value ?? "0"} QUESTS COMPLETED</p><h2>YOU SAID<br /><i>YES</i> TO THAT?</h2><div className={styles.questWall}>{data.quests.map((quest, i) => <article key={quest.title} className={styles.quest} style={{ "--q": i } as React.CSSProperties}><div><Photo photo={quest.photo} /></div><span>+{quest.points} XP</span><b>{quest.title}</b><em>claimed by {quest.winner}</em></article>)}</div></section>;
  if (slide.type === "leaderboard") return <section className={`${styles.slide} ${styles.leaderboard}`}><div className={styles.confetti}>✦ · ✦ · ✦ · ✦</div><div className={styles.rankStamp}>TOP<br />{data.people.length}</div><p className={styles.kicker}>FINAL STANDINGS</p><h2>LET’S TALK<br />ABOUT <i>THE SCORE.</i></h2><div className={styles.ranks}>{data.people.slice().reverse().map(person => <div key={person.name} className={styles.rank}><span>#{person.rank}</span><b>{person.name}</b><strong><CountUp value={person.score} /></strong></div>)}</div></section>;
  if (slide.type === "person") return <PersonSlide person={slide.person} layout={slide.layout} />;
  if (slide.type === "photos") return <section className={`${styles.slide} ${styles.photos}`}><p className={styles.kicker}>THE CAMERA ROLL</p><h2>{data.stats[3]?.value ?? "0"} LITTLE<br /><i>PROOFS</i> YOU<br />WERE THERE.</h2><div className={styles.photoSpread}>{data.photos.map((photo) => <div className={styles.spreadPhoto} key={photo.src}><Photo photo={photo} /></div>)}</div></section>;
  return <section className={`${styles.slide} ${styles.finale}`}><div className={styles.finalePic}><Photo photo={photos[1]} /></div><div className={styles.finaleOverlay} /><div className={styles.finaleCopy}><p className={styles.brand}>JAPLAN <span>WRAPPED</span></p><h2>SAME GROUP.<br /><i>NEXT TRIP?</i></h2><p>{data.trip.name}<br />{data.trip.destination} · {data.trip.dates}</p><div className={styles.finaleCta}><button type="button" onClick={onShare}>SHARE THIS TRIP ↗</button><button type="button" className={styles.replayText} onClick={onReplay}>Replay from the top</button></div></div></section>;
}

export function WrappedExperience({ data }: { data?: typeof demo }) {
  const story = data ?? demo;
  const [index, setIndex] = useState(0); const [direction, setDirection] = useState(1); const touch = useRef<number | null>(null);
  const slide = story.slides[index];
  const go = useCallback((next: number) => { if (next < 0 || next >= story.slides.length || next === index) return; setDirection(next > index ? 1 : -1); setIndex(next); }, [index, story.slides.length]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "ArrowRight" || event.key === " ") go(index + 1); if (event.key === "ArrowLeft") go(index - 1); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [go, index]);
  const share = async () => { const data = { title: "Japlan Wrapped", text: `${story.trip.name} · Japlan Wrapped`, url: window.location.href }; try { if (navigator.share) await navigator.share(data); else await navigator.clipboard.writeText(data.url); } catch { /* sharing is optional */ } };
  return <main className={styles.experience} onTouchStart={e => { touch.current = e.changedTouches[0].clientX; }} onTouchEnd={e => { if (touch.current === null) return; const distance = e.changedTouches[0].clientX - touch.current; if (Math.abs(distance) > 45) go(index + (distance < 0 ? 1 : -1)); touch.current = null; }}>
    <MobileLayoutGuards />
    <div className={styles.progress} aria-label={`Slide ${index + 1} of ${story.slides.length}`}>{story.slides.map((_, i) => <button key={i} onClick={() => go(i)} className={i <= index ? styles.complete : ""} aria-label={`Go to slide ${i + 1}`} />)}</div>
    <div key={index} className={`${styles.stage} ${direction > 0 ? styles.forward : styles.backward} ${ENTER}`}><Slide slide={slide} data={story} onReplay={() => { setDirection(-1); setIndex(0); }} onShare={share} /></div>
    <div className={styles.controls}><button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous slide">←</button><button type="button" onClick={() => go(index + 1)} disabled={index === story.slides.length - 1} aria-label="Next slide">→</button></div>
  </main>;
}
