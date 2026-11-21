/**
 * A 3D CSS die with a hand-rolled animation:
 *  - tumble(): the die is "in the air" and spins on all three axes while the oracle works
 *  - land(n): it drops, bounces with decreasing height, and settles exactly on face n with a small wobble
 *  - show(n): no animation (page load, reduced motion)
 * The result is never guessed: the die only lands once the on-chain result is known.
 */

/** Pip cells (1..9 on a 3x3 grid) for each face value. */
const PIPS: Record<number, number[]> = {
  1: [5],
  2: [3, 7],
  3: [3, 5, 7],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
}

/** Where each face sits on the cube, and the cube rotation (x, y) that turns it to the viewer. */
const FACES: { value: number; place: string; show: [number, number] }[] = [
  { value: 1, place: 'rotateY(0deg)', show: [0, 0] },
  { value: 6, place: 'rotateY(180deg)', show: [0, 180] },
  { value: 2, place: 'rotateY(90deg)', show: [0, -90] },
  { value: 5, place: 'rotateY(-90deg)', show: [0, 90] },
  { value: 3, place: 'rotateX(90deg)', show: [-90, 0] },
  { value: 4, place: 'rotateX(-90deg)', show: [90, 0] },
]

const HOVER = -46 // px above the table while tumbling
const CAMERA = 'rotateX(-18deg)' // we look down at the table a little, so a resting die shows its top edge
const LAND_MS = 2100

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const mod = (a: number, n: number) => ((a % n) + n) % n
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

/** Height of a ball dropped at t=0, bouncing 3 times with ~45% energy kept: 0 = table, 1 = start height. */
function dropHeight(t: number): number {
  // segment end times (fractions of the drop phase) and peak heights of each bounce
  const ends = [0.42, 0.68, 0.84, 0.94, 1]
  const peaks = [1, 0.3, 0.11, 0.035]
  if (t < ends[0]!) return 1 - (t / ends[0]!) ** 2 // free fall
  for (let i = 1; i < ends.length; i++) {
    if (t < ends[i]!) {
      const a = ends[i - 1]!, b = ends[i]!
      const u = (t - a) / (b - a) // 0..1 over the bounce
      return peaks[i]! * 4 * u * (1 - u) // parabola
    }
  }
  return 0
}

export class Die3D {
  private cube: HTMLDivElement
  private shadow: HTMLDivElement
  private rx = -24
  private ry = 34
  private rz = 0
  private y = 0
  private v = { x: 0, y: 0, z: 0 }
  private raf = 0
  private last = 0

  constructor(private root: HTMLElement) {
    root.classList.add('die-scene')
    root.innerHTML = ''
    this.cube = document.createElement('div')
    this.cube.className = 'cube'
    for (const f of FACES) {
      const face = document.createElement('div')
      face.className = `face f${f.value}`
      face.style.transform = `${f.place} translateZ(var(--half))`
      for (let cell = 1; cell <= 9; cell++) {
        const pip = document.createElement('span')
        if (PIPS[f.value]!.includes(cell)) pip.className = 'pip'
        face.append(pip)
      }
      this.cube.append(face)
    }
    // solid inner planes so the rounded corners never show a see-through gap
    for (const t of ['rotateY(0deg)', 'rotateY(90deg)', 'rotateX(90deg)']) {
      const core = document.createElement('div')
      core.className = 'core'
      core.style.transform = t
      this.cube.append(core)
    }
    this.shadow = document.createElement('div')
    this.shadow.className = 'die-shadow'
    root.append(this.shadow, this.cube)
    this.idle()
  }

  /** Resting at an angle, value unknown (never rolled). */
  idle() {
    this.stop()
    this.root.dataset.state = 'idle'
    this.rx = -24; this.ry = 34; this.rz = 0; this.y = 0
    this.render()
  }

  /** Spin in the air until land() is called. */
  tumble() {
    if (this.root.dataset.state === 'tumbling') return
    this.stop()
    this.root.dataset.state = 'tumbling'
    if (reducedMotion()) { this.y = HOVER; this.render(); return }
    this.v = { x: rand(320, 520) * (Math.random() < 0.5 ? -1 : 1), y: rand(380, 620), z: rand(-200, 200) }
    const start = performance.now()
    this.last = start
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      // drift the spin so it never looks like a loop
      this.v.x += rand(-60, 60) * dt * 10
      this.v.y += rand(-60, 60) * dt * 10
      this.v.z += rand(-40, 40) * dt * 10
      this.v.x = Math.max(-620, Math.min(620, this.v.x))
      this.v.y = Math.max(260, Math.min(700, this.v.y))
      this.v.z = Math.max(-260, Math.min(260, this.v.z))
      this.rx += this.v.x * dt
      this.ry += this.v.y * dt
      this.rz += this.v.z * dt
      // rise into the air on the first throw, then bob a little
      const rise = Math.min(1, (now - start) / 380)
      this.y = HOVER * easeOutCubic(rise) + Math.sin((now - start) / 210) * 5 * rise
      this.render()
      this.raf = requestAnimationFrame(frame)
    }
    this.raf = requestAnimationFrame(frame)
  }

  /** Drop, bounce and settle on `value`. Resolves when the die is at rest. */
  land(value: number): Promise<void> {
    const face = FACES.find((f) => f.value === value)
    if (!face) { this.idle(); return Promise.resolve() }
    this.stop()
    if (reducedMotion() || this.root.dataset.state !== 'tumbling') { this.show(value); return Promise.resolve() }
    this.root.dataset.state = 'landing'

    const from = { x: this.rx, y: this.ry, z: this.rz, h: this.y }
    // keep spinning the way it was going: at least 1.5 more turns on x/y, then stop on the face
    const dirX = Math.sign(this.v.x) || 1
    const target = (cur: number, want: number, dir: number, extra: number) => {
      const base = cur + dir * extra
      const off = mod(dir * (want - base), 360)
      return base + dir * off
    }
    const to = {
      x: target(from.x, face.show[0], dirX, 540),
      y: target(from.y, face.show[1], 1, 540),
      // a real die rarely lands square to the viewer
      z: target(from.z, rand(-14, 14), Math.sign(this.v.z) || 1, 180),
    }

    return new Promise((resolve) => {
      const start = performance.now()
      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / LAND_MS)
        // rotation slows like friction: fast while bouncing, then settles
        const r = easeOutCubic(Math.min(1, t / 0.9))
        // small rocking wobble once it is down
        const wobble = t > 0.82 ? Math.exp(-(t - 0.82) * 22) * Math.sin((t - 0.82) * 70) * 5 : 0
        this.rx = from.x + (to.x - from.x) * r + wobble
        this.ry = from.y + (to.y - from.y) * r
        this.rz = from.z + (to.z - from.z) * r + wobble * 0.6
        this.y = from.h * dropHeight(Math.min(1, t / 0.85))
        this.render()
        if (t < 1) this.raf = requestAnimationFrame(frame)
        else {
          this.raf = 0
          this.root.dataset.state = 'landed'
          this.root.classList.remove('thud')
          void this.root.offsetWidth
          this.root.classList.add('thud')
          resolve()
        }
      }
      this.raf = requestAnimationFrame(frame)
    })
  }

  /** Jump straight to `value` at rest. */
  show(value: number) {
    const face = FACES.find((f) => f.value === value)
    if (!face) return this.idle()
    this.stop()
    this.root.dataset.state = 'landed'
    this.rx = face.show[0]; this.ry = face.show[1]; this.rz = rand(-8, 8); this.y = 0
    this.render()
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private render() {
    this.cube.style.transform =
      `translateY(${this.y}px) ${CAMERA} rotateZ(${this.rz}deg) rotateX(${this.rx}deg) rotateY(${this.ry}deg)`
    // the shadow shrinks and fades as the die rises
    const lift = Math.min(1, Math.abs(this.y) / Math.abs(HOVER))
    this.shadow.style.transform = `scale(${1 - lift * 0.45})`
    this.shadow.style.opacity = String(0.55 - lift * 0.35)
  }
}
