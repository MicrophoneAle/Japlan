export default function Home() {
  return (
    <main className="page" id="top">
      <nav className="nav" aria-label="Main navigation">
        <a className="brand" href="#top"><img className="brand-mark" src="/assets/image-removebg-preview (7).png" alt="" /> japlan</a>
      </nav>
      <section className="hero" aria-label="Japlan around the world">
        <div className="scene">
          <div className="scene-content">
            <div className="japlan-display">Japlan</div>
            <div className="globe-actions">
              <a href="https://github.com/MicrophoneAle/Japlan" target="_blank" rel="noreferrer">GitHub</a>
              <a href="sms:">Text #</a>
            </div>
          </div>
          <img className="landmarks-image" src="/assets/asdjdsa.png" alt="" />
        </div>
      </section>
      <footer><span>Â© 2026 JAPLAN</span><span>EVERYWHERE, TOGETHER.</span></footer>
    </main>
  );
}
