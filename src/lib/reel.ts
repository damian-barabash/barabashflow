// Project reel (ProjectReel.astro).
// Desktop (≥901px): the section is pinned; page scroll drives a float index
// `pos` that bends the covers around a drum (CSS 3D, no WebGL), slides the
// giant title band and swaps the info panel. Gentle snap to the nearest work
// when the scroll comes to rest.
// Phones: native horizontal scroll-snap track (no scroll hijacking); its
// scrollLeft drives the same `pos`, cards curve with rotateY.
// Perf: transforms/opacity only, rAF runs only while the reel is on screen
// and moving, layout is measured on resize — never inside the frame loop.
// Covers load lazily (current ±2), so the page pays for ~3 images, not 20.

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const pad = (n: number) => String(n).padStart(2, '0');

export function setupProjectReel() {
  document.querySelectorAll<HTMLElement>('[data-preel]').forEach(mount);
}

function mount(root: HTMLElement) {
  const stage = root.querySelector<HTMLElement>('.preel-stage')!;
  const drum = root.querySelector<HTMLElement>('[data-preel-drum]')!;
  const track = root.querySelector<HTMLElement>('[data-preel-track]')!;
  const cards = Array.from(root.querySelectorAll<HTMLAnchorElement>('.preel-card'));
  const inners = cards.map((c) => c.querySelector<HTMLElement>('.pc-in')!);
  const imgs = cards.map((c) => c.querySelector<HTMLImageElement>('img')!);
  const items = Array.from(root.querySelectorAll<HTMLElement>('.preel-list li'));
  const infos = Array.from(root.querySelectorAll<HTMLElement>('.pi'));
  const band = root.querySelector<HTMLElement>('.preel-band')!;
  const bandRow = root.querySelector<HTMLElement>('.preel-band-row')!;
  const words = Array.from(root.querySelectorAll<HTMLElement>('.preel-band-w'));
  const idxEl = root.querySelector<HTMLElement>('[data-preel-idx]');
  const progEl = root.querySelector<HTMLElement>('[data-preel-prog]');
  const N = cards.length;
  if (!N) return;

  const mq = matchMedia('(min-width: 901px)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  let desk = mq.matches;
  let pos = 0, target = 0, active = -1, raf = 0, last = 0, inView = false;
  let top0 = 0, stepPx = 1, cardStep = 1, cardH = 300, bandW = 0;
  let centers: number[] = [];
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  let snapT = 0;

  function measure() {
    const hdr = (document.querySelector('.site-header') as HTMLElement | null)?.offsetHeight || 0;
    root.style.setProperty('--hdr', `${hdr}px`);
    if (desk) {
      const extra = root.offsetHeight - stage.offsetHeight;
      stepPx = N > 1 ? Math.max(1, extra / (N - 1)) : 1;
      top0 = root.getBoundingClientRect().top + window.scrollY - hdr;
      cardH = cards[0].offsetHeight;
    } else {
      cardStep = N > 1 ? Math.max(1, cards[1].offsetLeft - cards[0].offsetLeft) : 1;
    }
    bandW = band.clientWidth;
    centers = words.map((w) => w.offsetLeft + w.offsetWidth / 2);
  }

  function readTarget() {
    return desk
      ? clamp((window.scrollY - top0) / stepPx, 0, N - 1)
      : clamp(track.scrollLeft / cardStep, 0, N - 1);
  }

  function setActive(i: number) {
    if (i === active) return;
    active = i;
    cards.forEach((c, n) => { c.classList.toggle('is-active', n === i); c.tabIndex = n === i ? 0 : -1; });
    items.forEach((li, n) => li.classList.toggle('is-active', n === i));
    infos.forEach((el, n) => el.classList.toggle('is-active', n === i));
    words.forEach((w, n) => w.classList.toggle('is-active', n === i));
    if (idxEl) idxEl.textContent = pad(i + 1);
  }

  function render() {
    const rm = reduced();
    for (let i = 0; i < N; i++) {
      const d = i - pos, ad = Math.abs(d);
      const card = cards[i];
      if (ad < 2.6 && !imgs[i].src) imgs[i].src = imgs[i].dataset.src || '';
      if (desk) {
        if (ad > 2.6) { card.style.visibility = 'hidden'; continue; }
        card.style.visibility = '';
        const a = rm ? 0 : d * 0.42;                  // radians around the drum
        const R = cardH * 2.75;                       // neighbours sit ~1.1 card below/above
        const y = rm ? d * cardH * 1.12 : Math.sin(a) * R;
        const z = rm ? 0 : (Math.cos(a) - 1) * R;
        const isA = ad < 0.5;
        const tx = isA ? tilt.x * (1 - ad * 2) : 0, ty = isA ? tilt.y * (1 - ad * 2) : 0;
        card.style.transform = `translate3d(-50%, calc(-50% + ${y.toFixed(1)}px), ${z.toFixed(1)}px) rotateX(${(-a * 57.2958 - ty * 5).toFixed(2)}deg) rotateY(${(tx * 7).toFixed(2)}deg)`;
        card.style.opacity = String(clamp(1.3 - ad * 0.5, 0, 1).toFixed(3));
        card.style.zIndex = String(100 - Math.round(ad * 10));
      } else {
        const rot = rm ? 0 : clamp(-d * 32, -64, 64);
        const sc = 1 - Math.min(ad, 1.4) * 0.14;
        inners[i].style.transform = `perspective(1100px) rotateY(${rot.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
        inners[i].style.opacity = String(clamp(1 - ad * 0.35, 0.35, 1).toFixed(3));
      }
    }
    // Title band: the current work's word sits in the centre.
    if (centers.length) {
      const f = Math.floor(pos), c = Math.min(N - 1, f + 1), t = pos - f;
      const cx = centers[f] + (centers[c] - centers[f]) * t;
      bandRow.style.transform = `translate3d(${(bandW / 2 - cx).toFixed(1)}px,0,0)`;
    }
    if (progEl) progEl.style.transform = `scale${desk ? 'Y' : 'X'}(${N > 1 ? (pos / (N - 1)).toFixed(4) : 1})`;
    root.classList.toggle('is-moved', pos > 0.25);
    setActive(clamp(Math.round(pos), 0, N - 1));
  }

  function loop(t: number) {
    const dt = last ? Math.min(64, t - last) : 16.7;
    last = t;
    target = readTarget();
    const k = desk && !reduced() ? 1 - Math.pow(1 - 0.16, dt / 16.7) : 1;
    pos += (target - pos) * k;
    if (Math.abs(target - pos) < 0.0006) pos = target;
    tilt.x += (tilt.tx - tilt.x) * 0.12; tilt.y += (tilt.ty - tilt.y) * 0.12;
    const tiltMoving = Math.abs(tilt.tx - tilt.x) > 0.002 || Math.abs(tilt.ty - tilt.y) > 0.002;
    render();
    if (pos !== target || tiltMoving) raf = requestAnimationFrame(loop);
    else { raf = 0; last = 0; }
  }
  const kick = () => { if (!raf && inView) raf = requestAnimationFrame(loop); };

  function go(i: number) {
    i = clamp(i, 0, N - 1);
    if (desk) window.scrollTo({ top: top0 + i * stepPx + 1, behavior: reduced() ? 'auto' : 'smooth' });
    else track.scrollTo({ left: i * cardStep, behavior: reduced() ? 'auto' : 'smooth' });
  }

  // Desktop: settle on the nearest work once the scroll rests inside the reel.
  function scheduleSnap() {
    clearTimeout(snapT);
    if (!desk || reduced()) return;
    snapT = window.setTimeout(() => {
      const tg = (window.scrollY - top0) / stepPx;
      if (tg <= 0.02 || tg >= N - 1.02) return;
      const i = Math.round(tg);
      if (Math.abs(tg - i) > 0.015) go(i);
    }, 200);
  }

  // Clicks: other work → bring it to the centre; the active one → its page.
  const onPick = (e: MouseEvent, i: number) => {
    if (i === active) return;
    e.preventDefault();
    go(i);
  };
  cards.forEach((c, i) => c.addEventListener('click', (e) => onPick(e, i)));
  items.forEach((li, i) => li.querySelector('a')?.addEventListener('click', (e) => onPick(e, i)));
  root.addEventListener('keydown', (e) => {
    if (!inView || !(e.target as HTMLElement).closest('.preel-drum')) return;
    const dir = desk ? (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0) : (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
    if (!dir) return;
    e.preventDefault();
    go(active + dir);
    requestAnimationFrame(() => cards[clamp(active + dir, 0, N - 1)]?.focus({ preventScroll: true }));
  });

  // Cursor tilt of the active cover (desktop, fine pointer).
  drum.addEventListener('pointermove', (e) => {
    if (!desk || !fine.matches || reduced()) return;
    const r = stage.getBoundingClientRect();
    tilt.tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
    tilt.ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
    kick();
  });
  drum.addEventListener('pointerleave', () => { tilt.tx = 0; tilt.ty = 0; kick(); });

  window.addEventListener('scroll', () => { if (desk) { kick(); scheduleSnap(); } }, { passive: true });
  track.addEventListener('scroll', () => { if (!desk) kick(); }, { passive: true });

  const io = new IntersectionObserver(([en]) => { inView = en.isIntersecting; if (inView) kick(); }, { rootMargin: '400px 0px' });
  io.observe(root);

  const relayout = () => {
    const was = desk;
    desk = mq.matches;
    if (was !== desk) {
      cards.forEach((c, i) => { c.style.cssText = ''; inners[i].style.cssText = ''; });
      root.classList.toggle('is-desk', desk);
    }
    measure();
    target = readTarget();
    pos = target;
    render();
  };
  root.classList.toggle('is-desk', desk);
  root.classList.add('is-ready');
  // Body height changes (images/fonts above the reel) shift the pin offset.
  let roT = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(roT); roT = requestAnimationFrame(relayout); });
  ro.observe(root); ro.observe(document.body);
  mq.addEventListener('change', relayout);
  document.fonts?.ready.then(() => { measure(); render(); });
  relayout();
}
