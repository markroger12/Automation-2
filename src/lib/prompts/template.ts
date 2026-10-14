/**
 * Minimal deterministic prompt template engine (client-safe).
 *
 *   {{var}}                         value (arrays joined with ", ")
 *   {{#if var}}…{{/if}}             rendered when var is non-empty
 *   {{#unless var}}…{{/unless}}     rendered when var is empty
 *
 * Values are inserted verbatim (prompts are plain text), except that "{{" and
 * "}}" inside values are neutralised so user input can never inject template
 * syntax. Unresolved variables are reported so callers can refuse to send a
 * prompt with missing required data.
 */

export type TemplateValue = string | number | boolean | null | undefined | readonly string[];
export type TemplateVars = Record<string, TemplateValue>;

export interface RenderOptions {
  /** Preview mode: label these variables as "available after <stage>" instead of failing. */
  unavailable?: Record<string, string>;
}

export interface RenderResult {
  text: string;
  /** Variables referenced by {{var}} that had no value. */
  missing: string[];
  /** Variables rendered as "unavailable" placeholders (preview only). */
  unavailable: string[];
  /** All variable names referenced by the template. */
  referenced: string[];
}

type BlockNode = { type: 'if' | 'unless'; name: string; children: Node[] };
type Node = { type: 'text'; value: string } | { type: 'var'; name: string } | BlockNode;

const TOKEN_RE = /\{\{\s*(#if|#unless|\/if|\/unless)?\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\}\}/g;

export class TemplateSyntaxError extends Error {}

export function parseTemplate(template: string): Node[] {
  const root: Node[] = [];
  const stack: { node: BlockNode; tag: 'if' | 'unless' }[] = [];
  const current = () => (stack.length ? stack[stack.length - 1].node.children : root);
  let last = 0;
  for (const match of template.matchAll(TOKEN_RE)) {
    const [full, directive, name] = match;
    const index = match.index ?? 0;
    if (index > last) current().push({ type: 'text', value: template.slice(last, index) });
    last = index + full.length;
    if (!directive) {
      if (!name) throw new TemplateSyntaxError(`Empty placeholder at position ${index}`);
      current().push({ type: 'var', name });
    } else if (directive === '#if' || directive === '#unless') {
      if (!name) throw new TemplateSyntaxError(`${directive} needs a variable name at position ${index}`);
      const tag = directive === '#if' ? 'if' : 'unless';
      const node: BlockNode = { type: tag, name, children: [] };
      current().push(node);
      stack.push({ node, tag });
    } else {
      const tag = directive === '/if' ? 'if' : 'unless';
      const open = stack.pop();
      if (!open || open.tag !== tag) throw new TemplateSyntaxError(`Unexpected {{${directive}}} at position ${index}`);
    }
  }
  if (last < template.length) current().push({ type: 'text', value: template.slice(last) });
  if (stack.length) throw new TemplateSyntaxError(`Unclosed {{#${stack[stack.length - 1].tag} ${stack[stack.length - 1].node.name}}}`);
  return root;
}

export function isEmptyValue(value: TemplateValue): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

export function formatValue(value: TemplateValue): string {
  if (value === null || value === undefined || value === false) return '';
  const raw = Array.isArray(value) ? value.join(', ') : String(value);
  return raw.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

export function renderTemplate(template: string, vars: TemplateVars, options: RenderOptions = {}): RenderResult {
  const nodes = parseTemplate(template);
  const missing = new Set<string>();
  const unavailable = new Set<string>();
  const referenced = new Set<string>();
  const walk = (list: Node[]): string =>
    list
      .map((node) => {
        if (node.type === 'text') return node.value;
        referenced.add(node.name);
        const value = vars[node.name];
        const placeholder = options.unavailable?.[node.name];
        if (node.type === 'var') {
          if (placeholder !== undefined && isEmptyValue(value)) {
            unavailable.add(node.name);
            return `⟦${node.name}: ${placeholder}⟧`;
          }
          if (isEmptyValue(value) && value !== false) missing.add(node.name);
          return formatValue(value);
        }
        const empty = isEmptyValue(value) && placeholder === undefined;
        const show = node.type === 'if' ? !empty : empty;
        return show ? walk(node.children) : '';
      })
      .join('');
  const text = walk(nodes)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, missing: [...missing], unavailable: [...unavailable], referenced: [...referenced] };
}

export function referencedVariables(template: string): string[] {
  const names = new Set<string>();
  const visit = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === 'var') names.add(n.name);
      else if (n.type !== 'text') {
        names.add(n.name);
        visit(n.children);
      }
    }
  };
  visit(parseTemplate(template));
  return [...names];
}
