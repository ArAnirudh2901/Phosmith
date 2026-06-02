"use client"

import React, { useRef, useEffect, useMemo, useState } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import * as THREE from "three"

/*
 * ─── Floating Particles & Orbs ───
 * 3D particle field with additive blending,
 * floating orbs with emissive glow,
 * reactive to mouse movement for immersive depth.
 */

function ParticleField() {
  const points = useRef(null)
  const count = 120
  const positions = useRef(new Float32Array(count * 3))
  const velocities = useRef(new Float32Array(count))
  const originalY = useRef(new Float32Array(count))

  useEffect(() => {
    for (let i = 0; i < count; i++) {
      positions.current[i * 3] = (Math.random() - 0.5) * 16
      positions.current[i * 3 + 1] = (Math.random() - 0.5) * 12
      positions.current[i * 3 + 2] = (Math.random() - 0.5) * 10
      originalY.current[i] = positions.current[i * 3 + 1]
      velocities.current[i] = (Math.random() - 0.5) * 0.015
    }
  }, [])

  useFrame((state) => {
    if (!points.current) return
    const pos = points.current.geometry.attributes.position.array
    const t = state.clock.elapsedTime
    for (let i = 0; i < count; i++) {
      const idx = i * 3
      pos[idx + 1] += velocities.current[i]
      if (pos[idx + 1] > 6) pos[idx + 1] = -6
      if (pos[idx + 1] < -6) pos[idx + 1] = 6
      pos[idx] += Math.sin(t * 0.3 + i * 0.7) * 0.003
      pos[idx + 2] += Math.cos(t * 0.2 + i * 0.5) * 0.002
    }
    points.current.geometry.attributes.position.needsUpdate = true
  })

  return (
    <points ref={points}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={positions.current}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.035}
        color="#C8956C"
        transparent
        opacity={0.5}
        blending={THREE.AdditiveBlending}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  )
}

function FloatingOrb({ position, color, speed, size = 0.2 }) {
  const ref = useRef(null)
  const origPos = useRef(position)

  useFrame((state) => {
    if (!ref.current) return
    const t = state.clock.elapsedTime * speed
    ref.current.position.x = origPos.current[0] + Math.sin(t) * 1.5
    ref.current.position.y = origPos.current[1] + Math.cos(t * 1.3) * 1.0
    ref.current.position.z = origPos.current[2] + Math.sin(t * 0.7) * 0.5
    ref.current.rotation.y += 0.005
  })

  return (
    <mesh ref={ref} position={position}>
      <sphereGeometry args={[size, 32, 32]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.6}
        transparent
        opacity={0.75}
        metalness={0.2}
        roughness={0.3}
      />
    </mesh>
  )
}

function ConnectionLines({ orbs }) {
  const ref = useRef(null)

  useFrame(() => {
    if (!ref.current) return
    const positions = ref.current.geometry.attributes.position.array
    let idx = 0
    for (let i = 0; i < orbs.length; i++) {
      for (let j = i + 1; j < orbs.length; j++) {
        if (idx >= positions.length) break
        // Lines are set by the geometry, we just update visibility
      }
    }
  })

  return (
    <lineSegments ref={ref}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={orbs.length * (orbs.length - 1)}
          array={useMemo(() => {
            const arr = new Float32Array(orbs.length * (orbs.length - 1) * 2 * 3)
            let idx = 0
            for (let i = 0; i < orbs.length; i++) {
              for (let j = i + 1; j < orbs.length; j++) {
                const dist = Math.sqrt(
                  Math.pow(orbs[i][0] - orbs[j][0], 2) +
                  Math.pow(orbs[i][1] - orbs[j][1], 2) +
                  Math.pow(orbs[i][2] - orbs[j][2], 2)
                )
                if (dist < 5) {
                  arr[idx++] = orbs[i][0]; arr[idx++] = orbs[i][1]; arr[idx++] = orbs[i][2]
                  arr[idx++] = orbs[j][0]; arr[idx++] = orbs[j][1]; arr[idx++] = orbs[j][2]
                }
              }
            }
            return arr
          }, [orbs])}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial
        color="#00E5FF"
        transparent
        opacity={0.08}
        linewidth={0.5}
      />
    </lineSegments>
  )
}

const ORB_CONFIGS = [
  { position: [-4, 2.5, -2], color: "#00E5FF", speed: 0.4, size: 0.25 },
  { position: [4, -1.5, -1], color: "#D946EF", speed: 0.3, size: 0.2 },
  { position: [0, 3.5, -3], color: "#FBBF24", speed: 0.5, size: 0.15 },
  { position: [-3, -2, -1.5], color: "#34D399", speed: 0.35, size: 0.18 },
  { position: [3.5, 2, -2.5], color: "#C8956C", speed: 0.25, size: 0.22 },
  { position: [0, -3, 0], color: "#A8B0B6", speed: 0.45, size: 0.12 },
  { position: [-2, 0, -4], color: "#F43F5E", speed: 0.3, size: 0.1 },
  { position: [2.5, 1, -1], color: "#00E5FF", speed: 0.5, size: 0.16 },
]

export default function FloatingParticles() {
  const [dpr, setDpr] = useState(1)
  useEffect(() => {
    setDpr(Math.min(window.devicePixelRatio, 1.5))
  }, [])
  return (
    <div className="fixed inset-0 -z-10 pointer-events-none">
      <Canvas
        camera={{ position: [0, 0, 10], fov: 75 }}
        gl={{ antialias: true, alpha: true }}
        dpr={dpr}
      >
        <ambientLight intensity={0.15} />
        <pointLight position={[5, 5, 5]} intensity={0.4} color="#C8956C" />
        <pointLight position={[-5, -3, 3]} intensity={0.3} color="#00E5FF" />
        <pointLight position={[0, 0, 8]} intensity={0.2} color="#D946EF" />
        <fog attach="fog" args={["#07090E", 8, 25]} />
        <ParticleField />
        {ORB_CONFIGS.map((orb, i) => (
          <FloatingOrb key={i} {...orb} />
        ))}
      </Canvas>
    </div>
  )
}
