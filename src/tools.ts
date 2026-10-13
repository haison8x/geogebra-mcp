// MCP tool definitions. Each handler runs through GeoGebraSession, which serializes page
// access and records undo history for the tools that change the figure.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { diagnose } from './diagnose.js';
import {
  pageEvaluate,
  pageFitView,
  pageGetState,
  pageRunCommands,
  pageSetStyle,
  type StyleArgs,
} from './page.js';
import { KNOWN_COMMANDS } from './rules.js';
import type { GeoGebraSession } from './session.js';

const LINE_STYLES = { solid: 0, dashed: 1, 'dashed-short': 2, dotted: 3, 'dash-dot': 4 } as const;

export function registerTools(server: McpServer, session: GeoGebraSession): void {
  const reply = (data: unknown): CallToolResult => {
    const notice = session.takeNotice();
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return { content: [{ type: 'text', text: notice ? `NOTICE: ${notice}\n\n${text}` : text }] };
  };
  const fail = (e: unknown): CallToolResult => ({
    isError: true,
    content: [{ type: 'text', text: `Error: ${String((e as Error)?.message ?? e)}` }],
  });
  const guard =
    <A>(fn: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await fn(args);
      } catch (e) {
        return fail(e);
      }
    };

  server.registerTool(
    'ggb_run_commands',
    {
      title: 'Run GeoGebra commands',
      description:
        'Run GeoGebra commands on the live figure, in order (English command names, e.g. "A = (-1, 6)", "M = Midpoint(B, C)", ' +
        '"ShowLabel(a, false)", "SetVisibleInView(h, 1, false)", "Delete(P)"). Assigning to an existing name REDEFINES that object and ' +
        'its dependents update. Returns, per command: ok, created/removed objects, warnings (undefined objects, names not created) and, ' +
        'for failures, hints about the likely cause.',
      inputSchema: {
        commands: z.array(z.string().min(1)).min(1).max(300).describe('Commands to run, one per item, in execution order'),
        stop_on_error: z
          .boolean()
          .default(true)
          .describe('Stop at the first failed command (later commands usually depend on it). Default true.'),
      },
    },
    guard(async ({ commands, stop_on_error }) => {
      const out = await session.mutate((page) => page.evaluate(pageRunCommands, { commands, stopOnError: stop_on_error }));
      const failed = out.results.filter((r) => !r.ok);
      const results = out.results.map((r) => {
        const item: Record<string, unknown> = { i: r.index, command: r.command, ok: r.ok };
        if (r.created.length) item.created = r.created;
        if (r.ok && !r.created.length && r.labels.length) item.updated = r.labels.filter((l) => l !== 'undefined');
        if (r.warnings.length) item.warnings = r.warnings;
        if (!r.ok) item.hints = r.error ? [r.error] : diagnose(r.command, out.objectNames, KNOWN_COMMANDS);
        return item;
      });
      const summary =
        `${out.results.length - failed.length}/${commands.length} commands succeeded` +
        (failed.length ? `, ${failed.length} failed` : '') +
        (out.stoppedAt !== null && out.stoppedAt < commands.length - 1
          ? `; stopped at #${out.stoppedAt}, the ${commands.length - out.stoppedAt - 1} commands after it were NOT run`
          : '');
      return reply({ summary, results });
    }),
  );

  server.registerTool(
    'ggb_get_state',
    {
      title: 'Read the figure',
      description:
        'List the objects currently in the figure: name, type, definition, value, point coordinates, visibility, ' +
        'dependsOn (parents) and usedBy (objects that would change or be deleted with it). Always call this before fixing a figure: ' +
        'the user may have edited it by hand.',
      inputSchema: {
        include_hidden: z.boolean().default(true).describe('Include hidden helper objects. Default true.'),
        names: z.array(z.string()).optional().describe('Only return these objects'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ include_hidden, names }) => {
      let objects = await session.run((page) => page.evaluate(pageGetState));
      if (!include_hidden) objects = objects.filter((o) => o.visible);
      if (names?.length) objects = objects.filter((o) => names.includes(o.name));
      const compact = objects.map((o) => {
        const item: Record<string, unknown> = { name: o.name, type: o.type };
        if (o.definition) item.definition = o.definition;
        else item.free = true;
        item.value = o.value;
        if (o.coords) item.coords = o.coords;
        if (!o.defined) item.defined = false;
        if (!o.visible) item.visible = false;
        if (o.labelVisible) item.label = true;
        if (o.caption) item.caption = o.caption;
        if (o.dependsOn.length) item.dependsOn = o.dependsOn;
        if (o.usedBy.length) item.usedBy = o.usedBy;
        return item;
      });
      return reply({ count: compact.length, objects: compact });
    }),
  );

  server.registerTool(
    'ggb_screenshot',
    {
      title: 'Screenshot the figure',
      description:
        'Return a PNG image of the drawing area so you can check the figure visually (overlapping labels, figure off-screen, ' +
        'wrong shape). Set full_window to capture the whole GeoGebra window including the algebra panel.',
      inputSchema: {
        full_window: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ full_window }) => {
      const data = await session.run(async (page) => {
        if (full_window) return (await page.screenshot({ type: 'png' })).toString('base64');
        return page.evaluate(() => window.ggbApplet.getPNGBase64(1, false, 72) as string);
      });
      const notice = session.takeNotice();
      const content: CallToolResult['content'] = [{ type: 'image', data, mimeType: 'image/png' }];
      if (notice) content.unshift({ type: 'text', text: `NOTICE: ${notice}` });
      return { content };
    }),
  );

  server.registerTool(
    'ggb_evaluate',
    {
      title: 'Evaluate expressions',
      description:
        'Evaluate GeoGebra expressions against the current figure WITHOUT adding objects, to verify the construction. ' +
        'Examples: "Angle(B, A, C)", "Distance(B, M) == Distance(M, C)", "AreCollinear(A, H, O)", "AreParallel(Line(A, D), Line(B, C))", ' +
        '"Radius(omega)", "Area(poly1)".',
      inputSchema: {
        expressions: z.array(z.string().min(1)).min(1).max(50),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ expressions }) => {
      const results = await session.run((page) => page.evaluate(pageEvaluate, expressions));
      return reply(
        results.map((r) =>
          r.ok
            ? { expression: r.expression, type: r.type, value: r.value }
            : { expression: r.expression, ok: false, hint: 'GeoGebra could not evaluate this expression' },
        ),
      );
    }),
  );

  server.registerTool(
    'ggb_set_style',
    {
      title: 'Style objects',
      description: 'Change how objects look: color, visibility, label, caption (text shown instead of the name), thickness, line style, point size, fill, fixed.',
      inputSchema: {
        names: z.array(z.string()).min(1),
        color: z
          .string()
          .regex(/^#?[0-9a-fA-F]{6}$/)
          .optional()
          .describe('Hex color, e.g. "#d32f2f"'),
        visible: z.boolean().optional(),
        label_visible: z.boolean().optional(),
        caption: z.string().optional().describe('Text shown as the label; empty string restores the name'),
        line_thickness: z.number().int().min(1).max(13).optional(),
        line_style: z.enum(['solid', 'dashed', 'dashed-short', 'dotted', 'dash-dot']).optional(),
        point_size: z.number().int().min(1).max(9).optional(),
        filling: z.number().min(0).max(1).optional().describe('Fill opacity 0..1 for polygons and circles'),
        fixed: z.boolean().optional().describe('Prevent the user from dragging the object'),
      },
    },
    guard(async (a) => {
      const hex = a.color?.replace('#', '');
      const style: StyleArgs = {
        names: a.names,
        color: hex ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] : undefined,
        visible: a.visible,
        labelVisible: a.label_visible,
        caption: a.caption,
        lineThickness: a.line_thickness,
        lineStyle: a.line_style !== undefined ? LINE_STYLES[a.line_style] : undefined,
        pointSize: a.point_size,
        filling: a.filling,
        fixed: a.fixed,
      };
      const res = await session.mutate((page) => page.evaluate(pageSetStyle, style));
      return reply(res);
    }),
  );

  server.registerTool(
    'ggb_delete',
    {
      title: 'Delete objects',
      description:
        'Delete objects. WARNING: everything that depends on them is deleted too (see usedBy in ggb_get_state). ' +
        'To change an object, redefine it with ggb_run_commands instead.',
      inputSchema: { names: z.array(z.string()).min(1) },
      annotations: { destructiveHint: true },
    },
    guard(async ({ names }) => {
      const res = await session.mutate((page) =>
        page.evaluate((list) => {
          const g = window.ggbApplet;
          const before: string[] = g.getAllObjectNames();
          const missing = list.filter((n) => !g.exists(n));
          for (const n of list) if (g.exists(n)) g.deleteObject(n);
          const after = new Set<string>(g.getAllObjectNames());
          return { removed: before.filter((n) => !after.has(n)), missing };
        }, names),
      );
      return reply(res);
    }),
  );

  server.registerTool(
    'ggb_clear',
    {
      title: 'Clear the figure',
      description: 'Remove every object to start a new figure (can be reverted with ggb_undo).',
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    guard(async () => {
      await session.mutate((page) => page.evaluate(() => window.ggbApplet.newConstruction()));
      return reply('Figure cleared.');
    }),
  );

  server.registerTool(
    'ggb_undo',
    {
      title: 'Undo',
      description: 'Revert the last change(s) made through this server (run_commands, set_style, delete, clear, snapshot restore).',
      inputSchema: { steps: z.number().int().min(1).max(50).default(1) },
    },
    guard(async ({ steps }) => {
      const done = await session.undo(steps);
      return reply(done === 0 ? 'Nothing to undo.' : `Reverted ${done} change(s).`);
    }),
  );

  server.registerTool(
    'ggb_snapshot',
    {
      title: 'Save / restore a version',
      description: 'Save the current figure under a name, restore a saved one, or list saved names. Snapshots live while the server runs.',
      inputSchema: {
        action: z.enum(['save', 'restore', 'list']),
        name: z.string().min(1).optional(),
      },
    },
    guard(async ({ action, name }) => {
      if (action === 'list') return reply({ snapshots: session.listSnapshots() });
      if (!name) return fail('name is required for save/restore');
      if (action === 'save') {
        await session.saveSnapshot(name);
        return reply(`Saved snapshot '${name}'.`);
      }
      const ok = await session.restoreSnapshot(name);
      return ok ? reply(`Restored snapshot '${name}'.`) : fail(`No snapshot named '${name}'. Saved: ${session.listSnapshots().join(', ') || '(none)'}`);
    }),
  );

  server.registerTool(
    'ggb_fit_view',
    {
      title: 'Fit the view',
      description: 'Zoom/pan so every visible point and circle fits in the drawing area (1:1 axis ratio). Optionally show/hide axes and grid.',
      inputSchema: {
        padding: z.number().min(0).max(1).default(0.12).describe('Margin as a fraction of the figure size'),
        show_axes: z.boolean().optional(),
        show_grid: z.boolean().optional(),
      },
    },
    guard(async ({ padding, show_axes, show_grid }) => {
      const res = await session.run(async (page) => {
        await page.evaluate(
          ({ axes, grid }) => {
            const g = window.ggbApplet;
            if (axes !== undefined) g.setAxesVisible(axes, axes);
            if (grid !== undefined) g.setGridVisible(grid);
          },
          { axes: show_axes, grid: show_grid },
        );
        return page.evaluate(pageFitView, { padding });
      });
      return reply(res ? { view: res } : 'No visible points or circles to fit.');
    }),
  );

  server.registerTool(
    'ggb_export',
    {
      title: 'Export the figure',
      description: 'Save the figure to a local file: "ggb" (GeoGebra file, can be opened again in GeoGebra) or "png" (image).',
      inputSchema: {
        format: z.enum(['ggb', 'png']),
        path: z.string().min(1).describe('Destination file path on this computer'),
      },
    },
    guard(async ({ format, path }) => {
      const base64 = await session.run((page) =>
        format === 'png'
          ? page.evaluate(() => window.ggbApplet.getPNGBase64(2, false, 144) as string)
          : page.evaluate(() => new Promise<string>((res) => window.ggbApplet.getBase64((b: string) => res(b)))),
      );
      const file = resolve(path);
      writeFileSync(file, Buffer.from(base64, 'base64'));
      return reply(`Saved ${format.toUpperCase()} to ${file}`);
    }),
  );
}
