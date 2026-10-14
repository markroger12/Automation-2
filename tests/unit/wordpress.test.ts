import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { htmlForClassic, htmlToBlocks } from '@/wordpress/blocks';
import { fieldsMatch, focusKeywordMatches, parseRankMathScore } from '@/wordpress/rank-math';
import { evaluateCorrection } from '@/lib/seo/correction';
import { htmlToMarkdown } from '@/lib/content/html-to-markdown';
import { markdownToHtml } from '@/lib/content/markdown';

// Modules that import the database client are loaded only after the test database exists.
let client: PrismaClient;
let guard: typeof import('@/wordpress/publish-guard');
let drafts: typeof import('@/wordpress/drafts');
beforeAll(async () => {
  ({ client } = await setupTestDb());
  guard = await import('@/wordpress/publish-guard');
  drafts = await import('@/wordpress/drafts');
});

const SITE = 'https://blog.example';
const rest = (route: string, pretty = false) => (pretty ? `${SITE}/wp-json${route}` : `${SITE}/?rest_route=${encodeURIComponent(route)}`);

describe('publish guard classifier', () => {
  const blocked = (req: import('@/wordpress/publish-guard').OutgoingRequest) => guard.classifyRequest(req).effect;

  it('blocks every publishing state through the REST API, in every request shape', () => {
    for (const status of ['publish', 'future', 'private', 'pending']) {
      expect(blocked({ method: 'POST', url: rest('/wp/v2/posts/5'), body: JSON.stringify({ status }), contentType: 'application/json' })).toBe('status');
      expect(blocked({ method: 'PUT', url: rest('/wp/v2/posts/5', true), body: JSON.stringify({ id: 5, status }), contentType: 'application/json' })).toBe('status');
      expect(blocked({ method: 'POST', url: rest('/wp/v2/posts'), body: JSON.stringify({ title: 'x', status }) })).toBe('status');
      expect(blocked({ method: 'POST', url: `${rest('/wp/v2/posts/5')}&status=${status}`, body: '{}' })).toBe('status');
      expect(blocked({ method: 'POST', url: rest('/wp/v2/pages/9'), body: `status=${status}`, contentType: 'application/x-www-form-urlencoded' })).toBe('status');
      expect(blocked({ method: 'POST', url: rest('/wp/v2/posts/5'), body: JSON.stringify({ status: status.toUpperCase() }), headers: { 'X-HTTP-Method-Override': 'PUT' } })).toBe('status');
    }
    expect(blocked({ method: 'POST', url: rest('/batch/v1'), body: JSON.stringify({ requests: [{ method: 'POST', path: '/wp/v2/posts/5', body: { status: 'publish' } }] }) })).toBe('status');
    expect(blocked({ method: 'DELETE', url: rest('/wp/v2/posts/5') })).toBe('delete');
    expect(blocked({ method: 'POST', url: rest('/wp/v2/posts/5'), headers: { 'x-http-method-override': 'DELETE' } })).toBe('delete');
    expect(blocked({ method: 'POST', url: `${SITE}/?rest_route=/wp/v2/posts/5?force=true`, headers: { 'x-http-method-override': 'DELETE' } })).toBe('delete');
  });

  it('blocks the Classic editor Publish/Schedule button, pending/private saves, Quick Edit, bulk edit and XML-RPC', () => {
    expect(blocked({ method: 'POST', url: `${SITE}/wp-admin/post.php`, body: 'action=editpost&post_ID=5&post_status=draft&original_publish=Publish&publish=Publish' })).toBe('status');
    expect(blocked({ method: 'POST', url: `${SITE}/wp-admin/post.php`, body: 'action=editpost&post_ID=5&post_status=pending&save=Save' })).toBe('status');
    expect(blocked({ method: 'POST', url: `${SITE}/wp-admin/post.php`, body: 'action=editpost&post_ID=5&post_status=draft&visibility=private&save=Save' })).toBe('status');
    expect(blocked({ method: 'POST', url: `${SITE}/wp-admin/admin-ajax.php`, body: 'action=inline-save&post_ID=5&_status=publish' })).toBe('status');
    expect(blocked({ method: 'GET', url: `${SITE}/wp-admin/edit.php?action=edit&_status=publish&bulk_edit=Update&post[]=5` })).toBe('status');
    expect(blocked({ method: 'GET', url: `${SITE}/wp-admin/post.php?post=5&action=delete&_wpnonce=x` })).toBe('delete');
    expect(blocked({ method: 'GET', url: `${SITE}/wp-admin/post.php?post=5&action=trash&_wpnonce=x` })).toBe('delete');
    expect(blocked({ method: 'POST', url: `${SITE}/xmlrpc.php`, body: '<methodCall><methodName>wp.editPost</methodName></methodCall>' })).toBe('xmlrpc');
  });

  it('lets drafts, autosaves, metadata, users/me preferences and reads through', () => {
    expect(blocked({ method: 'POST', url: rest('/wp/v2/posts/5'), body: JSON.stringify({ id: 5, title: 'x', content: '', status: 'draft' }) })).toBeNull();
    expect(blocked({ method: 'POST', url: rest('/wp/v2/posts/5/autosaves'), body: JSON.stringify({ content: 'x' }) })).toBeNull();
    expect(blocked({ method: 'POST', url: rest('/wp/v2/users/me'), body: JSON.stringify({ meta: {} }) })).toBeNull();
    expect(blocked({ method: 'POST', url: rest('/wp/v2/tags'), body: JSON.stringify({ name: 'x' }) })).toBeNull();
    expect(blocked({ method: 'POST', url: rest('/rankmath/v1/updateMeta'), body: JSON.stringify({ objectID: 5, meta: {} }) })).toBeNull();
    expect(blocked({ method: 'GET', url: `${rest('/wp/v2/posts')}&status=publish` })).toBeNull();
    expect(blocked({ method: 'POST', url: `${SITE}/wp-admin/post.php`, body: 'action=editpost&post_ID=5&post_status=draft&original_publish=Publish&save=Save+Draft' })).toBeNull();
    expect(guard.restRouteOf(new URL(`${SITE}/index.php?rest_route=%2Fwp%2Fv2%2Fposts%2F6&_locale=user`))).toBe('/wp/v2/posts/6');
  });
});

describe('publish permits', () => {
  it('a permit is only granted when the site allows publishing, and only for one post', async () => {
    const { decide } = guard;
    const site = await client.website.create({ data: { name: 'S', slug: 's-permit', publicUrl: 'https://s.example/', adminUrl: 'https://s.example/wp-admin/' } });
    const publish = { method: 'POST', url: rest('/wp/v2/posts/5'), body: JSON.stringify({ status: 'future' }) };
    await expect(guard.withPublishPermit(site.id, 5, 'test', async () => 1)).rejects.toBeInstanceOf(guard.PublishNotAllowedError);
    await client.website.update({ where: { id: site.id }, data: { canPublish: true } });
    // canPublish without the typed acknowledgement is still not enough.
    await expect(guard.withPublishPermit(site.id, 5, 'test', async () => 1)).rejects.toBeInstanceOf(guard.PublishNotAllowedError);
    await client.website.update({ where: { id: site.id }, data: { canPublishAcknowledgedAt: new Date() } });
    await guard.withPublishPermit(site.id, 5, 'scheduler', async () => {
      expect(decide(site.id, publish).allowed).toBe(true);
      expect(decide(site.id, { ...publish, url: rest('/wp/v2/posts/6') }).allowed).toBe(false);
      expect(decide(site.id, { method: 'DELETE', url: rest('/wp/v2/posts/5') }).allowed).toBe(false);
    });
    expect(decide(site.id, publish).allowed).toBe(false);
    expect(await client.auditLog.count({ where: { action: 'publish.permit' } })).toBe(1);
    // The owner's visible window may publish by hand on this site — but the app's own requests still may not.
    await guard.withOwnerWindowPermit(site.id, async () => {
      expect(decide(site.id, publish, 'network').allowed).toBe(true);
      expect(decide(site.id, publish, 'service').allowed).toBe(false);
      expect(decide(site.id, { method: 'DELETE', url: rest('/wp/v2/posts/5') }, 'network').allowed).toBe(false);
    });
    expect(decide(site.id, publish, 'network').allowed).toBe(false);
    // Without permission the owner window gets no permit at all.
    await client.website.update({ where: { id: site.id }, data: { canPublish: false } });
    const r = await guard.withOwnerWindowPermit(site.id, async () => decide(site.id, publish, 'network').allowed);
    expect(r).toEqual({ result: false, publishingAllowed: false });
  });
});

describe('only the WordPress client sends requests to WordPress', () => {
  it('no other source file uses Playwright request APIs, and nothing asks WordPress to publish', () => {
    const root = path.resolve(__dirname, '..', '..', 'src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    const offenders = files.filter((f) => !f.endsWith(path.join('wordpress', 'client.ts')) && /\.request\.(fetch|post|put|patch|delete|get)\(|context\.request\b/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    const publishers = files.filter((f) => !f.endsWith(path.join('wordpress', 'publish-guard.ts')) && /status:\s*['"](publish|future|private|pending)['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(publishers).toEqual([]);
  });
});

describe('Gutenberg block serialization', () => {
  it('converts article HTML into core blocks (validated against WordPress 6.5 and 6.7 in tests/e2e)', () => {
    const html = '<p>Intro <strong>bold</strong> <a href="https://x.example/?a=1&amp;b=2">link</a>.</p><h2>Section</h2><h3>Sub</h3><ul><li>a<ul><li>b</li></ul></li></ul><ol><li>one</li></ol><table class="bas-quick-bio"><thead><tr><th>Attribute</th><th>Details</th></tr></thead><tbody><tr><td>Name</td><td>X</td></tr></tbody></table><blockquote><p>q</p></blockquote><p data-bas-internal-link="1"><strong>Also read:</strong> <a href="https://x.example/y">Y</a></p>';
    const b = htmlToBlocks(html);
    expect(b).toContain('<!-- wp:paragraph -->\n<p>Intro <strong>bold</strong>');
    expect(b).toContain('<!-- wp:heading -->\n<h2 class="wp-block-heading">Section</h2>');
    expect(b).toContain('<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">Sub</h3>');
    expect(b).toContain('<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li>a<!-- wp:list -->');
    expect(b).toContain('<!-- wp:list {"ordered":true} -->');
    expect(b).toContain('<!-- wp:table {"hasFixedLayout":false,"className":"bas-quick-bio"} -->\n<figure class="wp-block-table bas-quick-bio"><table><thead>');
    expect(b).toContain('<!-- wp:html -->\n<blockquote>');
    expect(b).not.toContain('data-bas-internal-link');
    expect(b.match(/<!-- wp:/g)!.length).toBe(b.match(/<!-- \/wp:/g)!.length);
  });

  it('Classic editor HTML has no block comments and no line breaks inside elements', () => {
    const c = htmlForClassic('<p>a\nb</p>\n<table>\n<tr>\n<td>x</td>\n</tr>\n</table>');
    expect(c).not.toContain('<!--');
    expect(c).toBe('<p>a b</p>\n\n<table> <tbody><tr> <td>x</td> </tr> </tbody></table>');
  });

  it('compares stored and sent content by words, headings and links', () => {
    const { sameArticle, contentHash } = drafts;
    const a = htmlToBlocks('<p>Hello world</p><h2>Head</h2><p><a href="https://x.example">x</a></p>');
    expect(sameArticle(a, htmlForClassic('<p>Hello world</p><h2>Head</h2><p><a href="https://x.example">x</a></p>'))).toBe(true);
    expect(sameArticle(a, htmlForClassic('<p>Hello there</p><h2>Head</h2>'))).toBe(false);
    expect(contentHash('<p>a</p>\n\n<p>b</p>')).toBe(contentHash('<p>a</p> <p>b</p>'));
  });
});

describe('Rank Math parsing (read, never computed)', () => {
  it('parses score texts and refuses anything that is not a score', () => {
    expect(parseRankMathScore('82 / 100')).toBe(82);
    expect(parseRankMathScore(' 75/100 ')).toBe(75);
    expect(parseRankMathScore('SEO: 64')).toBe(64);
    expect(parseRankMathScore('100')).toBe(100);
    expect(parseRankMathScore('N/A')).toBeNull();
    expect(parseRankMathScore('')).toBeNull();
    expect(parseRankMathScore('…')).toBeNull();
    expect(parseRankMathScore('250')).toBeNull();
  });

  it('a score shown beside the focus keyword is not taken as keyword text', () => {
    expect(focusKeywordMatches('Tom Kaulitz', 'tom kaulitz 82')).toBe(true);
    expect(focusKeywordMatches('Tom Kaulitz', 'Tom Kaulitz82/100')).toBe(true);
    expect(focusKeywordMatches('Tom Kaulitz', 'Tom Kaulitz, Heidi Klum')).toBe(true);
    expect(focusKeywordMatches('iPhone 15', 'iphone 15')).toBe(true);
    expect(focusKeywordMatches('iPhone 15', 'iphone 15 77')).toBe(true);
    expect(focusKeywordMatches('iPhone 15', 'iphone')).toBe(false);
    expect(focusKeywordMatches('Tom Kaulitz', 'Tom Kaulitz wife')).toBe(false);
    expect(fieldsMatch({ focusKeyword: 'a b', title: 'T', description: 'D' }, { focusKeyword: 'a b 90', title: 'T', description: 'D' }).ok).toBe(true);
    expect(fieldsMatch({ focusKeyword: 'a b', title: 'T', description: 'D' }, { focusKeyword: 'a b', title: 'Other', description: 'D' }).problems).toHaveLength(1);
  });
});

describe('SEO correction guard', () => {
  const before = markdownToHtml(`Tom Kaulitz is a musician. ${'He has toured widely and recorded many albums with his band. '.repeat(12)}\n\n## Early Life\n\n${'He grew up in Leipzig and started playing guitar early. '.repeat(10)} See [source](https://example.com/a).\n\n## Career\n\n${'The band became successful across Europe and beyond. '.repeat(10)}`);
  const opts = { keyword: 'Tom Kaulitz', language: 'en', densityCeilingPct: 2.5 };

  it('accepts a fact-preserving revision that adds the keyword to a heading', () => {
    expect(evaluateCorrection(before, before.replace('<h2>Career</h2>', '<h2>Tom Kaulitz: Career</h2>'), opts).accepted).toBe(true);
  });

  it('rejects rewrites that grow >15 %, shrink >30 %, drop headings/links or stuff the keyword', () => {
    expect(evaluateCorrection(before, before + `<p>${'Extra words that were not there before at all. '.repeat(30)}</p>`, opts).reasons.join()).toMatch(/adds/);
    expect(evaluateCorrection(before, before.slice(0, Math.floor(before.length / 3)) + '</p>', opts).reasons.join()).toMatch(/removes|loses/);
    expect(evaluateCorrection(before, before.replace('<h2>Early Life</h2>', ''), opts).reasons.join()).toMatch(/heading/);
    expect(evaluateCorrection(before, before.replace(/<a [^>]+>source<\/a>/, 'source'), opts).reasons.join()).toMatch(/link/);
    expect(evaluateCorrection(before, before.replace(/He grew up/g, 'Tom Kaulitz grew up').replace(/The band/g, 'Tom Kaulitz'), opts).reasons.join()).toMatch(/density/);
  });
});

describe('HTML → Markdown for correction prompts', () => {
  it('round-trips headings, emphasis, links, lists and tables', () => {
    const html = '<p>Intro with <strong>bold</strong>, <em>italic</em> and <a href="https://x.example/a">a link</a>.</p><h2>Head</h2><ul><li>one</li><li>two</li></ul><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('## Head');
    expect(md).toContain('[a link](https://x.example/a)');
    expect(md).toContain('| A | B |');
    const back = markdownToHtml(md);
    expect(back).toContain('<h2>Head</h2>');
    expect(back).toContain('<strong>bold</strong>');
    expect(back).toContain('<a href="https://x.example/a" rel="noopener">a link</a>');
    expect(back).toContain('<td>2</td>');
  });
});
