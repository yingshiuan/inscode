/** Miniature previews of each module shape, so the control shows the result. */
const box = (children: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
    {children}
  </svg>
)

export const ShapeIcon = {
  square: box(<><rect x="3" y="3" width="8" height="8" /><rect x="13" y="3" width="8" height="8" /><rect x="3" y="13" width="8" height="8" /></>),
  circle: box(<><circle cx="7" cy="7" r="4" /><circle cx="17" cy="7" r="4" /><circle cx="7" cy="17" r="4" /></>),
  rounded: box(<><rect x="3" y="3" width="8" height="8" rx="2.5" /><rect x="13" y="3" width="8" height="8" rx="2.5" /><rect x="3" y="13" width="8" height="8" rx="2.5" /></>),
  cross: box(<><path d="M7 3 8.4 5.6 11 7 8.4 8.4 7 11 5.6 8.4 3 7 5.6 5.6Z" /><path d="M17 3 18.4 5.6 21 7 18.4 8.4 17 11 15.6 8.4 13 7 15.6 5.6Z" /><path d="M7 13 8.4 15.6 11 17 8.4 18.4 7 21 5.6 18.4 3 17 5.6 15.6Z" /></>),
  diamond: box(<><path d="M7 3 11 7 7 11 3 7Z" /><path d="M17 3 21 7 17 11 13 7Z" /><path d="M7 13 11 17 7 21 3 17Z" /></>),
  connected: box(<><path d="M3 3h18v8h-8v10H3Z" /></>),
} as const

export const FinderIcon = {
  square: box(<><path d="M2 2h20v20H2Zm4 4v12h12V6Z" /><rect x="9" y="9" width="6" height="6" /></>),
  rounded: box(<><path d="M6 2h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Zm0 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Z" /><rect x="8" y="8" width="8" height="8" rx="2" /></>),
  circle: box(<><path d="M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22Zm0 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z" /><circle cx="12" cy="12" r="4" /></>),
} as const

export const MarkIcon = {
  cross: ShapeIcon.cross,
  dot: ShapeIcon.circle,
  square: ShapeIcon.square,
} as const
