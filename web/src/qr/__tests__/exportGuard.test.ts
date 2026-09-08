import { describe, expect, it } from 'vitest'
import { decideExport, decideServerExport } from '../exportGuard'

/**
 * The export invariant: nothing is written unless that exact artifact read back.
 *
 * These pin the *decision*, not the decoding -- the oracle needs a browser, the policy
 * does not. What matters here is which inputs are capable of granting permission, and
 * the answer is exactly one of them: the decoder's verdict about the file being
 * written. Everything else can only shape the refusal.
 */

const NONE = { verified: null, unstable: false, currentScale: null }

describe('only the decoder authorizes an export', () => {
  it('allows an artifact that read back', () => {
    expect(decideExport('reads', NONE)).toEqual({ allowed: true })
  })

  it('blocks an artifact that did not', () => {
    expect(decideExport('fails', NONE).allowed).toBe(false)
  })

  it('blocks when the browser could not run the check at all', () => {
    // Not a pass. A browser without canvas filters cannot apply the production
    // profile, and "we could not look" must never read as "we looked and it was fine".
    const decision = decideExport('unavailable', NONE)
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.reason).toContain('could not run')
  })
})

describe('verifiedSafeScale is a recommendation, not authorization', () => {
  /**
   * The case that motivated this. `verified_max_scale` searches logo sizes on a 0.02
   * grid; the decoder is not monotone in size, so a failure narrower than the grid
   * hides between two passing samples. In the calibration matrix, v20Q square-dark at
   * position 0.5,0.27 verifies to 0.459 and does not read at 0.45.
   *
   * `scale <= verifiedSafeScale` is true there. It must still not export.
   */
  const NOTCH = { verified: 0.459, unstable: false, currentScale: 0.45 }

  it('refuses the v20Q 0.45 notch even though 0.45 <= 0.459', () => {
    expect(NOTCH.currentScale).toBeLessThan(NOTCH.verified)
    expect(decideExport('fails', NOTCH).allowed).toBe(false)
  })

  it('says something useful about a notch rather than offering the same number back', () => {
    const decision = decideExport('fails', NOTCH)
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    // Offering "shrink to 45.9%" after 45% just failed would be absurd.
    expect(decision.shrinkTo).toBeUndefined()
    expect(decision.reason).toContain('either side of it')
  })

  it('offers the verified size when the logo is genuinely over it', () => {
    const decision = decideExport('fails', { verified: 0.2, unstable: false, currentScale: 0.45 })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.shrinkTo).toBe(0.2)
  })

  it('never turns a verified number into permission on its own', () => {
    // Every shape of advice, with the decoder saying no. None of them may pass.
    const advices = [
      { verified: 0.9, unstable: false, currentScale: 0.1 },
      { verified: 1, unstable: false, currentScale: null },
      { verified: 0.5, unstable: true, currentScale: 0.5 },
      NONE,
    ]
    for (const advice of advices) {
      expect(decideExport('fails', advice).allowed).toBe(false)
    }
  })
})

describe('stale and estimated answers cannot authorize', () => {
  it('a stale verification is passed as absent, and still cannot pass a failing artifact', () => {
    // ExportMenu drops `verified` to null when `safety.key` no longer matches the
    // design. Either way the verdict decides.
    expect(decideExport('fails', { verified: null, unstable: false, currentScale: 0.3 }).allowed)
      .toBe(false)
    expect(decideExport('reads', { verified: null, unstable: false, currentScale: 0.3 }).allowed)
      .toBe(true)
  })

  it('has nowhere to put an estimate, which is the point', () => {
    // `SafetyAdvice` carries no estimated scale. The heuristic cannot reach this
    // decision even by accident.
    expect(Object.keys(NONE).sort()).toEqual(['currentScale', 'unstable', 'verified'])
  })
})

describe('advice can never withhold permission', () => {
  /**
   * The rule, as a property rather than a handful of examples: whatever the
   * recommendation says -- no safe size found, a maximum below the current scale, an
   * unstable design, a stale answer -- a readable artifact exports.
   *
   * This is the half that is easy to get wrong in the safe-looking direction. Four
   * designs in the calibration matrix have no verified safe size and read anyway;
   * refusing to write a working file because a search came up empty is still a bug.
   */
  const ADVICE = [
    { verified: null, unstable: false, currentScale: null },
    { verified: null, unstable: false, currentScale: 0.45 },
    { verified: null, unstable: true, currentScale: 0.1 }, // "no safe logo size found"
    { verified: 0.1, unstable: false, currentScale: 0.9 }, // far over the recommendation
    { verified: 0.459, unstable: false, currentScale: 0.45 }, // the v20Q notch
    { verified: 0, unstable: true, currentScale: 1 },
  ]

  it('lets every one of them through when the artifact reads', () => {
    for (const advice of ADVICE) {
      expect(decideExport('reads', advice)).toEqual({ allowed: true })
    }
  })

  it('blocks every one of them when the artifact does not', () => {
    for (const advice of ADVICE) {
      expect(decideExport('fails', advice).allowed).toBe(false)
    }
  })

  it('depends on the verdict and nothing else', () => {
    // The decision is identical across all advice; only the wording moves.
    const allowed = new Set(ADVICE.map((a) => decideExport('reads', a).allowed))
    const refused = new Set(ADVICE.map((a) => decideExport('fails', a).allowed))
    expect([...allowed]).toEqual([true])
    expect([...refused]).toEqual([false])
  })
})

describe('the API fallback is a verdict, not a shrug', () => {
  /**
   * A browser without canvas filters cannot apply the production profile, so it cannot
   * reach a verdict on its own. Refusing there would hard-block a whole class of
   * browsers on no evidence; passing would export an unchecked file. So the API is
   * asked instead -- `POST /api/render` runs the identical check on the identical
   * drawing -- and its 422 is a real decoder result standing in for the missing one.
   */
  it('allows what the API was willing to render', () => {
    expect(decideServerExport({ ok: true })).toEqual({ allowed: true })
  })

  it('treats a 422 as the decoder declining, and passes on the size that works', () => {
    const decision = decideServerExport({
      ok: false, status: 422, verifiedSafeScale: 0.349,
      message: 'this design does not decode under the phone profile; the decoder reads it '
        + 'with the logo at 35% or less (currently 45%)',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.shrinkTo).toBe(0.349)
    expect(decision.allowed === false && decision.reason).toContain('could not read')
  })

  it('still refuses a 422 that carries a safe size — the size is a suggestion', () => {
    // The one thing that must never happen: a number in the refusal turning it into
    // permission.
    for (const verifiedSafeScale of [0.9, 0.0, null]) {
      expect(
        decideServerExport({ ok: false, status: 422, message: 'nope', verifiedSafeScale }).allowed,
      ).toBe(false)
    }
  })

  it('does not treat a network failure as a verdict', () => {
    const decision = decideServerExport({
      ok: false, status: 0, message: 'Failed to fetch', verifiedSafeScale: null,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.reason).toContain('failed')
    expect(decision.allowed === false && decision.shrinkTo).toBeUndefined()
  })

  it('does not treat a server error as a verdict either', () => {
    const decision = decideServerExport({
      ok: false, status: 500, message: 'render failed', verifiedSafeScale: null,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.shrinkTo).toBeUndefined()
  })
})
