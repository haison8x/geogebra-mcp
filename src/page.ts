// Functions executed INSIDE the GeoGebra page via Playwright's page.evaluate().
// Each one must be self-contained (no imports, no outer variables): Playwright serializes
// the function source and runs it in the page, where `window.ggbApplet` lives.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    ggbApplet: any;
  }
}

export type CommandResult = {
  index: number;
  command: string;
  ok: boolean;
  labels: string[];
  created: string[];
  removed: string[];
  warnings: string[];
  error?: string;
};

export type RunCommandsResult = {
  results: CommandResult[];
  stoppedAt: number | null;
  objectNames: string[];
};

export async function pageRunCommands(args: { commands: string[]; stopOnError: boolean }): Promise<RunCommandsResult> {
  const g = window.ggbApplet;
  g.setErrorDialogsActive(false);
  const RESERVED = ['x', 'y', 'z', 'e', 'i', 'pi', 'rad', 'deg'];

  // Visibility / deletion are GeoGebra *scripting* commands: they create no object, so
  // evalCommandGetLabels cannot tell success from failure. Route them to the JS API instead.
  const routeScripting = (cmd: string): { ok: boolean; error?: string } | null => {
    const strip = (s: string) => s.trim();
    let m = /^ShowLabel\(\s*(.+?)\s*,\s*(true|false)\s*\)$/i.exec(cmd);
    if (m) {
      if (!g.exists(strip(m[1]))) return { ok: false, error: `object '${strip(m[1])}' does not exist` };
      g.setLabelVisible(strip(m[1]), m[2].toLowerCase() === 'true');
      return { ok: true };
    }
    m =
      /^SetVisibleInView\(\s*(.+?)\s*,\s*\d+\s*,\s*(true|false)\s*\)$/i.exec(cmd) ||
      /^SetVisible\(\s*(.+?)\s*,\s*(true|false)\s*\)$/i.exec(cmd);
    if (m) {
      if (!g.exists(strip(m[1]))) return { ok: false, error: `object '${strip(m[1])}' does not exist` };
      g.setVisible(strip(m[1]), m[m.length - 1].toLowerCase() === 'true');
      return { ok: true };
    }
    m = /^Delete\(\s*(.+?)\s*\)$/i.exec(cmd);
    if (m) {
      if (!g.exists(strip(m[1]))) return { ok: false, error: `object '${strip(m[1])}' does not exist` };
      g.deleteObject(strip(m[1]));
      return { ok: true };
    }
    return null;
  };

  const results: CommandResult[] = [];
  let stoppedAt: number | null = null;

  for (let index = 0; index < args.commands.length; index++) {
    const command = args.commands[index].trim();
    const before: string[] = g.getAllObjectNames() || [];
    const res: CommandResult = { index, command, ok: false, labels: [], created: [], removed: [], warnings: [] };

    let routed: { ok: boolean; error?: string } | null = null;
    try {
      routed = routeScripting(command);
    } catch (e) {
      routed = { ok: false, error: String(e) };
    }

    if (routed) {
      res.ok = routed.ok;
      if (routed.error) res.error = routed.error;
    } else {
      let labels: string | null = null;
      try {
        // The async variant lazy-loads GeoGebra modules (prover, scripting…) that the
        // synchronous evalCommand reports as "not loaded yet".
        labels = await g.asyncEvalCommandGetLabels(command);
      } catch (e) {
        res.error = String((e as any)?.message ?? e);
      }
      if (typeof labels === 'string') {
        res.ok = true;
        res.labels = labels.split(',').filter((l) => l.length > 0);
      }
    }

    const after: string[] = g.getAllObjectNames() || [];
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    res.created = after.filter((n) => !beforeSet.has(n));
    res.removed = before.filter((n) => !afterSet.has(n));

    if (res.ok && !routed) {
      // "P,undefined" is normal (e.g. a ray meets a circle once); only flag it when nothing usable came out.
      if (res.labels.length > 0 && res.labels.every((l) => l === 'undefined' || !g.exists(l) || !g.isDefined(l))) {
        res.warnings.push('the command produced no defined object (e.g. an intersection that does not exist)');
      }
      for (const l of res.labels) {
        if (l !== 'undefined' && g.exists(l) && !g.isDefined(l)) {
          res.warnings.push(`'${l}' is UNDEFINED (the construction has no solution in the current position)`);
        }
      }
      const assign = /^([A-Za-z][\w']*(?:_\{[^}]*\})?)\s*=(?!=)/.exec(command);
      if (assign) {
        const want = assign[1];
        if (!res.labels.includes(want)) {
          if (RESERVED.includes(want)) {
            res.warnings.push(`'${want}' is a reserved GeoGebra name; the object was created as '${res.labels.join(', ')}' instead`);
          } else if (res.labels.length > 1) {
            res.warnings.push(
              `the command produced several objects (${res.labels.join(', ')}), so the name '${want}' does not exist. ` +
                `Use an index, e.g. Intersect(<path1>, <path2>, 1), to get ONE named point`,
            );
          } else if (res.labels.length > 0) {
            res.warnings.push(`requested name '${want}' but GeoGebra named the object '${res.labels.join(', ')}'`);
          }
        } else if (/^[a-z]/.test(want) && g.getObjectType(want) === 'vector' && /=\s*\(/.test(command)) {
          res.warnings.push(`'${want}' became a VECTOR because its name starts with a lowercase letter; point names must start uppercase`);
        }
      }
    }
    if (res.removed.length > 0) {
      res.warnings.push(`objects removed as a side effect: ${res.removed.join(', ')}`);
    }

    results.push(res);
    if (!res.ok && args.stopOnError) {
      stoppedAt = index;
      break;
    }
  }

  return { results, stoppedAt, objectNames: g.getAllObjectNames() || [] };
}

export type ObjectInfo = {
  name: string;
  type: string;
  definition: string;
  value: string;
  coords?: [number, number];
  defined: boolean;
  free: boolean;
  visible: boolean;
  labelVisible: boolean;
  caption?: string;
  dependsOn: string[];
  usedBy: string[];
};

export function pageGetState(): ObjectInfo[] {
  const g = window.ggbApplet;
  const names: string[] = g.getAllObjectNames() || [];
  const nameSet = new Set(names);

  // Parents come from the construction XML: <command><input a0=".."/><output a0=".."/></command>.
  // Inputs can be nested expressions ("Circle[C, 2]"), so collect every known name inside them.
  const parents = new Map<string, Set<string>>();
  const doc = new DOMParser().parseFromString(g.getXML(), 'text/xml');
  const tokenRe = /[A-Za-z][A-Za-z0-9']*(?:_\{[^}]*\}|_[A-Za-z0-9]+)?/g;
  for (const cmd of Array.from(doc.getElementsByTagName('command'))) {
    const input = cmd.getElementsByTagName('input')[0];
    const output = cmd.getElementsByTagName('output')[0];
    if (!input || !output) continue;
    const deps = new Set<string>();
    for (const attr of Array.from(input.attributes)) {
      for (const tok of attr.value.match(tokenRe) || []) if (nameSet.has(tok)) deps.add(tok);
    }
    for (const attr of Array.from(output.attributes)) {
      if (attr.value) parents.set(attr.value, deps);
    }
  }
  // Objects defined by an expression (e.g. "M = (A + B) / 2") have no <command>; parse their definition.
  const objects: ObjectInfo[] = names.map((name) => {
    const type: string = g.getObjectType(name);
    const free: boolean = g.isIndependent(name);
    let definition: string = free ? '' : g.getCommandString(name, false) || g.getDefinitionString(name) || '';
    definition = definition.replace(/\[/g, '(').replace(/\]/g, ')');
    let deps = parents.get(name);
    if (!deps) {
      deps = new Set<string>();
      if (!free) for (const tok of definition.match(tokenRe) || []) if (nameSet.has(tok) && tok !== name) deps.add(tok);
    }
    let value: string = g.getValueString(name) || '';
    const eq = value.indexOf(' = ');
    if (eq >= 0 && value.slice(0, eq).trim() === name) value = value.slice(eq + 3);
    else if (value.startsWith(name + ': ')) value = value.slice(name.length + 2);
    const info: ObjectInfo = {
      name,
      type,
      definition,
      value,
      defined: g.isDefined(name),
      free,
      visible: g.getVisible(name),
      labelVisible: g.getLabelVisible(name),
      dependsOn: Array.from(deps),
      usedBy: [],
    };
    if (type === 'point') info.coords = [round(g.getXcoord(name)), round(g.getYcoord(name))];
    const caption = g.getCaption(name, false);
    if (caption) info.caption = caption;
    return info;
  });
  const byName = new Map(objects.map((o) => [o.name, o]));
  for (const o of objects) for (const p of o.dependsOn) byName.get(p)?.usedBy.push(o.name);
  return objects;

  function round(v: number): number {
    return Math.round(v * 10000) / 10000;
  }
}

export type EvalResult = { expression: string; ok: boolean; type?: string; value?: string; number?: number | null };

export async function pageEvaluate(expressions: string[]): Promise<EvalResult[]> {
  const g = window.ggbApplet;
  g.setErrorDialogsActive(false);
  g.setRepaintingActive(false);
  const out: EvalResult[] = [];
  try {
    for (let i = 0; i < expressions.length; i++) {
      const expression = expressions[i];
      const tmp = `mcpTmpEval${i}`;
      let labels: string | null = null;
      try {
        labels = await g.asyncEvalCommandGetLabels(`${tmp} = ${expression}`);
      } catch {
        labels = null;
      }
      if (typeof labels !== 'string' || !g.exists(tmp)) {
        out.push({ expression, ok: false });
        for (const l of (labels || '').split(',')) if (l && g.exists(l)) g.deleteObject(l);
        continue;
      }
      let value: string = g.getValueString(tmp) || '';
      if (value.startsWith(`${tmp} = `)) value = value.slice(tmp.length + 3);
      const type: string = g.getObjectType(tmp);
      const num = g.isDefined(tmp) ? g.getValue(tmp) : null;
      out.push({ expression, ok: true, type, value: g.isDefined(tmp) ? value : 'undefined', number: num });
      g.deleteObject(tmp);
    }
  } finally {
    g.setRepaintingActive(true);
  }
  return out;
}

export type StyleArgs = {
  names: string[];
  color?: [number, number, number];
  visible?: boolean;
  labelVisible?: boolean;
  caption?: string;
  lineThickness?: number;
  lineStyle?: number;
  pointSize?: number;
  filling?: number;
  fixed?: boolean;
};

export function pageSetStyle(a: StyleArgs): { applied: string[]; missing: string[] } {
  const g = window.ggbApplet;
  const applied: string[] = [];
  const missing: string[] = [];
  for (const n of a.names) {
    if (!g.exists(n)) {
      missing.push(n);
      continue;
    }
    if (a.color) g.setColor(n, a.color[0], a.color[1], a.color[2]);
    if (a.visible !== undefined) g.setVisible(n, a.visible);
    if (a.labelVisible !== undefined) g.setLabelVisible(n, a.labelVisible);
    if (a.caption !== undefined) {
      g.setCaption(n, a.caption);
      g.setLabelStyle(n, a.caption ? 3 : 0); // 3 = show caption, 0 = show name
      if (a.caption) g.setLabelVisible(n, true);
    }
    if (a.lineThickness !== undefined) g.setLineThickness(n, a.lineThickness);
    if (a.lineStyle !== undefined) g.setLineStyle(n, a.lineStyle);
    if (a.pointSize !== undefined) g.setPointSize(n, a.pointSize);
    if (a.filling !== undefined) g.setFilling(n, a.filling);
    if (a.fixed !== undefined) g.setFixed(n, a.fixed);
    applied.push(n);
  }
  return { applied, missing };
}

export async function pageFitView(a: { padding: number }): Promise<{ xmin: number; xmax: number; ymin: number; ymax: number } | null> {
  const g = window.ggbApplet;
  const xs: number[] = [];
  const ys: number[] = [];
  g.setRepaintingActive(false);
  try {
    for (const n of (g.getAllObjectNames() || []) as string[]) {
      if (!g.getVisible(n) || !g.isDefined(n)) continue;
      const t = g.getObjectType(n);
      if (t === 'point') {
        xs.push(g.getXcoord(n));
        ys.push(g.getYcoord(n));
      } else if (t === 'circle') {
        // Use temporary helpers to read the circle's center and radius.
        const c = await g.asyncEvalCommandGetLabels(`mcpTmpC = Center(${n})`);
        const r = await g.asyncEvalCommandGetLabels(`mcpTmpR = Radius(${n})`);
        if (c && r && g.isDefined('mcpTmpC') && g.isDefined('mcpTmpR')) {
          const cx = g.getXcoord('mcpTmpC');
          const cy = g.getYcoord('mcpTmpC');
          const rr = g.getValue('mcpTmpR');
          xs.push(cx - rr, cx + rr);
          ys.push(cy - rr, cy + rr);
        }
        if (g.exists('mcpTmpC')) g.deleteObject('mcpTmpC');
        if (g.exists('mcpTmpR')) g.deleteObject('mcpTmpR');
      }
    }
  } finally {
    g.setRepaintingActive(true);
  }
  if (xs.length === 0) return null;
  let xmin = Math.min(...xs);
  let xmax = Math.max(...xs);
  let ymin = Math.min(...ys);
  let ymax = Math.max(...ys);
  const w = Math.max(xmax - xmin, 1);
  const h = Math.max(ymax - ymin, 1);
  xmin -= w * a.padding;
  xmax += w * a.padding;
  ymin -= h * a.padding;
  ymax += h * a.padding;
  // Keep a 1:1 axis ratio, otherwise circles are drawn as ellipses.
  const props = JSON.parse(g.getViewProperties(1) || '{}');
  const pw = props.width || 0;
  const ph = props.height || 0;
  if (pw > 0 && ph > 0) {
    const unit = Math.max((xmax - xmin) / pw, (ymax - ymin) / ph);
    const cx = (xmin + xmax) / 2;
    const cy = (ymin + ymax) / 2;
    xmin = cx - (unit * pw) / 2;
    xmax = cx + (unit * pw) / 2;
    ymin = cy - (unit * ph) / 2;
    ymax = cy + (unit * ph) / 2;
  }
  g.setCoordSystem(xmin, xmax, ymin, ymax);
  return { xmin, xmax, ymin, ymax };
}
