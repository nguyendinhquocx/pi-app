import { memo } from 'react'
import { cn } from '@renderer/lib/utils'

/** 与 resources/icon.svg 一致：terminal prompt，浅色主题为白底黑纹，深色主题自动反色 */
function PiMarkImpl({ className, size = 16 }: { className?: string; size?: number; inverted?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={cn('shrink-0 text-foreground', className)}
      aria-hidden
    >
      <rect width="1024" height="1024" rx="256" ry="256" className="fill-background" />
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={60}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M232 312 L432 512 L232 712" />
        <path d="M512 792 L792 792" />
      </g>
    </svg>
  )
}

export const PiMark = memo(PiMarkImpl)
