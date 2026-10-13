// GeoGebra's API reports a failed command only as `null` — no message. These heuristics
// guess the likely cause so the AI can fix the command instead of retrying blindly.

const RESERVED = new Set(['x', 'y', 'z', 'e', 'i', 'pi', 'rad', 'deg']);
const KEYWORDS = new Set([...RESERVED, 'true', 'false', 'xAxis', 'yAxis', 'infinity', 'sqrt', 'sin', 'cos', 'tan', 'abs']);

// Commands seen to fail or that do not exist, with the working replacement.
const PITFALLS: [RegExp, string][] = [
  [/\bParallelLine\s*\(/, 'ParallelLine does not exist — use Line(<Point>, <Parallel Line>)'],
  [/\bCircumcenter\s*\(/, 'Circumcenter does not exist — use c = Circle(A, B, C) then O = Center(c)'],
  [/\bPerpendicularSegment\s*\(/, 'PerpendicularSegment does not exist — build the foot with Intersect(l, PerpendicularLine(P, l)) then Segment'],
  [/\bMidSegment\s*\(/, 'MidSegment does not exist — build the two midpoints and a Segment'],
  [/=\s*Point\s*\(\s*[({]/, 'define a free point directly: A = (1, 2), not A = Point((1, 2))'],
  [/\bAngleBisector\s*\(\s*[A-Za-z]\w*\s*,\s*[A-Za-z]\w*\s*\)/, 'AngleBisector(<Line>, <Line>) returns two lines; for the bisector of angle YXZ use AngleBisector(Y, X, Z)'],
];

export function diagnose(command: string, existing: Iterable<string>, knownCommands: Set<string>): string[] {
  const hints: string[] = [];
  const names = new Set(existing);

  for (const [re, hint] of PITFALLS) if (re.test(command)) hints.push(hint);

  const unbalanced = checkBrackets(command);
  if (unbalanced) hints.push(unbalanced);

  const noStrings = command.replace(/"[^"]*"/g, '""');
  const assign = /^\s*([A-Za-z][\w']*(?:_\{[^}]*\})?)\s*(?::)?=(?!=)/.exec(noStrings);
  const target = assign?.[1];
  if (target && RESERVED.has(target)) hints.push(`'${target}' is a reserved GeoGebra name — pick another name`);

  const body = assign ? noStrings.slice(assign[0].length) : noStrings;
  const unknownCommands = new Set<string>();
  const unknownObjects = new Set<string>();
  const tokenRe = /([A-Za-z][A-Za-z0-9']*(?:_\{[^}]*\}|_[A-Za-z0-9]+)?)(\s*[([])?/g;
  for (const m of body.matchAll(tokenRe)) {
    const tok = m[1];
    const isCall = !!m[2];
    if (isCall) {
      if (!knownCommands.has(tok) && !names.has(tok)) unknownCommands.add(tok);
    } else if (!names.has(tok) && !KEYWORDS.has(tok)) {
      unknownObjects.add(tok);
    }
  }
  if (unknownObjects.size > 0) {
    hints.push(`these names do not exist in the figure: ${[...unknownObjects].join(', ')} — create them first or check spelling/case`);
  }
  if (unknownCommands.size > 0) {
    hints.push(
      `not in the known command list: ${[...unknownCommands].join(', ')} — check the English command name ` +
        `(resource geogebra://commands lists the geometry commands)`,
    );
  }

  if (hints.length === 0) {
    hints.push(
      'GeoGebra rejected the command without detail. Usually the argument types or count do not match any syntax of the command — ' +
        'check it against geogebra://commands, or use ggb_get_state to confirm the types of the objects you pass in',
    );
  }
  return hints;
}

function checkBrackets(s: string): string | null {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  let inString = false;
  for (const ch of s) {
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return `unbalanced brackets near '${ch}'`;
    }
  }
  if (inString) return 'unterminated string (missing ")';
  if (stack.length > 0) return `unclosed bracket '${stack[stack.length - 1]}'`;
  return null;
}
