/**
 * One open boundary: a single rounded frame with the upper-right corner held
 * open. It is the whole identity, and it stays legible at 16px.
 */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="logo-tile" width="256" height="256" rx="58" />
      <path
        className="logo-frame"
        d="M168 60H104Q60 60 60 104V152Q60 196 104 196H152Q196 196 196 152V116"
      />
    </svg>
  )
}
