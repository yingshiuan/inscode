/**
 * The design being edited, plus undo/redo.
 *
 * Updates are section-shallow rather than deep-cloned: `logo.src` is a data URI
 * that can run to hundreds of kilobytes, and structuredClone-ing it on every
 * slider tick is the difference between a smooth drag and a stuttering one.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  defaultSpec,
  QRSpecSchema,
  type LogoSpec,
  type QRSpec,
} from '../qr/spec';
import { DEFAULT_OUTPUT, isOutput, type Output } from '../qr/output';

/**
 * Two answers to "how big can this logo be", kept apart on purpose.
 *
 * `estimated` is the model's, available immediately and wrong 4.4% of the time against
 * the calibration matrix. `verified` is a real decoder's, costs about a second, and is
 * the only one the export path will act on. `key` says which design the verified
 * number belongs to (`designKey`); when it stops matching, the answer is stale and is
 * treated as absent rather than as approval.
 */
export type SafetyStatus = 'idle' | 'verifying' | 'verified' | 'unverifiable';

export interface Safety {
  status: SafetyStatus;
  estimated: number | null;
  verified: number | null;
  /**
   * Some sizes read and none satisfied "nothing below fails" -- the design is balanced
   * on the decoder's threshold rather than safely inside it. A different problem from
   * "nothing reads", and worth saying so.
   */
  unstable: boolean;
  key: string | null;
}

const NO_SAFETY: Safety = {
  status: 'idle',
  estimated: null,
  verified: null,
  unstable: false,
  key: null,
};

const HISTORY_LIMIT = 60

/** Where the design is kept between visits. */
const STORAGE_KEY = 'inscode'
/** What it was kept under before the project was renamed. */
const LEGACY_STORAGE_KEY = 'qr-studio'

/**
 * Carry a design across the rename, once.
 *
 * The persisted key is part of the product's contract with the browser, not an
 * internal name: changing it without this would silently orphan every design anyone
 * had saved. Copied rather than moved, so a browser that runs an older build still
 * finds its data where it left it.
 */
function adoptLegacyStorage() {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) return
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (legacy !== null) localStorage.setItem(STORAGE_KEY, legacy)
  } catch {
    // Private windows and blocked site data throw on access. Nothing to carry over.
  }
}

adoptLegacyStorage();

type Section = 'content' | 'canvas' | 'modules' | 'finders' | 'art';

interface QrState {
  spec: QRSpec;
  /**
   * How big this code will actually be. Not part of the spec -- what is drawn does
   * not change because you decide to print it smaller -- but the scan verdict is
   * meaningless without it, so it is remembered alongside the design. Deliberately
   * outside undo/redo: it is a fact about the job, not an edit to the artwork.
   */
  output: Output;
  /** Live safety state: the model's estimate, and the decoder's verdict when it lands. */
  safety: Safety;
  past: QRSpec[];
  future: QRSpec[];
  /** Set while a drag is in flight, so intermediate frames do not each land in history. */
  txn: QRSpec | null;

  patch<K extends Section>(section: K, values: Partial<QRSpec[K]>): void;
  setMode(mode: QRSpec['mode']): void;
  setText(text: string): void;
  setLogo(logo: LogoSpec | null): void;
  patchLogo(values: Partial<LogoSpec>): void;
  patchPlate(values: Partial<LogoSpec['plate']>): void;
  /** Replace the whole spec, e.g. loading a preset. */
  replace(spec: QRSpec): void;
  setOutput(output: Output): void;
  setSafety(next: Safety): void;

  begin(): void;
  end(): void;
  undo(): void;
  redo(): void;
  reset(): void;
}

export const useQrStore = create<QrState>()(
  persist(
    (set, get) => {
      /** Commit a new spec, recording the previous one unless a transaction owns history. */
      const commit = (next: QRSpec) =>
        set((s) => {
          if (s.txn) return { spec: next };
          return {
            spec: next,
            past: [...s.past, s.spec].slice(-HISTORY_LIMIT),
            future: [],
          };
        });

      return {
        spec: defaultSpec('https://insdash.ch'),
        output: DEFAULT_OUTPUT,
        safety: NO_SAFETY,
        past: [],
        future: [],
        txn: null,

        patch: (section, values) =>
          commit({
            ...get().spec,
            [section]: { ...get().spec[section], ...values },
          }),

        setMode: (mode) => {
          const spec = get().spec;
          // Art mode is full-bleed by nature; classic wants a small centre mark.
          // Carry the logo across but retarget its size so the switch looks sane.
          const logo = spec.logo
            ? {
                ...spec.logo,
                scale: mode === 'art' ? 1 : Math.min(spec.logo.scale, 0.3),
              }
            : null;
          commit({ ...spec, mode, logo });
        },

        setText: (text) => {
          const spec = get().spec;
          // encoded is stale the moment the payload changes; useRender re-derives it.
          commit({
            ...spec,
            content: { ...spec.content, text },
            encoded: undefined,
          });
        },

        setLogo: (logo) => commit({ ...get().spec, logo }),
        patchLogo: (values) => {
          const logo = get().spec.logo;
          if (!logo) return;
          commit({ ...get().spec, logo: { ...logo, ...values } });
        },
        patchPlate: (values) => {
          const logo = get().spec.logo;
          if (!logo) return;
          commit({
            ...get().spec,
            logo: { ...logo, plate: { ...logo.plate, ...values } },
          });
        },
        replace: (spec) => commit(spec),
        setOutput: (output) => set({ output }),
        setSafety: (safety) => set({ safety }),

        begin: () => set((s) => (s.txn ? s : { txn: s.spec })),
        end: () =>
          set((s) => {
            if (!s.txn) return s;
            if (s.txn === s.spec) return { txn: null };
            return {
              txn: null,
              past: [...s.past, s.txn].slice(-HISTORY_LIMIT),
              future: [],
            };
          }),

        undo: () =>
          set((s) => {
            const prev = s.past.at(-1);
            if (!prev) return s;
            return {
              spec: prev,
              past: s.past.slice(0, -1),
              future: [s.spec, ...s.future],
            };
          }),
        redo: () =>
          set((s) => {
            const [next, ...rest] = s.future;
            if (!next) return s;
            return { spec: next, past: [...s.past, s.spec], future: rest };
          }),
        reset: () =>
          set({
            spec: defaultSpec('https://insdash.ch'),
            output: DEFAULT_OUTPUT,
            safety: NO_SAFETY,
            past: [],
            future: [],
          }),
      };
    },
    {
      name: STORAGE_KEY,
      version: 1,
      // History and safety are per-session: a verified size belongs to one design in
      // one browser, and restoring it from storage would be approval nobody gave.
      partialize: (s) => ({ spec: s.spec, output: s.output }),
      merge: (persisted, current) => {
        const p = persisted as { spec?: unknown; output?: unknown } | undefined;
        const parsed = QRSpecSchema.safeParse(p?.spec);
        return {
          ...current,
          spec: parsed.success ? parsed.data : current.spec,
          output: isOutput(p?.output) ? p.output : current.output,
        };
      },
    },
  ),
);

/** Undo/redo availability without subscribing to the whole history array. */
export const useCanUndo = () => useQrStore((s) => s.past.length > 0);
export const useCanRedo = () => useQrStore((s) => s.future.length > 0);
