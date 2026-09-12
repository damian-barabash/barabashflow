// Hero 3D logo — Three.js + meshopt GLB (71 KB: 35 % of the original
// triangles, 512 px WebP textures, EXT_meshopt_compression), lazy-loaded
// after first paint. The meshopt decoder (~30 KB) ships inside three.js —
// no third-party decoder download like Draco needed.
// Ported from the old graph engine: gated render loop (parks off-screen /
// hidden tab), settle-in animation, drag to spin, plus mouse parallax on the
// whole page so the logo "looks at" the cursor. Falls back to the flat
// PNG mark when WebGL is missing or the model fails to load.
export async function mountLogo3D(hostSel = '#hero-logo') {
  const host = document.querySelector<HTMLElement>(hostSel);
  if (!host) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && host.dataset.forceMotion !== '1') {
    // Still show the model, just without auto-spin.
  }

  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') || probe.getContext('webgl');
  if (!gl) { host.classList.add('is-fallback'); return; }

  const [THREE, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three'),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ]);

  let renderer: any;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    host.classList.add('is-fallback');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = 'hero-logo-canvas';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  camera.position.set(0, 0.05, 5.4);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const key = new THREE.DirectionalLight(0xfff6e6, 2.3); key.position.set(2.8, 3.4, 4.2); scene.add(key);
  const rim = new THREE.DirectionalLight(0xe6ffb0, 0.9); rim.position.set(-3.2, -1.4, -2.6); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.5));
  const group = new THREE.Group();
  scene.add(group);

  const render = () => renderer.render(scene, camera);
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  resize();
  new ResizeObserver(resize).observe(host);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  let targetRotX = 0, targetRotY = 0;
  let mouseX = 0, mouseY = 0;
  let drag: { x: number; y: number } | null = null;
  let visible = true, running = false, raf = 0;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame(time: number) {
    if (!drag) targetRotY += reduced ? 0 : 0.003;
    // Mouse parallax: the logo leans towards the cursor (±0.35 rad).
    const aimY = targetRotY + mouseX * 0.35;
    const aimX = targetRotX + mouseY * 0.25;
    group.rotation.y += (aimY - group.rotation.y) * 0.07;
    group.rotation.x += (aimX - group.rotation.x) * 0.07;
    group.position.y = reduced ? 0 : Math.sin(time * 0.0011) * 0.05;
    render();
    if (running && visible && !document.hidden) raf = requestAnimationFrame(frame);
    else { running = false; raf = 0; }
  }
  const startLoop = () => { running = true; if (!raf) raf = requestAnimationFrame(frame); };
  const wake = () => { if (visible && !document.hidden) startLoop(); };

  loader.load(
    `${import.meta.env.BASE_URL}assets/3d/LOGO_3D_BF.glb`,
    (gltf: any) => {
      const model = gltf.scene;
      let meshCount = 0;
      model.traverse((obj: any) => {
        if (!obj.isMesh) return;
        meshCount++;
        if (!obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
        if (!obj.material) obj.material = new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.55, roughness: 0.3 });
      });
      if (!meshCount) { host.classList.add('is-fallback'); return; }
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const targetScale = 2.5 / maxDim;
      model.scale.setScalar(targetScale);
      model.position.copy(box.getCenter(new THREE.Vector3()).multiplyScalar(-targetScale));
      group.add(model);
      host.classList.add('is-ready');

      const fromScale = targetScale * 0.7, fromRotY = -1.1;
      model.scale.setScalar(fromScale);
      group.rotation.y = fromRotY;
      const start = performance.now(), dur = 1100;
      const easeOut = (x: number) => 1 - Math.pow(1 - x, 4);
      const settle = () => {
        const k = Math.min(1, (performance.now() - start) / dur);
        const e = easeOut(k);
        model.scale.setScalar(fromScale + (targetScale - fromScale) * e);
        group.rotation.y = fromRotY + (0 - fromRotY) * e;
        render();
        if (k < 1) requestAnimationFrame(settle); else startLoop();
      };
      requestAnimationFrame(settle);
    },
    undefined,
    (err: any) => {
      console.warn('[bf] 3D load failed', err);
      host.classList.add('is-fallback');
    },
  );

  // Drag to spin.
  host.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; host.setPointerCapture?.(e.pointerId); host.classList.add('is-grabbing'); wake(); });
  host.addEventListener('pointermove', (e) => {
    if (!drag) return;
    targetRotY += (e.clientX - drag.x) / 110;
    targetRotX += (e.clientY - drag.y) / 110;
    drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = (e: PointerEvent) => { if (drag) host.releasePointerCapture?.(e.pointerId); drag = null; host.classList.remove('is-grabbing'); };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);

  // Cursor parallax (desktop only).
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    window.addEventListener('pointermove', (e) => {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
      mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
      wake();
    }, { passive: true });
  }

  new IntersectionObserver((entries) => {
    visible = entries[0]?.isIntersecting ?? true;
    if (visible) wake();
  }).observe(host);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
}
