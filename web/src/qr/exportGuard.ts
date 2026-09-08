/**
 * Whether the file about to be written actually reads.
 *
 * `verifiedSafeScale` is a **recommendation, not authorization.** It comes from a
 * search that samples logo sizes on a 0.02 grid, and the decoder is not monotone in
 * logo size -- so a failure narrower than the grid slips between two passing samples.
 * One was found in the calibration matrix: a version-20 Q design whose verified answer
 * is 0.459 and which does not read at 0.45. Comparing `scale <= verifiedSafeScale`
 * would have exported it.
 *
 * So the number stays where it is useful -- the badge, and the *Shrink logo to N%*
 * suggestion -- and authorization comes from putting the exact artifact, the one that
 * is about to be written to disk, through the production decoder. That is what
 * `POST /api/render` already does; this is the browser saying the same thing.
 *
 * The decision is separated from the decoding so it can be tested without a browser.
 */
import type { Verdict } from './oracle'

export type ExportDecision =
  | { allowed: true }
  | { allowed: false; reason: string; shrinkTo?: number }

export interface SafetyAdvice {
  /** The decoder-verified recommendation, when there is a fresh one. Advisory only. */
  verified: number | null
  /** Whether the design reads at some sizes and fails at smaller ones. Advisory only. */
  unstable: boolean
  /** The scale the artifact was built at, for phrasing the message. */
  currentScale: number | null
}

/**
 * Permission is a function of `verdict` alone.
 *
 * This is written as two functions rather than one on purpose. `decideExport` decides,
 * and never looks at `advice`; `explain` looks at `advice`, and can only return prose.
 * So no amount of editing the messages can turn a recommendation back into a gate --
 * which is the failure this whole file exists to prevent, and it was the shape of the
 * bug: `verifiedSafeScale` said 0.459, the artifact at 0.45 did not read, and a
 * comparison had authority it should never have had.
 *
 * It cuts the other way too. A design the search could find no safe size for, or one it
 * could not reach a verdict on, still exports if the file itself reads -- four such
 * designs are in the calibration matrix, and blocking them would be refusing to write a
 * file that works because a search elsewhere came up empty.
 */
export function decideExport(verdict: Verdict, advice: SafetyAdvice): ExportDecision {
  if (verdict === 'reads') return { allowed: true }
  return { allowed: false, ...explain(verdict, advice) }
}

/** Words only. Nothing returned from here can change whether the export happens. */
function explain(
  verdict: Exclude<Verdict, 'reads'>,
  advice: SafetyAdvice,
): { reason: string; shrinkTo?: number } {
  if (verdict === 'unavailable') {
    // Only reached once the API fallback has also failed to produce a verdict.
    return {
      reason:
        'This browser could not run the decoder check and the render API is not ' +
        'reachable, so this file cannot be confirmed readable. Start the API, or scan a ' +
        'test print before committing to it.',
    }
  }

  const { verified, unstable, currentScale } = advice
  const at = currentScale === null ? '' : ` at ${Math.round(currentScale * 100)}%`

  if (verified !== null && currentScale !== null && verified < currentScale) {
    return {
      reason: `The decoder could not read this design${at}. It reads this design with the logo at ${Math.round(verified * 100)}% or less.`,
      shrinkTo: verified,
    }
  }
  if (verified !== null) {
    // The recommendation said this size was fine and the artifact disagrees -- the
    // notch the sampled search stepped over. Offering that same number back after it
    // has just failed would be absurd, so this one gets no button.
    return {
      reason: `The decoder could not read this exact design${at}, even though sizes either side of it read. Nudge the logo size and try again.`,
    }
  }
  if (unstable) {
    return {
      reason:
        'This design reads at some logo sizes and fails at others, so it is balanced on ' +
        'the decoder’s threshold. Move the logo off the corners, raise the contrast, or ' +
        'use a higher error correction level.',
    }
  }
  return {
    reason:
      `The decoder could not read this design${at}. Shrink the logo, raise the contrast, ` +
      'or use a higher error correction level.',
  }
}

/**
 * The same decision, when the verdict came from the API instead of this browser.
 *
 * `POST /api/render` verifies the exact artifact before returning it, so a 422 *is* a
 * decoder result -- the same one the browser would have reached had it been able to
 * run the check. Any other failure is not a verdict at all, and cannot authorize.
 *
 * Kept here, next to the browser's version, so both paths answer to one policy.
 */
export function decideServerExport(
  outcome:
    | { ok: true }
    | { ok: false; status: number; message: string; verifiedSafeScale: number | null },
): ExportDecision {
  if (outcome.ok) return { allowed: true }

  if (outcome.status === 422) {
    const message = outcome.message.trim()
    return {
      allowed: false,
      reason: `The decoder could not read this design — ${message.charAt(0).toLowerCase()}${message.slice(1)}`,
      shrinkTo: outcome.verifiedSafeScale ?? undefined,
    }
  }
  return {
    allowed: false,
    reason:
      'This browser could not run the decoder check, and asking the API instead failed ' +
      `(${outcome.message}). This file cannot be confirmed readable.`,
  }
}
