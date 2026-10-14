import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from '@/lib/links/net';
import { identifiesSubject, linkPolicy, pageFacts, parseLinkCandidates, siteKey } from '@/lib/links/verify';
import { placeLinks } from '@/lib/links/place';
import { chooseLineTarget, findAnchor, rankTargets, type TargetLike } from '@/lib/links/internal';

describe('SSRF address checks', () => {
  it('blocks private, loopback, link-local, CGNAT, multicast and reserved addresses (IPv4 and IPv6)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', 'not-an-ip']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isBlockedAddress(ip), ip).toBe(false);
  });
});

describe('external link policy', () => {
  it('refuses social media, shops, shorteners, net-worth aggregators, gossip and odd URLs', () => {
    expect(linkPolicy('https://www.instagram.com/heidiklum/', 'en').reason).toMatch(/social media/);
    expect(linkPolicy('https://x.com/someone', 'en').reason).toMatch(/social media/);
    expect(linkPolicy('https://www.amazon.de/dp/123', 'de').reason).toMatch(/shop/);
    expect(linkPolicy('https://bit.ly/abc', 'en').reason).toMatch(/shortener/);
    expect(linkPolicy('https://www.celebritynetworth.com/richest/x/', 'en').reason).toMatch(/net-worth/);
    expect(linkPolicy('https://www.tmz.com/2020/x', 'en').reason).toMatch(/gossip/);
    expect(linkPolicy('ftp://example.com/x', 'en').ok).toBe(false);
    expect(linkPolicy('https://user:pw@example.com/', 'en').ok).toBe(false);
    expect(linkPolicy('https://example.com/setup.exe', 'en').reason).toMatch(/download/);
  });

  it('prefers official/educational sources and requires Wikipedia in the article language', () => {
    expect(linkPolicy('https://www.nasa.gov/x', 'en')).toMatchObject({ ok: true, kind: 'edu-gov' });
    expect(linkPolicy('https://www.uni-heidelberg.de/x', 'de')).toMatchObject({ ok: true, kind: 'edu-gov' });
    expect(linkPolicy('https://www.imdb.com/name/nm1/', 'en')).toMatchObject({ ok: true, kind: 'imdb' });
    expect(linkPolicy('https://en.wikipedia.org/wiki/Tokio_Hotel', 'en')).toMatchObject({ ok: true, kind: 'wikipedia' });
    expect(linkPolicy('https://en.wikipedia.org/wiki/Tokio_Hotel', 'de').reason).toMatch(/another language/);
    expect(linkPolicy('https://de.wikipedia.org/wiki/Tokio_Hotel', 'de').ok).toBe(true);
    expect(linkPolicy('https://www.tagesschau.de/x', 'de').kind).toBe('news');
    expect(linkPolicy('https://www.nasa.gov/x', 'en').priority).toBeGreaterThan(linkPolicy('https://en.wikipedia.org/wiki/X', 'en').priority);
    expect(siteKey('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteKey('www.example.com')).toBe('example.com');
  });

  it('parses LINK lines in the formats ChatGPT actually uses', () => {
    const text = `Here are the links:\n1. LINK: Tokio Hotel | https://de.wikipedia.org/wiki/Tokio_Hotel\n- **LINK:** "Heidi Klum" | <https://www.imdb.com/name/nm0000456/>\nLINK: Germany's Next Topmodel | https://www.prosieben.de/tv/germanys-next-topmodel).\nnonsense line\nLINK: Tokio Hotel | https://de.wikipedia.org/wiki/Tokio_Hotel`;
    expect(parseLinkCandidates(text)).toEqual([
      { phrase: 'Tokio Hotel', url: 'https://de.wikipedia.org/wiki/Tokio_Hotel' },
      { phrase: 'Heidi Klum', url: 'https://www.imdb.com/name/nm0000456/' },
      { phrase: "Germany's Next Topmodel", url: 'https://www.prosieben.de/tv/germanys-next-topmodel' },
    ]);
  });

  it('detects disambiguation pages, soft 404s and pages about a different subject', () => {
    const disamb = pageFacts('<html><head><title>Mercury - Wikipedia</title></head><body><h1>Mercury</h1><p>Mercury may refer to:</p></body></html>');
    expect(disamb.disambiguation).toBe(true);
    expect(pageFacts('<html><head><title>Merkur – Wikipedia</title></head><body><p>Merkur steht für:</p></body></html>').disambiguation).toBe(true);
    expect(pageFacts('<html><head><title>Page not found | Site</title></head><body></body></html>').soft404).toBe(true);
    const page = pageFacts('<html><head><title>Tokio Hotel – Wikipedia</title></head><body><h1>Tokio Hotel</h1><p>Tokio Hotel ist eine Band.</p></body></html>');
    expect(identifiesSubject('Tokio Hotel', page, 'wikipedia').ok).toBe(true);
    expect(identifiesSubject('Heidi Klum', page, 'wikipedia').ok).toBe(false);
    const official = pageFacts('<html><head><title>Home</title></head><body><p>Welcome to the official website of the Leipzig Zoo, open daily.</p></body></html>');
    expect(identifiesSubject('Leipzig Zoo', official, 'other').ok).toBe(true);
  });
});

describe('link placement', () => {
  const body = '<p>Tom Kaulitz plays in Tokio Hotel with his brother.</p><h2>Tokio Hotel and Heidi Klum</h2><p>Heidi Klum met <a href="https://a.example">him</a> and <a href="https://b.example">them</a> through Tokio Hotel.</p><p>Later, Tokio Hotel toured. Heidi Klum hosted shows &lt;live&gt;.</p><ul><li>Germany’s Next Topmodel aired on ProSieben.</li></ul>';

  it('links exact body text only, never headings or the focus keyword, max two per paragraph, each phrase once', () => {
    const r = placeLinks(
      body,
      [
        { anchor: 'Tokio Hotel', url: 'https://de.wikipedia.org/wiki/Tokio_Hotel', kind: 'ext' },
        { anchor: 'Heidi Klum', url: 'https://www.imdb.com/name/nm1/', kind: 'ext' },
        { anchor: 'Tokio Hotel', url: 'https://other.example/', kind: 'ext' },
        { anchor: 'Tom Kaulitz', url: 'https://x.example/', kind: 'ext' },
        { anchor: 'ProSieben', url: 'https://www.prosieben.de/', kind: 'ext' },
        { anchor: 'Nirvana', url: 'https://n.example/', kind: 'ext' },
      ],
      { keyword: 'Tom Kaulitz' },
    );
    expect(r.placed.map((p) => p.anchor)).toEqual(['Tokio Hotel', 'Heidi Klum', 'ProSieben']);
    // The first Tokio Hotel is in paragraph 1; Heidi Klum skips the full paragraph 2 (two links) and uses the later mention.
    expect(r.html).toContain('<p>Tom Kaulitz plays in <a href="https://de.wikipedia.org/wiki/Tokio_Hotel" data-bas-link="ext" rel="noopener">Tokio Hotel</a> with his brother.</p>');
    expect(r.html).toContain('<h2>Tokio Hotel and Heidi Klum</h2>');
    expect(r.html).toContain('<a href="https://www.imdb.com/name/nm1/" data-bas-link="ext" rel="noopener">Heidi Klum</a> hosted shows &lt;live&gt;.');
    expect(r.skipped.find((s) => s.url === 'https://other.example/')!.reason).toMatch(/already linked/);
    expect(r.skipped.find((s) => s.anchor === 'Tom Kaulitz')!.reason).toMatch(/focus keyword/);
    expect(r.skipped.find((s) => s.anchor === 'Nirvana')!.reason).toMatch(/not found/);
  });
});

describe('internal link selection', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const t = (id: number, title: string, extra: Partial<TargetLike> = {}): TargetLike => ({ id: `t${id}`, wpPostId: id, url: `https://site.example/?p=${id}`, title, slug: title.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-'), categoryIds: [3], keyword: null, excerpt: null, publishedAt: new Date('2026-01-01T00:00:00Z'), ...extra });

  it('prefers the same topic over recency, avoids self-links, falls back to previous then latest', () => {
    const targets = [
      t(1, 'Heidi Klum: Her Modeling Career', { publishedAt: new Date('2025-01-01T00:00:00Z') }),
      t(2, 'Best Pasta Recipes', { publishedAt: new Date('2026-10-13T00:00:00Z') }),
      t(3, 'Tom Kaulitz Heidi Klum wedding', { keyword: 'Tom Kaulitz Heidi Klum' }),
    ];
    const ranked = rankTargets({ keyword: 'Tom Kaulitz Heidi Klum', secondary: ['Tokio Hotel'], title: 'Tom Kaulitz Heidi Klum: Inside Their Relationship', categoryExternalId: 3, ownPostId: 3, now }, targets);
    expect(ranked.map((r) => r.target.wpPostId)).not.toContain(3); // own post
    const choice = chooseLineTarget(ranked)!;
    expect(choice.choice.target.wpPostId).toBe(1);
    expect(choice.reason).toBe('related');
    const unrelated = rankTargets({ keyword: 'Quantum Computing Basics', secondary: [], title: null, categoryExternalId: null, ownPostId: null, now }, [t(2, 'Best Pasta Recipes'), t(5, 'Garden tips', { keyword: 'garden tips', publishedAt: new Date('2025-05-01T00:00:00Z') })]);
    const fallback = chooseLineTarget(unrelated)!;
    expect(fallback.reason).toBe('previous');
    expect(fallback.choice.target.wpPostId).toBe(5);
    expect(chooseLineTarget(rankTargets({ keyword: 'x y', secondary: [], title: null, categoryExternalId: null, ownPostId: null, now }, [t(2, 'Best Pasta Recipes')]))!.reason).toBe('latest');
    expect(chooseLineTarget([])).toBeNull(); // first post on a site
  });

  it('matches German topics and finds natural anchors already in the body', () => {
    const ranked = rankTargets({ keyword: 'Größe von Heidi Klum', secondary: [], title: null, categoryExternalId: null, ownPostId: null, now }, [t(7, 'Heidi Klums Töchter und Söhne'), t(8, 'Größe und Gewicht: Heidi Klum im Check'), t(9, 'Kochrezepte für den Sommer')]);
    expect(ranked[0].target.wpPostId).toBe(8);
    expect(ranked.find((r) => r.target.wpPostId === 9)!.related).toBe(false);
    expect(findAnchor('Viele fragen nach der Größe und Gewicht der Moderatorin.', t(8, 'Größe und Gewicht: Heidi Klum im Check'))).toBe('Größe und Gewicht');
    expect(findAnchor('Heidi Klums Töchtern geht es gut.', t(7, 'Heidi Klums Töchter und Söhne'))).toBeNull();
  });
});
