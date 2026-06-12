import { memo } from 'react'

/**
 * Pixxel brand icon
 */
const PixxelWordmark = memo(function PixxelWordmark() {
    return (
        <img 
            src="/Logo.png" 
            alt="Pixxel Logo" 
            style={{ flex: '0 0 auto', display: 'block', height: '24px', width: 'auto' }}
        />
    )
})

export default PixxelWordmark

