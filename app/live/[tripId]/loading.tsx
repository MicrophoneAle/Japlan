import styles from "./live.module.css";

// Next's file convention: shown automatically while the async server
// component (page.tsx) is still loading the trip. Same card shapes as the
// real page so nothing jumps around once the data lands.
export default function LiveTripLoading() {
  return (
    <main className={styles.page} aria-busy="true" aria-label="Loading trip">
      <section className={styles.hero}>
        <div className={styles.heroTop}>
          <span className={styles.planeIcon} aria-hidden>✈️</span>
        </div>
        <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
        <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: "60%" }} />
        <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: "40%" }} />
      </section>

      <section className={styles.card}>
        <div className={`${styles.skeleton} ${styles.skeletonLabel}`} />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={styles.skeletonRow}>
            <div className={`${styles.skeleton} ${styles.skeletonAvatar}`} />
            <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ flex: 1 }} />
          </div>
        ))}
      </section>

      <section className={styles.card}>
        <div className={`${styles.skeleton} ${styles.skeletonLabel}`} />
        {[0, 1].map((i) => (
          <div key={i} className={`${styles.skeleton} ${styles.skeletonCard}`} />
        ))}
      </section>
    </main>
  );
}
