/**
 * Minimal SVG `<path d="…">` parser → replicad Drawing.
 *
 * replicad 0.23 has no `drawSVG`, so we parse the path ourselves and feed the
 * pen. This is exactly what the real "SVG input" node needs, and it's the
 * seam where a future "text → SVG" node (via opentype.js glyph paths) will
 * plug in — it also emits path `d` strings.
 *
 * Supported commands: M/m L/l H/h V/v C/c Q/q Z/z (absolute + relative),
 * including implicit repeated commands. First closed subpath only — holes
 * (extra subpaths) are a known TODO for this spike.
 */
import { draw, type Drawing } from "replicad";

type Pt = [number, number];

const NUM = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

interface Seg {
  cmd: string;
  args: number[];
}

function tokenize(d: string): Seg[] {
  const segs: Seg[] = [];
  const re = /([MmLlHhVvCcQqZz])([^MmLlHhVvCcQqZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const nums = m[2].match(NUM)?.map(Number) ?? [];
    segs.push({ cmd: m[1], args: nums });
  }
  return segs;
}

export interface SvgToDrawingOptions {
  /** flip the Y axis (SVG is y-down, CAD is y-up). default true */
  flipY?: boolean;
}

export function svgPathToDrawing(d: string, opts: SvgToDrawingOptions = {}): Drawing {
  const flipY = opts.flipY ?? true;
  const fy = (y: number) => (flipY ? -y : y);

  const segs = tokenize(d);
  if (!segs.length) throw new Error("empty SVG path");

  let pen: ReturnType<typeof draw> | null = null;
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  let started = false;

  const moveTo = (p: Pt) => {
    if (!started) {
      pen = draw([p[0], fy(p[1])]);
      started = true;
    } else {
      pen!.movePointerTo([p[0], fy(p[1])]);
    }
    cur = p;
    start = p;
  };

  for (const { cmd, args } of segs) {
    const rel = cmd === cmd.toLowerCase();
    const abs = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);

    switch (cmd.toUpperCase()) {
      case "M": {
        // first pair = moveto, subsequent pairs = implicit lineto
        moveTo(abs(args[0], args[1]));
        for (let i = 2; i + 1 < args.length; i += 2) {
          const p = abs(args[i], args[i + 1]);
          pen!.lineTo([p[0], fy(p[1])]);
          cur = p;
        }
        break;
      }
      case "L":
        for (let i = 0; i + 1 < args.length; i += 2) {
          const p = abs(args[i], args[i + 1]);
          pen!.lineTo([p[0], fy(p[1])]);
          cur = p;
        }
        break;
      case "H":
        for (const x of args) {
          const p: Pt = rel ? [cur[0] + x, cur[1]] : [x, cur[1]];
          pen!.lineTo([p[0], fy(p[1])]);
          cur = p;
        }
        break;
      case "V":
        for (const y of args) {
          const p: Pt = rel ? [cur[0], cur[1] + y] : [cur[0], y];
          pen!.lineTo([p[0], fy(p[1])]);
          cur = p;
        }
        break;
      case "C":
        for (let i = 0; i + 5 < args.length; i += 6) {
          const c1 = abs(args[i], args[i + 1]);
          const c2 = abs(args[i + 2], args[i + 3]);
          const end = abs(args[i + 4], args[i + 5]);
          pen!.cubicBezierCurveTo(
            [end[0], fy(end[1])],
            [c1[0], fy(c1[1])],
            [c2[0], fy(c2[1])],
          );
          cur = end;
        }
        break;
      case "Q":
        for (let i = 0; i + 3 < args.length; i += 4) {
          const c = abs(args[i], args[i + 1]);
          const end = abs(args[i + 2], args[i + 3]);
          pen!.quadraticBezierCurveTo([end[0], fy(end[1])], [c[0], fy(c[1])]);
          cur = end;
        }
        break;
      case "Z":
        cur = start;
        break;
    }
  }

  if (!pen) throw new Error("SVG path produced no geometry");
  return (pen as ReturnType<typeof draw>).close();
}
