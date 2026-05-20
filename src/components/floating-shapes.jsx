"use client"

import React from 'react'
import { motion } from 'framer-motion'
import { useParallax } from '../../hooks/parallax-effect'

/*
 * ─── Floating Shapes ───
 * Neutral glass haze, parallax reactive, soft glow, and breathing animation.
 */

const SHAPES = [
    {
        id: 1,
        size: "w-72 h-72 md:w-96 md:h-96",
        position: "top-20 left-5 md:left-10",
        gradient: "from-white/10 via-white/5 to-transparent",
        duration: "10s",
        delay: "0s"
    },
    {
        id: 2,
        size: "w-64 h-64 md:w-80 md:h-80",
        position: "top-1/3 right-5 md:right-10",
        gradient: "from-white/10 via-white/5 to-transparent",
        duration: "12s",
        delay: "2s"
    },
    {
        id: 3,
        size: "w-48 h-48 md:w-64 md:h-64",
        position: "bottom-20 left-1/4",
        gradient: "from-white/10 via-white/5 to-transparent",
        duration: "8s",
        delay: "4s"
    },
    {
        id: 4,
        size: "w-56 h-56 md:w-80 md:h-80",
        position: "bottom-1/3 right-1/4",
        gradient: "from-white/10 via-white/5 to-transparent",
        duration: "14s",
        delay: "1s"
    },
    {
        id: 5,
        size: "w-40 h-40 md:w-56 md:h-56",
        position: "top-1/2 left-1/3",
        gradient: "from-white/10 via-white/5 to-transparent",
        duration: "11s",
        delay: "3s"
    },
    {
        id: 6,
        size: "w-32 h-32 md:w-48 md:h-48",
        position: "top-3/4 right-1/3",
        gradient: "from-white/10 via-white/5 to-transparent",
        duration: "9s",
        delay: "5s"
    },
]

const FloatingShapes = () => {
    const scrollY = useParallax()

    return (
        <div className='fixed inset-0 overflow-hidden pointer-events-none'>
            {SHAPES.map((shape) => (
                <motion.div
                    key={shape.id}
                    className={`absolute ${shape.size} ${shape.position} bg-gradient-to-br ${shape.gradient} rounded-full blur-3xl`}
                    style={{
                        animationDuration: shape.duration,
                        animationDelay: shape.delay,
                        animationName: 'float',
                    }}
                    animate={{
                        y: scrollY * 0.3,
                        rotate: scrollY * 0.05,
                    }}
                    transition={{ type: 'spring', stiffness: 50, damping: 20 }}
                />
            ))}
        </div>
    )
}

export default FloatingShapes
