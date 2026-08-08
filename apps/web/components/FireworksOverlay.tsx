"use client";

import { useEffect, useRef } from "react";

type FireworksOverlayProps = {
  open: boolean;
  score: number;
  maxScore: number;
  onDismiss: () => void;
  /** Auto-dismiss delay in ms (default 4500). */
  durationMs?: number;
};

const PALETTE = [
  "#0d9488", // teal
  "#14b8a6", // teal-light
  "#065f5b", // jade
  "#2dd4bf",
  "#5eead4",
  "#fbbf24", // warm spark accent
  "#fcd34d",
];

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  gravity: number;
};

type Rocket = {
  x: number;
  y: number;
  vy: number;
  targetY: number;
  color: string;
  exploded: boolean;
};

function spawnBurst(particles: Particle[], x: number, y: number, color: string) {
  const count = 28 + Math.floor(Math.random() * 18);
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.35;
    const speed = 1.6 + Math.random() * 3.8;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      maxLife: 0.55 + Math.random() * 0.55,
      color: Math.random() > 0.35 ? color : PALETTE[Math.floor(Math.random() * PALETTE.length)],
      size: 1.5 + Math.random() * 2.2,
      gravity: 0.028 + Math.random() * 0.02,
    });
  }
}

export default function FireworksOverlay({
  open,
  score,
  maxScore,
  onDismiss,
  durationMs = 4500,
}: FireworksOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const timer = window.setTimeout(() => onDismissRef.current(), durationMs);
    if (reduceMotion) {
      return () => window.clearTimeout(timer);
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return () => window.clearTimeout(timer);
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return () => window.clearTimeout(timer);
    }

    let raf = 0;
    let running = true;
    const particles: Particle[] = [];
    const rockets: Rocket[] = [];
    let lastBurst = 0;
    let elapsed = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function launchRocket() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      rockets.push({
        x: w * (0.12 + Math.random() * 0.76),
        y: h + 8,
        vy: -(6.2 + Math.random() * 3.4),
        targetY: h * (0.18 + Math.random() * 0.38),
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        exploded: false,
      });
    }

    resize();
    window.addEventListener("resize", resize);

    // Opening bursts so celebration feels immediate
    for (let i = 0; i < 3; i++) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      spawnBurst(
        particles,
        w * (0.25 + Math.random() * 0.5),
        h * (0.25 + Math.random() * 0.3),
        PALETTE[i % PALETTE.length],
      );
    }
    launchRocket();
    launchRocket();

    const tick = (ts: number) => {
      if (!running) return;
      if (!lastBurst) lastBurst = ts;
      const dt = Math.min(32, ts - (elapsed || ts));
      elapsed = ts;

      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx!.clearRect(0, 0, w, h);

      if (ts - lastBurst > 380 + Math.random() * 220) {
        lastBurst = ts;
        launchRocket();
        if (Math.random() > 0.45) launchRocket();
      }

      for (const r of rockets) {
        if (r.exploded) continue;
        r.y += r.vy;
        r.vy += 0.045;
        ctx!.beginPath();
        ctx!.fillStyle = r.color;
        ctx!.globalAlpha = 0.9;
        ctx!.arc(r.x, r.y, 2.2, 0, Math.PI * 2);
        ctx!.fill();
        // trail
        ctx!.beginPath();
        ctx!.strokeStyle = r.color;
        ctx!.globalAlpha = 0.35;
        ctx!.lineWidth = 1.5;
        ctx!.moveTo(r.x, r.y);
        ctx!.lineTo(r.x, r.y - r.vy * 2.5);
        ctx!.stroke();

        if (r.y <= r.targetY || r.vy >= -0.4) {
          r.exploded = true;
          spawnBurst(particles, r.x, r.y, r.color);
        }
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= 0.985;
        p.life -= dt / 1000 / p.maxLife;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        ctx!.beginPath();
        ctx!.globalAlpha = Math.max(0, p.life);
        ctx!.fillStyle = p.color;
        ctx!.arc(p.x, p.y, p.size * (0.55 + p.life * 0.55), 0, Math.PI * 2);
        ctx!.fill();
      }

      ctx!.globalAlpha = 1;
      // prune finished rockets occasionally
      if (rockets.length > 24) {
        for (let i = rockets.length - 1; i >= 0; i--) {
          if (rockets[i].exploded) rockets.splice(i, 1);
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      window.clearTimeout(timer);
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, [open, durationMs]);

  if (!open) return null;

  return (
    <div
      className="fireworks-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Điểm tuyệt đối"
      onClick={onDismiss}
    >
      <canvas ref={canvasRef} className="fireworks-canvas" aria-hidden="true" />
      <div className="fireworks-message" onClick={(e) => e.stopPropagation()}>
        <p className="fireworks-eyebrow">Xuất sắc</p>
        <h2 className="fireworks-title">Điểm tuyệt đối!</h2>
        <p className="fireworks-score">
          {score} / {maxScore}
        </p>
        <p className="fireworks-hint">Chạm bất kỳ đâu để đóng</p>
      </div>
    </div>
  );
}
