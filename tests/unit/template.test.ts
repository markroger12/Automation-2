import { describe, expect, it } from 'vitest';
import { TemplateSyntaxError, referencedVariables, renderTemplate } from '@/lib/prompts/template';

describe('prompt template engine', () => {
  it('renders variables, arrays and conditionals', () => {
    const t = 'K: "{{keyword}}"\n{{#if example_title}}Ref: "{{example_title}}"{{/if}}\n{{#if secondary_keywords}}S: {{secondary_keywords}}{{/if}}{{#unless secondary_keywords}}none{{/unless}}';
    const r = renderTemplate(t, { keyword: 'Tom Kaulitz Heidi Klum', example_title: 'A love story', secondary_keywords: ['Tokio Hotel', 'Germany’s Next Topmodel'] });
    expect(r.text).toContain('K: "Tom Kaulitz Heidi Klum"');
    expect(r.text).toContain('Ref: "A love story"');
    expect(r.text).toContain('S: Tokio Hotel, Germany’s Next Topmodel');
    expect(r.text).not.toContain('none');
    expect(r.missing).toEqual([]);
  });

  it('reports missing variables and omits empty optional blocks', () => {
    const r = renderTemplate('{{#if example_title}}X {{example_title}}{{/if}}Title: {{selected_title}}', { selected_title: '' });
    expect(r.text).toBe('Title:');
    expect(r.missing).toEqual(['selected_title']);
  });

  it('labels unavailable downstream values in previews', () => {
    const r = renderTemplate('Title: "{{selected_title}}"', {}, { unavailable: { selected_title: 'available after TITLES' } });
    expect(r.text).toContain('⟦selected_title: available after TITLES⟧');
    expect(r.unavailable).toEqual(['selected_title']);
    expect(r.missing).toEqual([]);
  });

  it('neutralises template syntax inside user values', () => {
    const r = renderTemplate('{{keyword}}', { keyword: 'evil {{#if x}}' });
    expect(r.text).toBe('evil { {#if x} }');
  });

  it('supports nesting and rejects malformed templates', () => {
    expect(renderTemplate('{{#if a}}A{{#unless b}}-noB{{/unless}}{{/if}}', { a: 'y' }).text).toBe('A-noB');
    expect(() => renderTemplate('{{#if a}}open', {})).toThrow(TemplateSyntaxError);
    expect(() => renderTemplate('{{/if}}', {})).toThrow(TemplateSyntaxError);
    expect(referencedVariables('{{a}} {{#if b}}{{c}}{{/if}}').sort()).toEqual(['a', 'b', 'c']);
  });
});
