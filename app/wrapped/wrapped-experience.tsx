"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { demo, photos, type Person, type WrappedSlide } from "./data";
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

function Photo({ photo, className, priority = false }: { photo: { src: string; alt: string }; className?: string; priority?: boolean }) {
  return <Image className={className} src={photo.src} alt={photo.alt} fill sizes="(max-width: 700px) 100vw, 55vw" priority={priority} />;
}

function PersonSlide({ person, layout }: { person: Person; layout: 0 | 1 | 2 }) {
  if (layout === 0) return <section className={`${styles.slide} ${styles.personPhoto}`}>
    <div className={styles.personBackdrop} /><div className={styles.personShot}><Photo photo={person.photo} priority /></div>
    <div className={styles.personCopy}><p className={styles.kicker}>PERSONAL BEST</p><h2>{person.name.toUpperCase()},<br />YOU GOT IT.</h2><p className={styles.personalMoment}>Signature moment<br /><b>{person.moment}</b></p></div>
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
    <div className={styles.collageOne}><Photo photo={person.photo} /></div><div className={styles.collageTwo}><Photo photo={photos[(person.rank + 1) % photos.length]} /></div>
    <div className={styles.personalCard}><span>FAVOURITE ENERGY</span><b>{person.favorite}</b><em>{person.quests} quests · {person.score} XP</em></div>
  </section>;
}

function Slide({ slide, onReplay }: { slide: WrappedSlide; onReplay: () => void }) {
  if (slide.type === "intro") return <section className={`${styles.slide} ${styles.intro}`}>
    <div className={styles.introImage}><Photo photo={photos[0]} priority /></div><div className={styles.introShade} />
    <div className={styles.brand}>JAPLAN <span>WRAPPED</span></div><div className={styles.introCopy}><p className={styles.demoFlag}>DEMO STORY · FICTIONAL FIXTURE</p><h1>YOU ACTUALLY<br />MADE IT OUT<br /><i>OF THE GROUP CHAT.</i></h1><p className={styles.destination}>{demo.trip.destination} <span>·</span> {demo.trip.dates}</p></div><div className={styles.scrollCue}>START THE STORY <span>↓</span></div>
  </section>;
  if (slide.type === "stats") return <section className={`${styles.slide} ${styles.stats}`}><div className={styles.dotGrid} /><p className={styles.kicker}>THE RECEIPTS</p><h2>THIS WASN’T<br />A <i>CASUAL</i><br />WEEKEND.</h2><div className={styles.statList}>{demo.stats.map((stat, i) => <div className={styles.stat} key={stat.label}><span>0{i + 1}</span><strong>{stat.value}</strong><em>{stat.label}</em></div>)}</div></section>;
  if (slide.type === "places") return <section className={`${styles.slide} ${styles.places}`}><div className={styles.placeTape}>WE WENT OUT · WE STAYED OUT · WE FOUND THINGS · </div><p className={styles.kicker}>EXPLORATION MODE</p><h2>THE CITY<br />DIDN’T KNOW<br />WHAT <i>HIT IT.</i></h2><div className={styles.placeNames}>{demo.places.map((place, i) => <span key={place} style={{ "--i": i } as React.CSSProperties}>{place}</span>)}</div><div className={styles.mapBlob}><b>18</b><span>PLACES<br />PLANNED</span></div></section>;
  if (slide.type === "quests") return <section className={`${styles.slide} ${styles.quests}`}><p className={styles.kicker}>32 QUESTS COMPLETED</p><h2>YOU SAID<br /><i>YES</i> TO THAT?</h2><div className={styles.questWall}>{demo.quests.map((quest, i) => <article key={quest.title} className={styles.quest} style={{ "--q": i } as React.CSSProperties}><div><Photo photo={quest.photo} /></div><span>+{quest.points} XP</span><b>{quest.title}</b><em>claimed by {quest.winner}</em></article>)}</div></section>;
  if (slide.type === "leaderboard") return <section className={`${styles.slide} ${styles.leaderboard}`}><div className={styles.confetti}>✦ · ✦ · ✦ · ✦</div><p className={styles.kicker}>FINAL STANDINGS</p><h2>LET’S TALK<br />ABOUT <i>THE SCORE.</i></h2><div className={styles.ranks}>{demo.people.slice().reverse().map(person => <div key={person.name} className={styles.rank}><span>#{person.rank}</span><b>{person.name}</b><strong><CountUp value={person.score} /></strong></div>)}</div><p className={styles.ties}>Zara + Noah: tied, inseparable, objectively iconic.</p></section>;
  if (slide.type === "person") return <PersonSlide person={slide.person} layout={slide.layout} />;
  if (slide.type === "photos") return <section className={`${styles.slide} ${styles.photos}`}><p className={styles.kicker}>THE CAMERA ROLL</p><h2>47 LITTLE<br /><i>PROOFS</i> YOU<br />WERE THERE.</h2><div className={styles.photoSpread}>{[...photos, ...photos, ...photos].map((photo, i) => <div className={styles.spreadPhoto} key={`${photo.src}-${i}`}><Photo photo={photo} /></div>)}</div></section>;
  return <section className={`${styles.slide} ${styles.finale}`}><div className={styles.finalePic}><Photo photo={photos[1]} /></div><div className={styles.finaleOverlay} /><div className={styles.finaleCopy}><p className={styles.brand}>JAPLAN <span>WRAPPED</span></p><h2>SAME GROUP.<br /><i>NEXT TRIP?</i></h2><p>{demo.trip.destination} · {demo.trip.dates}</p><button type="button" className={styles.replayText} onClick={onReplay}>REPLAY IT FROM THE TOP ↗</button></div></section>;
}

export function WrappedExperience() {
  const [index, setIndex] = useState(0); const [direction, setDirection] = useState(1); const touch = useRef<number | null>(null);
  const slide = demo.slides[index];
  const go = useCallback((next: number) => { if (next < 0 || next >= demo.slides.length || next === index) return; setDirection(next > index ? 1 : -1); setIndex(next); }, [index]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "ArrowRight" || event.key === " ") go(index + 1); if (event.key === "ArrowLeft") go(index - 1); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [go, index]);
  const share = async () => { const data = { title: "Japlan Wrapped · Demo", text: "A fictional Japlan Wrapped demo.", url: window.location.href }; try { if (navigator.share) await navigator.share(data); else await navigator.clipboard.writeText(data.url); } catch { /* sharing is optional */ } };
  return <main className={styles.experience} onTouchStart={e => { touch.current = e.changedTouches[0].clientX; }} onTouchEnd={e => { if (touch.current === null) return; const distance = e.changedTouches[0].clientX - touch.current; if (Math.abs(distance) > 45) go(index + (distance < 0 ? 1 : -1)); touch.current = null; }}>
    <div className={styles.progress} aria-label={`Slide ${index + 1} of ${demo.slides.length}`}>{demo.slides.map((_, i) => <button key={i} onClick={() => go(i)} className={i <= index ? styles.complete : ""} aria-label={`Go to slide ${i + 1}`} />)}</div>
    <div key={index} className={`${styles.stage} ${direction > 0 ? styles.forward : styles.backward} ${ENTER}`}><Slide slide={slide} onReplay={() => { setDirection(-1); setIndex(0); }} /></div>
    <div className={styles.controls}><button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous slide">←</button><button type="button" onClick={() => go(index + 1)} disabled={index === demo.slides.length - 1} aria-label="Next slide">→</button></div>
    {index === demo.slides.length - 1 && <div className={styles.finaleActions}><button type="button" onClick={() => { setDirection(-1); setIndex(0); }}>Replay</button><button type="button" onClick={share}>Share wrapped ↗</button></div>}
  </main>;
}
