/**
 * The Python render API.
 *
 * The browser already renders and exports on its own; this is for the jobs it
 * cannot do well -- print-resolution output and batches -- and it always sends the
 * resolved spec (encode result and art decisions included) so the server draws
 * exactly what was on screen rather than deriving its own answer.
 */
import type { QRSpec } from '../qr/spec'

export type ExportFormat = 'png' | 'jpg' | 'svg'

export interface BatchItem {
  text: string
  name?: string
}

/**
 * A refusal from the API, with whatever it could tell us about why.
 *
 * `/api/render` verifies the exact artifact before returning it, so a 422 here is the
 * decoder declining to read the file -- the same answer the browser would have given
 * if it could run the check itself. `verifiedSafeScale` rides along when the server
 * found a size that does work.
 */
export class ApiError extends Error {
  status: number
  verifiedSafeScale: number | null

  constructor(status: number, message: string, verifiedSafeScale: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.verifiedSafeScale = verifiedSafeScale
  }
}

async function post(path: string, body: unknown): Promise<Blob> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    let verified: number | null = null
    try {
      const detail = (await res.json())?.detail
      if (typeof detail === 'string') {
        message = detail
      } else if (detail && typeof detail === 'object') {
        if (typeof detail.detail === 'string') message = detail.detail
        if (typeof detail.verifiedSafeScale === 'number') verified = detail.verifiedSafeScale
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, verified)
  }
  return res.blob()
}

export const renderOnServer = (spec: QRSpec, format: ExportFormat, px: number) =>
  post('/api/render', { spec, format, px })

export const renderBatch = (template: QRSpec, items: BatchItem[], format: ExportFormat, px: number) =>
  post('/api/batch', { template, items, format, px })

export interface StressReport {
  grade: 'ok' | 'risky' | 'fragile' | 'fail'
  score: number
  passed: number
  total: number
  message: string
  conditions: { condition: string; size: number; ok: boolean }[]
}

export async function validateOnServer(spec: QRSpec): Promise<StressReport> {
  const blob = await post('/api/validate', { spec })
  return JSON.parse(await blob.text())
}

/** Whether the API is reachable, so the UI can hide server-only options when it is not. */
export async function apiAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}
