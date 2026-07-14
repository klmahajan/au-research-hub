// ============================================================
// Research Compass — landing page interactions
// Cursor-reactive hero glow, scroll-triggered reveals, and the
// per-card particle motif (same particle layout, recolored on
// hover — rest/hover are two pre-drawn canvases crossfaded via CSS).
// Everything here respects prefers-reduced-motion and pointer type.
// ============================================================

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasFinePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

// ── Scroll reveal ──
(function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || reducedMotion) {
    els.forEach(el => el.classList.add('is-visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  els.forEach(el => io.observe(el));
})();

// ── Hero cursor glow (fine pointers only, no reduced motion) ──
(function initHeroGlow() {
  const hero = document.querySelector('.hero');
  const glow = document.getElementById('hero-glow');
  if (!hero || !glow || reducedMotion || !hasFinePointer) return;

  let targetX = 0, targetY = 0, curX = 0, curY = 0, active = false;

  hero.addEventListener('pointermove', (e) => {
    targetX = e.clientX;
    targetY = e.clientY;
    if (!active) {
      active = true;
      curX = targetX; curY = targetY;
      glow.classList.add('is-active');
      requestAnimationFrame(tick);
    }
  });
  hero.addEventListener('pointerleave', () => {
    active = false;
    glow.classList.remove('is-active');
  });

  function tick() {
    curX += (targetX - curX) * 0.08;
    curY += (targetY - curY) * 0.08;
    glow.style.left = curX + 'px';
    glow.style.top = curY + 'px';
    if (active || Math.abs(targetX - curX) > 0.5 || Math.abs(targetY - curY) > 0.5) {
      requestAnimationFrame(tick);
    }
  }
})();

// ── Card particle motif ──
// Same seeded particle layout drawn twice per card (rest colorway,
// hover colorway); CSS crossfades opacity on :hover/:focus-visible.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeParticles(seed, count = 130) {
  const rand = mulberry32(seed);
  const focusX = 0.58 + rand() * 0.2;
  const focusY = 0.32 + rand() * 0.28;
  const particles = [];
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = Math.pow(rand(), 0.55) * 0.66;
    const stretch = 0.85 + rand() * 0.35;
    particles.push({
      x: focusX + Math.cos(angle) * dist * stretch,
      y: focusY + Math.sin(angle) * dist * stretch,
      r: 0.6 + rand() * 2.1,
      o: 0.12 + rand() * 0.5,
    });
  }
  return particles;
}

function drawParticles(canvas, particles, rgb) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const scale = rect.width / 220;
  particles.forEach(p => {
    ctx.beginPath();
    ctx.fillStyle = `rgba(${rgb},${p.o})`;
    ctx.arc(p.x * rect.width, p.y * rect.height, Math.max(0.5, p.r * scale), 0, Math.PI * 2);
    ctx.fill();
  });
}

(function initCardParticles() {
  const cards = document.querySelectorAll('.card[data-seed]');
  if (!cards.length) return;

  const REST_RGB = '0,60,120';
  const HOVER_RGB = '210,228,255';

  const jobs = [];
  cards.forEach(card => {
    const seed = parseInt(card.dataset.seed, 10) || 1;
    const particles = makeParticles(seed);
    const restCanvas = card.querySelector('.card-particles--rest');
    const hoverCanvas = card.querySelector('.card-particles--hover');
    jobs.push(() => {
      drawParticles(restCanvas, particles, REST_RGB);
      drawParticles(hoverCanvas, particles, HOVER_RGB);
    });
  });

  const redrawAll = () => jobs.forEach(job => job());
  redrawAll();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawAll, 150);
  });
})();
