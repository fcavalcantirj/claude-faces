import { describe, expect, it } from "vitest";
import { VISEMES } from "wawa-lipsync";
import { mouthShapeForViseme } from "./mouth-shape";

const SIL = VISEMES.sil as string;
const AA = VISEMES.aa as string;
const O = VISEMES.O as string;
const U = VISEMES.U as string;
const PP = VISEMES.PP as string;

describe("mouthShapeForViseme", () => {
  it("is fully closed/resting at zero amplitude for every viseme", () => {
    for (const v of Object.values(VISEMES) as string[]) {
      const s = mouthShapeForViseme(v, 0);
      expect(s.openY).toBeCloseTo(1, 10);
      expect(s.widthX).toBeCloseTo(1, 10);
    }
  });

  it("opens the jaw monotonically as amplitude rises (aa)", () => {
    const a = mouthShapeForViseme(AA, 0.25).openY;
    const b = mouthShapeForViseme(AA, 0.5).openY;
    const c = mouthShapeForViseme(AA, 1).openY;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeGreaterThan(1);
  });

  it("widens on 'aa' and narrows on 'O'/'U' at full amplitude", () => {
    expect(mouthShapeForViseme(AA, 1).widthX).toBeGreaterThan(1); // spread vowel
    expect(mouthShapeForViseme(O, 1).widthX).toBeLessThan(1); // rounded, narrows
    expect(mouthShapeForViseme(U, 1).widthX).toBeLessThan(1); // pursed, narrows
  });

  it("opens 'aa' wider than a bilabial 'PP' at the same amplitude", () => {
    expect(mouthShapeForViseme(AA, 1).openY).toBeGreaterThan(
      mouthShapeForViseme(PP, 1).openY,
    );
  });

  it("keeps the mouth closed for silence even at full amplitude", () => {
    const s = mouthShapeForViseme(SIL, 1);
    expect(s.openY).toBeCloseTo(1, 10);
    expect(s.widthX).toBeCloseTo(1, 10);
  });

  it("clamps amplitude to 0..1 and treats non-finite as zero", () => {
    expect(mouthShapeForViseme(AA, 5)).toEqual(mouthShapeForViseme(AA, 1));
    const neg = mouthShapeForViseme(AA, -3);
    expect(neg.openY).toBeCloseTo(1, 10);
    expect(neg.widthX).toBeCloseTo(1, 10);
    const nan = mouthShapeForViseme(AA, Number.NaN);
    expect(nan.openY).toBeCloseTo(1, 10);
    expect(nan.widthX).toBeCloseTo(1, 10);
  });

  it("produces finite, sane factors for an unknown viseme", () => {
    const s = mouthShapeForViseme("viseme_does_not_exist", 1);
    expect(Number.isFinite(s.openY)).toBe(true);
    expect(Number.isFinite(s.widthX)).toBe(true);
    expect(s.openY).toBeGreaterThan(1); // still opens on amplitude
    expect(s.widthX).toBeGreaterThan(0);
  });

  it("yields finite openY>=1 and widthX>0 across every viseme at full amplitude", () => {
    for (const v of Object.values(VISEMES) as string[]) {
      const s = mouthShapeForViseme(v, 1);
      expect(Number.isFinite(s.openY)).toBe(true);
      expect(Number.isFinite(s.widthX)).toBe(true);
      expect(s.openY).toBeGreaterThanOrEqual(1);
      expect(s.widthX).toBeGreaterThan(0);
    }
  });
});
