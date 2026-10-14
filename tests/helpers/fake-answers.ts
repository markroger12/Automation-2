/**
 * Canned ChatGPT answers for pipeline tests (NOT real model output). They are
 * shaped like the real stage answers so parsers, assembly and checks run on
 * realistic text.
 */
export function cannedAnswer(stageKey: string, prompt: string, language: 'en' | 'de', keyword: string): string {
  const de = language === 'de';
  switch (stageKey) {
    case 'TITLES':
      return de
        ? `1. ${keyword}: Die Geschichte ihrer Liebe\n2. ${keyword}: Wie alles begann\n3. Was man über ${keyword} wissen sollte\n\nRecommended Title: ${keyword}: Die Geschichte ihrer Liebe`
        : `1. ${keyword}: Inside Their Relationship\n2. ${keyword}: How It All Began\n3. What to Know About ${keyword}\n4. ${keyword}: A Timeline\n\nRecommended Title: ${keyword}: Inside Their Relationship`;
    case 'RESEARCH':
      return de
        ? `Recherche-Notizen zu ${keyword}.\n\nIdentität: Musiker und Model. Quelle: https://de.wikipedia.org/wiki/Tom_Kaulitz (abgerufen 2026).\n${'Die Karriere begann früh und wurde von mehreren Medien begleitet. '.repeat(20)}\nUnklar: genaue Details zur Hochzeit sind nicht bestätigt.\nGeschätztes Vermögen: angeblich hoch, aber nur eine Schätzung.`
        : `Research notes on ${keyword}.\n\nIdentity: musician and model. Source: https://en.wikipedia.org/wiki/Tom_Kaulitz (accessed 2026).\n${'Their careers developed over many years and were covered by reputable outlets. '.repeat(20)}\nUnconfirmed: some wedding details are not publicly confirmed.\nEstimated net worth figures are unofficial estimates.`;
    case 'LONG_ARTICLE':
      return longArticle(language, keyword, 900);
    case 'FINAL_ARTICLE':
      return longArticle(language, keyword, 650);
    case 'FAQS': {
      const n = Number(/exactly (\d+)/.exec(prompt)?.[1] ?? '5');
      return Array.from({ length: n }, (_, i) =>
        de
          ? `QUESTION: Frage ${i + 1} zu ${i === 0 ? keyword : 'den beiden'}?\nANSWER: Eine kurze, sachliche Antwort Nummer ${i + 1}.`
          : `QUESTION: Question ${i + 1} about ${i === 0 ? keyword : 'the couple'}?\nANSWER: A short factual answer number ${i + 1}.`,
      ).join('\n\n');
    }
    case 'QUICK_BIO': {
      const rows = de
        ? [['Vollständiger Name', 'Tom Kaulitz'], ['Beruf', 'Musiker'], ['Bekannt für', 'Tokio Hotel'], ['Nationalität', 'Deutsch'], ['Geburtsort', 'Leipzig'], ['Partnerin', 'Heidi Klum'], ['Instrument', 'Gitarre'], ['Aktiv seit', '2001'], ['Band', 'Tokio Hotel'], ['Größe', 'Nicht öffentlich bestätigt'], ['Vermögen (geschätzt)', 'Nicht öffentlich bestätigt'], ['Wohnort', 'Los Angeles']]
        : [['Full Name', 'Tom Kaulitz'], ['Profession', 'Musician'], ['Known For', 'Tokio Hotel'], ['Nationality', 'German'], ['Birthplace', 'Leipzig'], ['Partner', 'Heidi Klum'], ['Instrument', 'Guitar'], ['Active Since', '2001'], ['Band', 'Tokio Hotel'], ['Height', 'Not publicly confirmed'], ['Estimated Net Worth', 'Not publicly confirmed'], ['Residence', 'Los Angeles']];
      return `<table><thead><tr><th>Attribute</th><th>Details</th></tr></thead><tbody>${rows.map(([a, d]) => `<tr><td>${a}</td><td>${d}</td></tr>`).join('')}</tbody></table>`;
    }
    case 'ARTICLE':
      return tigramArticle(language, keyword);
    case 'CATEGORY':
      return /Tech/.test(prompt) ? 'CATEGORY: Tech & Apps' : 'CATEGORY: Something That Does Not Exist';
    case 'HUMANIZE': {
      // A faithful editor: every labelled paragraph comes back, banned openers removed (fact locks must accept it).
      const lines = prompt.slice(prompt.lastIndexOf('Paragraphs:')).split('\n');
      const out: string[] = [];
      lines.forEach((line, i) => {
        const m = /^\[(P\d+)\]$/.exec(line.trim());
        if (m && lines[i + 1]) out.push(`[${m[1]}]\n${lines[i + 1].replace(/^(?:Additionally|Furthermore|Moreover|Zudem|Außerdem), (\p{L})/u, (_, c: string) => c.toUpperCase())}`);
      });
      return out.join('\n\n');
    }
    default:
      return `Answer for ${stageKey}`;
  }
}

function longArticle(language: 'en' | 'de', keyword: string, targetWords: number): string {
  const de = language === 'de';
  const filler = de
    ? 'Die Beziehung wurde von vielen Medien begleitet, und beide sprechen in Interviews offen über ihre Arbeit und ihr Familienleben. '
    : 'The relationship has been covered by many outlets, and both have spoken openly in interviews about their work and family life. ';
  const para = (n: number) => filler.repeat(n).trim();
  const sections = de ? ['Wie alles begann', `${keyword} in der Öffentlichkeit`, 'Karriere und Projekte', 'Fazit'] : ['How It All Began', `${keyword} in the Spotlight`, 'Careers and Projects', 'Conclusion'];
  const per = Math.max(2, Math.round(targetWords / 5 / 20));
  const intro = de
    ? `${keyword} gehören zu den bekanntesten Paaren der Unterhaltungsbranche. ${para(1)}`
    : `${keyword} are one of the best-known couples in entertainment. ${para(1)}`;
  const body = sections
    .map((h, i) => `## ${h}\n\n${i === 3 ? (de ? `Für ${keyword} bleibt die Geschichte spannend. ` : `For ${keyword}, the story remains compelling. `) : ''}${para(per)}\n\n${para(per)}`)
    .join('\n\n');
  return `${intro}\n\n${body}`;
}

function tigramArticle(language: 'en' | 'de', keyword: string): string {
  const de = language === 'de';
  const topics = de ? ['Installation', 'Einstellungen', 'Sicherheit', 'Leistung', 'Alternativen', 'Kosten'] : ['Installation', 'Settings', 'Security', 'Performance', 'Alternatives', 'Pricing'];
  const para = (t: string, i: number) =>
    de
      ? `Beim Thema ${t} lohnt sich ein genauer Blick, denn Punkt ${i} entscheidet oft über die Zufriedenheit. Prüfe die offiziellen Angaben und vergleiche sie mit deinen Anforderungen, bevor du eine Wahl triffst.`
      : `When it comes to ${t.toLowerCase()}, point ${i} often decides whether users are happy. Check the official information and compare it with your own needs before you decide.`;
  const sections = topics.slice(0, 5).map((t, i) => `## ${t}\n\n${para(t, i + 1)} ${para(t, i + 2)}\n\n${para(t, i + 3)}`).join('\n\n');
  const subject = (i: number) => (i === 0 ? keyword : de ? 'diesem Thema' : 'this topic');
  const faqs = Array.from({ length: 7 }, (_, i) => (de ? `### Frage ${i + 1} zu ${subject(i)}?\n\nKurze Antwort ${i + 1}.` : `### Question ${i + 1} about ${subject(i)}?\n\nShort answer ${i + 1}.`)).join('\n\n');
  return [
    `SEO TITLE: ${keyword}: ${de ? 'Der komplette Leitfaden' : 'The Complete Guide'}`,
    `META DESCRIPTION: ${de ? `Alles über ${keyword}: Installation, Einstellungen, Sicherheit und Alternativen verständlich erklärt.` : `Everything about ${keyword}: installation, settings, security and alternatives explained clearly for beginners.`}`,
    `URL SLUG: ${keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-guide`,
    '',
    de ? `${keyword} ist für viele Nutzer interessant. ${para('Grundlagen', 0)}` : `${keyword} matters to many users today. ${para('basics', 0)}`,
    '',
    sections,
    '',
    `| ${de ? 'Option' : 'Option'} | ${de ? 'Vorteil' : 'Pro'} | ${de ? 'Nachteil' : 'Con'} |\n| --- | --- | --- |\n| A | ${de ? 'Schnell' : 'Fast'} | ${de ? 'Teuer' : 'Pricey'} |\n| B | ${de ? 'Günstig' : 'Cheap'} | ${de ? 'Langsam' : 'Slow'} |`,
    '',
    `## ${de ? 'Häufig gestellte Fragen' : 'Frequently Asked Questions'}`,
    '',
    faqs,
    '',
    `## ${de ? 'Fazit' : 'Conclusion'}`,
    '',
    de ? `Mit diesen Schritten ist ${keyword} schnell eingerichtet. ${para('Fazit', 9)}` : `With these steps, ${keyword} is set up quickly. ${para('conclusion', 9)}`,
  ].join('\n');
}
