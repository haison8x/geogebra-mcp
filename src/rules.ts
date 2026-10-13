// Guidance served to the AI: short server instructions (always in context), the full
// construction rules (resource + prompt), and the command catalog.
// Rules are adapted from the geogebra-autodraw-ai extension's prompt template, re-verified
// against the async GeoGebra API this server uses.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CatalogEntry = { name: string; syntax: string; description: string };

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const CATALOG: CatalogEntry[] = JSON.parse(readFileSync(resolve(dataDir, 'commands.json'), 'utf8'));

// Common commands outside the geometry catalog — used only to avoid false "unknown command" hints.
const EXTRA_COMMANDS = [
  'Center', 'Reflect', 'Rotate', 'Translate', 'Dilate', 'Vector', 'Text', 'Function', 'Sequence', 'If',
  'Element', 'Mirror', 'Polar', 'Asymptote', 'Ellipse', 'Hyperbola', 'Parabola', 'Conic', 'Slider', 'Max',
  'Min', 'Sum', 'UnitVector', 'UnitPerpendicularVector', 'OrthogonalLine', 'Excenter', 'Orthocenter',
  'ShowLabel', 'SetVisibleInView', 'SetVisible', 'Delete', 'Sqrt', 'sqrt', 'abs', 'sin', 'cos', 'tan',
  'x', 'y', 'Rename', 'CircumcircleArc', 'Tangents', 'Cross', 'Dot', 'Det', 'Simplify', 'Round',
];
export const KNOWN_COMMANDS = new Set([...CATALOG.map((c) => c.name), ...EXTRA_COMMANDS]);

export const CATALOG_TEXT = CATALOG.map(
  (c) => `- ${c.name}: ${c.syntax}${c.description ? ` — ${c.description}` : ''}`,
).join('\n');

export const SERVER_INSTRUCTIONS = `This server draws plane-geometry figures on a live GeoGebra Calculator window that the user can see.

Workflow:
1. Before drawing a problem, read the resource geogebra://rules (or use the prompt "draw_geometry_problem") — it has the construction rules.
2. Build the figure with ggb_run_commands (English GeoGebra command names, one command per array item, define before use).
3. Check every result: fix failed commands using the hints, and watch the warnings (undefined objects, names that were not created).
4. Verify with ggb_evaluate (e.g. Angle, Distance, AreCollinear, AreParallel) and look at ggb_screenshot. Use ggb_fit_view if the figure is off-screen.
5. To fix a figure, ALWAYS call ggb_get_state first — the user may have edited it by hand. Prefer REDEFINING an object
   (D = Midpoint(B, C)) over deleting it: deleting removes everything that depends on it, redefining keeps dependents.
6. ggb_undo reverts the last change made through this server; ggb_snapshot saves/restores named versions.

Draw literally what the problem states (do not solve it), in general position, and keep the figure clean: hide helper objects, keep labels on points only.`;

export const RULES = `GEOGEBRA CONSTRUCTION RULES

COMMANDS
- Command names MUST be English (Polygon, Segment, Midpoint…). One command per item, objects defined before use.
- Name every object so it can be referenced later. Point names start with an UPPERCASE letter
  (p = (3, 4) creates a VECTOR, not a point). Lowercase names are for segments, lines, circles, numbers.
- Never use reserved names: x, y, z, e, i, pi, rad, deg.
- Free point: A = (-1, 6). Never A = Point((-1, 6)).
- Point on a path (line, segment, circle): B = Point(c).
- Commands that do NOT exist: ParallelLine, Circumcenter, Incenter, PerpendicularSegment, MidSegment.
  Parallel line through P to l → Line(P, l). Perpendicular through P to l → PerpendicularLine(P, l).
  Circumcenter of circle c → Center(c). Incenter of ABC → TriangleCenter(A, B, C, 1). Incircle → Incircle(A, B, C).
- Foot of the perpendicular from P to line l: H = ClosestPoint(l, P), or H = Intersect(l, PerpendicularLine(P, l)).
- Angle bisector of angle YXZ (vertex X in the middle): AngleBisector(Y, X, Z). The two-line form returns two lines.
- Line/ray ∩ circle gives TWO points: pass an index, Intersect(c, l, 1) or Intersect(c, l, 2). Without an index you get
  P_1, P_2 and the name P does not exist. Line ∩ line needs no index.
- Ray from a point INSIDE a circle meets it once: P = Intersect(c, Ray(M, H)) with no index.
- Line through a point A that is ALREADY ON the circle, second intersection D: do not use Intersect with an index
  (it may return A). Use the chord midpoint: M = ClosestPoint(l, O), then D = Reflect(A, M).
- Visibility helpers accepted by ggb_run_commands: ShowLabel(obj, false), SetVisibleInView(obj, 1, false), Delete(obj).
  For colors, captions, thickness use ggb_set_style.

LITERAL CONSTRUCTION
- Build every object by the EXACT definition the problem gives, not by a property you could prove. The figure must stay
  correct when free points are dragged.
- "L đối xứng H qua BC" → L = Reflect(H, Line(B, C)) — not "second intersection of AH with the circumcircle".
- "M là trung điểm BC" → M = Midpoint(B, C). "AD là đường cao" → D = ClosestPoint(Line(B, C), A).
- Draw only what the problem asks. Do not solve it, do not add auxiliary constructions it does not mention.

GENERAL POSITION
- Do not add properties the problem does not state. A plain "triangle ABC" is scalene, not right, not isosceles.
  Default: A = (-1, 6), B = (-3, 0), C = (7, 0).
- Other plain polygons: irregular integer coordinates within about -10..10.
- Square / regular polygon with given vertex names: place two adjacent vertices, build the rest with Rotate:
  A = (0, 0), B = (4, 0), C = Rotate(A, -90°, B), D = Rotate(B, 90°, A), sq = Polygon(A, B, C, D).

CLEAN FIGURE
- Objects mentioned in the problem stay visible. Helper objects are hidden right after creation
  (SetVisibleInView(name, 1, false)).
- Sides are Segments, not Lines, unless the problem asks for a line or ray.
- Hide labels of segments and lines (ShowLabel(name, false)); keep labels on points.
- Circles: draw the whole circle (no arcs for circumcircle/incircle) and keep the center point visible.
  Circumcircle of ABC: omega = Circle(A, B, C), O = Center(omega).

VERIFY AND FIX
- After drawing, check key facts with ggb_evaluate (Angle(B, A, C), Distance(B, M) == Distance(M, C), AreCollinear(...)),
  and look at ggb_screenshot. Then ggb_fit_view so everything is visible.
- To change an object, redefine it with the same name; dependents update automatically.

EXAMPLE — triangle ABC and the altitude AH:
A = (-1, 6)
B = (-3, 0)
C = (7, 0)
a = Segment(B, C)
b = Segment(A, C)
c = Segment(A, B)
ShowLabel(a, false)
ShowLabel(b, false)
ShowLabel(c, false)
H = ClosestPoint(Line(B, C), A)
h = Segment(A, H)
ShowLabel(h, false)`;

export function drawProblemPrompt(problem: string): string {
  return `Draw the figure for this plane-geometry problem on the GeoGebra window using the ggb_* tools.

PROBLEM:
<problem>
${problem.trim()}
</problem>

Start with ggb_clear (unless I asked to keep the current figure), build the figure with ggb_run_commands, fix any failed
command, verify the key properties with ggb_evaluate, look at ggb_screenshot, then ggb_fit_view. Finish with a short
summary of what was drawn.

${RULES}`;
}
