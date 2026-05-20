"use client"

import React, { useEffect, useRef } from "react"
import lottie from "lottie-web"

/*
 * ─── Lottie Ink-Drop Animation ───
 * Programmatic Lottie animation simulating an ink drop
 * falling into water and dispersing with organic motion.
 */

const inkDropLottieAnimation = {
  v: "5.9.6",
  fr: 60,
  ip: 0,
  op: 180,
  w: 500,
  h: 500,
  nm: "InkDropInWater",
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: "Ink Drop Main",
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 1, k: [{ i: { x: [0.667], y: [1] }, o: { x: [0.333], y: [0] }, t: 0, s: [250, -50, 0], e: [250, 450, 0] }, { t: 45, s: [250, 200, 0] }] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: "gr",
          it: [
            {
              ty: "rc",
              d: 1,
              s: { a: 1, k: [{ i: [[0, 0], [0, 0]], o: [[1, 0], [0, 1]], v: [[-30, -60], [30, -60], [30, 60], [-30, 60]], t: 0 }, { i: [[0, 0], [0, 0]], o: [[1, 0], [0, 1]], v: [[-15, -30], [15, -30], [15, 70], [-15, 70]], t: 60 }] },
              p: { a: 0, k: [0, 0] },
              r: { a: 0, k: 8 },
              nm: "Round Rect 1",
              mn: "ADBE Vector Shape - Round Rect",
              hd: false,
            },
            {
              ty: "fl",
              c: { a: 0, k: [0.047, 0.024, 0.039, 1] },
              o: { a: 0, k: 90 },
              r: 1,
              bm: 0,
              nm: "Fill 1",
              mn: "ADBE Vector Graphic - Fill",
              hd: false,
            },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 }, nm: "Transform" },
          ],
          nm: "Ink Body",
          np: 3,
          cix: 2,
          bm: 0,
          ix: 1,
          mn: "ADBE Vector Group",
          hd: false,
        },
        {
          ddd: 0,
          ind: 2,
          ty: 4,
          nm: "Splash Ring",
          sr: 1,
          ks: {
            o: { a: 0, k: 0 },
            r: { a: 0, k: 0 },
            p: { a: 0, k: [250, 450, 0] },
            a: { a: 0, k: [0, 0, 0] },
            s: { a: 1, k: [{ i: { x: [0.667], y: [1] }, o: { x: [0.333], y: [0] }, t: 60, s: [0, 0, 100], e: [150, 150, 100] }, { t: 120, s: [200, 200, 100] }] },
          },
          ao: 0,
          shapes: [
            {
              ty: "el",
              d: 1,
              s: { a: 0, k: [0, 0] },
              p: { a: 0, k: [0, 0] },
              nm: "Ellipse Path 1",
              mn: "ADBE Vector Shape - Ellipse",
              hd: false,
            },
            {
              ty: "st",
              c: { a: 0, k: [0.047, 0.024, 0.039, 1] },
              o: { a: 0, k: 60 },
              w: { a: 0, k: 4 },
              lc: 2,
              lj: 2,
              ml: 1,
              bm: 0,
              nm: "Stroke 1",
              mn: "ADBE Vector Graphic - Stroke",
              hd: false,
            },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 }, nm: "Transform" },
          ],
          ip: 60,
          op: 180,
          st: 0,
          bm: 0,
        },
        {
          ddd: 0,
          ind: 3,
          ty: 4,
          nm: "Dissolve Particles",
          sr: 1,
          ks: {
            o: { a: 0, k: 0 },
            r: { a: 0, k: 0 },
            p: { a: 0, k: [250, 450, 0] },
            a: { a: 0, k: [0, 0, 0] },
            s: { a: 0, k: [100, 100, 100] },
          },
          ao: 0,
          shapes: [
            {
              tygr: true,
              it: [
                {
                  d: 1,
                  ty: "el",
                  s: { a: 0, k: [6, 6] },
                  p: { a: 1, k: [{ i: { x: [0.833], y: [0.833] }, o: { x: [0.167], y: [0.167] }, t: 60, s: [-40, -30, 0], e: [-80, -90, 0] }, { i: { x: [0.833], y: [0.833] }, o: { x: [0.167], y: [0.167] }, t: 90, s: [30, -60, 0], e: [60, -120, 0] }, { t: 120, s: [50, 20, 0], e: [100, 40, 0] }] },
                  r: { a: 0, k: 5 },
                  nm: "Ellipse Path 1",
                  mn: "ADBE Vector Shape - Ellipse",
                },
                {
                  ty: "fl",
                  c: { a: 0, k: [0.376, 0.188, 0.118, 0.6] },
                  o: { a: 0, k: 50 },
                  r: 1,
                  nm: "Fill 1",
                  mn: "ADBE Vector Graphic - Fill",
                },
                { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 1, k: [{ t: 60, s: [0] }, { t: 150, s: [720] }] }, o: { a: 0, k: 100 }, nm: "Transform" },
              ],
              nm: "Ellipse 1",
              np: 3,
              cix: 2,
              bm: 0,
              ix: 1,
              mn: "ADBE Vector Group",
              hd: false,
            },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 }, nm: "Transform" },
          ],
          ip: 60,
          op: 180,
          st: 0,
          bm: 0,
        },
      ],
    },
  ],
}

export default function LottieInkDrop() {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!container.current) return
    const anim = lottie.loadAnimation({
      container: container.current,
      renderer: "svg",
      loop: true,
      autoplay: true,
      animationData: inkDropLottieAnimation,
      rendererSettings: {
        progressiveLoad: true,
        preserveAspectRatio: "xMidYMid meet",
      },
    })
    return () => anim.destroy()
  }, [])

  return (
    <div ref={container} className="pointer-events-none select-none" style={{ width: '100%', height: '100%' }}>
      <div style={{ width: 500, height: 500 }} />
    </div>
  )
}

export { inkDropLottieAnimation }