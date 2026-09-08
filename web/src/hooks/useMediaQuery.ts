import { useEffect, useState } from 'react'

/**
 * Layout that differs by more than CSS can express — a different tree, not a
 * different rule — needs the breakpoint in JavaScript. Only one component may own
 * the decoder and the file input, so the panels are moved rather than duplicated
 * behind `hidden`/`lg:block`.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}
