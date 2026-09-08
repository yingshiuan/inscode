/**
 * QRSpec — the single contract shared by the browser renderer and the Python API.
 *
 * A spec fully describes a design. Anything derived from it (the module matrix,
 * the art-mode mark decisions) is optional: when present it is *authoritative* and
 * the consumer must not recompute it, when absent the consumer derives it itself.
 *
 * That asymmetry is deliberate. The JS and Python `qrcode` libraries each run their
 * own segment optimisation and mask-penalty scoring, so the same text can legitimately
 * encode to a different version or mask on each side. Both scan; they look different.
 * Shipping the browser's encode result alongside the design removes the disagreement
 * instead of trying to test for it -- while `POST /api/render` still works from curl
 * with nothing but `content`.
 */
import { z } from 'zod'

export const EC_LEVELS = ['L', 'M', 'Q', 'H'] as const
export const MODULE_SHAPES = ['square', 'circle', 'rounded', 'cross', 'diamond', 'connected'] as const
export const FINDER_SHAPES = ['square', 'rounded', 'circle'] as const
export const MARK_SHAPES = ['cross', 'dot', 'square'] as const
export const MODES = ['classic', 'art'] as const

export type ECLevel = (typeof EC_LEVELS)[number]
export type ModuleShape = (typeof MODULE_SHAPES)[number]
export type FinderShape = (typeof FINDER_SHAPES)[number]
export type MarkShape = (typeof MARK_SHAPES)[number]
export type Mode = (typeof MODES)[number]

/** A colour, or null meaning transparent / inherit depending on the field. */
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/, 'expected #rrggbb or #rrggbbaa')

export const EncodedSchema = z.object({
  version: z.number().int().min(1).max(40),
  maskPattern: z.number().int().min(0).max(7),
  /** Matrix width in modules, excluding the quiet zone. */
  size: z.number().int().min(21).max(177),
  /** Row-major bit-packed matrix, MSB first, base64. `size * size` bits. */
  bits: z.string(),
})

export const LogoSchema = z.object({
  /** data: URI. Never a remote URL -- exports must stay self-contained. */
  src: z.string(),
  /** Centre of the logo, 0..1 across the code area (quiet zone excluded). */
  x: z.number().default(0.5),
  y: z.number().default(0.5),
  /** Longest edge as a fraction of the code width. */
  scale: z.number().min(0.01).max(1).default(0.22),
  rotation: z.number().default(0),
  plate: z
    .object({
      enabled: z.boolean().default(true),
      /** Padding around the logo, in modules. */
      pad: z.number().min(0).default(0.7),
      /** Corner radius as a fraction of the plate's shorter edge. */
      radius: z.number().min(0).max(0.5).default(0.18),
      /** null = follow the canvas background (including transparent). */
      color: Color.nullable().default(null),
    })
    .prefault({}),
})

export const QRSpecSchema = z.object({
  v: z.literal(1).default(1),

  content: z.object({
    text: z.string().default(''),
    ecLevel: z.enum(EC_LEVELS).default('H'),
  }),

  /** Authoritative when present. See the note at the top of this file. */
  encoded: EncodedSchema.optional(),

  mode: z.enum(MODES).default('classic'),

  canvas: z
    .object({
      /** Quiet zone in modules. The spec requires 4; below that scanners get flaky. */
      quietZone: z.number().int().min(0).max(16).default(4),
      /** Pixels per module at export scale 1. Preview is resolution-independent. */
      moduleSize: z.number().min(1).max(200).default(20),
      /** null = transparent. */
      bg: Color.nullable().default('#ffffff'),
    })
    .prefault({}),

  modules: z
    .object({
      shape: z.enum(MODULE_SHAPES).default('square'),
      /** Shrink each module by this fraction, 0 = touching. */
      gap: z.number().min(0).max(0.5).default(0),
      color: Color.default('#000000'),
    })
    .prefault({}),

  finders: z
    .object({
      shape: z.enum(FINDER_SHAPES).default('square'),
      /** null = inherit modules.color. */
      color: Color.nullable().default(null),
      innerColor: Color.nullable().default(null),
    })
    .prefault({}),

  logo: LogoSchema.nullable().default(null),

  art: z
    .object({
      mark: z.enum(MARK_SHAPES).default('cross'),
      /** Mark diameter as a fraction of a module. */
      markSize: z.number().min(0.1).max(1).default(0.6),
      /** Draw timing/alignment patterns as marks too. Prettier, less robust. */
      loose: z.boolean().default(false),
      /** Shrink the artwork until it clears the three finder discs. */
      clearFinders: z.boolean().default(false),
      /** Authoritative when present: base64 RLE of per-module CellKind. */
      cells: z.string().optional(),
    })
    .prefault({}),
})

export type Encoded = z.infer<typeof EncodedSchema>
export type LogoSpec = z.infer<typeof LogoSchema>
export type QRSpec = z.infer<typeof QRSpecSchema>

/**
 * Art mode decides per module whether to draw a solid block, a small mark, or
 * nothing at all (the artwork underneath already reads correctly).
 */
export const CellKind = {
  SKIP: 0,
  SOLID_DARK: 1,
  SOLID_LIGHT: 2,
  MARK_DARK: 3,
  MARK_LIGHT: 4,
} as const
export type CellKind = (typeof CellKind)[keyof typeof CellKind]

/**
 * A dark module needs no help if the art beneath it is already darker than
 * DARK_OK; a light module is fine if the art is lighter than LIGHT_OK. Anything
 * between the two gets a mark painted on so the scanner reads the right value.
 *
 * Shared with server/inscode/sampler.py -- change both together.
 */
export const DARK_OK = 90
export const LIGHT_OK = 165

export function defaultSpec(text = ''): QRSpec {
  return QRSpecSchema.parse({ content: { text } })
}

export function parseSpec(input: unknown): QRSpec {
  return QRSpecSchema.parse(input)
}
