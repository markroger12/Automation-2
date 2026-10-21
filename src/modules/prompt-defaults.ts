/**
 * Shipped default prompts (Appendix A and B). These are seeded ONCE into
 * PromptTemplate. On upgrade a stored prompt is replaced only when its content
 * still exactly equals a previously shipped default (tracked by hash in
 * `previousHashes`), so owner edits are never silently overwritten.
 *
 * Client-safe: no Node imports.
 */

export interface PromptVariableDoc {
  name: string;
  description: string;
  /** Rendering fails (and nothing is sent) when a required variable is empty. */
  required: boolean;
  /** Where the value comes from; downstream values are unavailable in previews. */
  source: 'input' | 'settings' | 'stage';
}

export interface PromptDefault {
  moduleKey: 'celebrity-writer' | 'tigram-writer' | 'shared';
  stageKey: string;
  name: string;
  description: string;
  version: number;
  content: string;
  variables: PromptVariableDoc[];
  /** Image prompts are exempt from the automatic language instruction. */
  kind: 'text' | 'image' | 'vision';
  /** sha256 hashes of earlier shipped versions (for safe upgrades). */
  previousHashes: string[];
}

const v = (name: string, description: string, required: boolean, source: PromptVariableDoc['source']): PromptVariableDoc => ({
  name,
  description,
  required,
  source,
});

const KEYWORD = v('keyword', 'Primary keyword exactly as entered', true, 'input');
const LANGUAGE = v('language', 'Article language (English or German)', true, 'input');
const COUNTRY = v('country', 'Target country / audience', true, 'input');
const SECONDARY = v('secondary_keywords', 'Secondary keywords, comma-separated (optional)', false, 'input');
const EXAMPLE_TITLE = v('example_title', 'Example article title — guidance only (optional)', false, 'input');

export const PROMPT_DEFAULTS: PromptDefault[] = [
  {
    moduleKey: 'celebrity-writer',
    stageKey: 'TITLES',
    name: 'Celebrity — Titles',
    description: 'Several credible SEO titles plus a parseable "Recommended Title:" line.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [KEYWORD, EXAMPLE_TITLE, COUNTRY, LANGUAGE],
    content: `Generate several credible, reader-focused, SEO-friendly blog titles for:

Primary keyword: "{{keyword}}"
{{#if example_title}}Reference title for direction only: "{{example_title}}"{{/if}}
Audience: {{country}}; language: {{language}}.

Use the primary keyword naturally where it helps. Avoid exaggerated, spammy, clickbait and formulaic AI-sounding titles. Make the subject and reader benefit clear. Offer distinct angles instead of minor rephrasings. Do not assert private details or relationships as facts in a title unless they are supported.

Return 6–10 numbered title options, followed by a final line in exactly this format:

Recommended Title: <best title>`,
  },
  {
    moduleKey: 'celebrity-writer',
    stageKey: 'RESEARCH',
    name: 'Celebrity — Research',
    description: 'Organized, source-aware research notes; not the article.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [KEYWORD, v('selected_title', 'Approved article title', true, 'stage'), LANGUAGE, COUNTRY],
    content: `Research the person or subject associated with "{{keyword}}" for an article titled "{{selected_title}}". Collect only information you can responsibly support. Focus on identity; known dates and places; early life; education; public family/relationship details; career chronology; notable roles/projects; awards; public statements; and genuinely relevant recent developments.

Separate reliable established facts from disputed claims, estimates, rumors and unavailable details. Do not guess birth dates, children, partners, height, net worth, income, or private contact information. For net worth, explain when published numbers are unofficial estimates. Prefer primary sources and reputable reporting. When citing a source, include a real checkable URL and date if known; never fabricate a citation.

Produce organized research notes detailed enough to support a substantial article, including brief notes on uncertain facts and source conflicts. Do not write the article yet. Language: {{language}}. Country/audience: {{country}}.`,
  },
  {
    moduleKey: 'celebrity-writer',
    stageKey: 'LONG_ARTICLE',
    name: 'Celebrity — Long article',
    description: '1,500–2,000 word biography draft with H2/H3 headings; no FAQ or Quick Bio yet.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [
      v('selected_title', 'Approved article title', true, 'stage'),
      KEYWORD,
      SECONDARY,
      COUNTRY,
      LANGUAGE,
      v('min_keyword_occurrences', 'Advisory minimum keyword occurrences', true, 'settings'),
      v('max_keyword_occurrences', 'Advisory maximum keyword occurrences', true, 'settings'),
    ],
    content: `Write a substantial biography article of approximately 1,500–2,000 words using the established research already gathered in this conversation.

Title: "{{selected_title}}"
Primary keyword: "{{keyword}}"
{{#if secondary_keywords}}Secondary terms to use only where natural: {{secondary_keywords}}{{/if}}
Audience: {{country}}; language: {{language}}.

Use a concise, informative opening and logical H2/H3 Markdown headings (## and ###). Write ordinary prose in paragraphs of roughly 3–5 varied sentences; no bullet-point or numbered-list body sections. Include a coherent conclusion. Bold only occasional genuinely important names, works or milestones. Avoid repetitive phrases, exaggerated claims and fabricated information. Preserve meaningful uncertainty, distinguish unofficial estimates and attribute potentially disputed claims.

Use the focus keyword naturally; the {{min_keyword_occurrences}}–{{max_keyword_occurrences}} target is advisory, never justification for keyword stuffing. Do not add FAQs or a Quick Bio yet. Output only the article body; no commentary, title heading, reference list made of invented URLs or self-evaluation.`,
  },
  {
    moduleKey: 'celebrity-writer',
    stageKey: 'FINAL_ARTICLE',
    name: 'Celebrity — Final article',
    description: 'Polish and shorten to the configured maximum while preserving verified facts.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [v('max_words', 'Maximum final word count', true, 'settings'), KEYWORD, LANGUAGE],
    content: `Edit the previous long article into a finished magazine-quality article of no more than {{max_words}} words. Keep the same verified factual substance, names, dates, quantities, direct quotes and meaningful uncertainty. Remove repetition, awkward phrasing, filler, weak transitions and formulaic AI-sounding language. Maintain useful ## H2 and ### H3 headings and natural paragraphs. Keep the introduction concise, retain a logical conclusion, and use "{{keyword}}" naturally near the opening and in a relevant heading only where helpful.

Do not add FAQs, a Quick Bio, a second title, unsupported claims, invented quotations, bullet lists, commentary or sources you did not verify. Output the complete final article only in {{language}}.`,
  },
  {
    moduleKey: 'celebrity-writer',
    stageKey: 'FAQS',
    name: 'Celebrity — FAQs',
    description: 'Exactly the configured number of QUESTION/ANSWER pairs.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [KEYWORD, v('faq_count', 'Number of FAQs (default 5)', true, 'settings'), LANGUAGE],
    content: `For the completed biography about "{{keyword}}", write exactly {{faq_count}} realistic search-based questions with concise, factual answers in {{language}}. Use facts established in the research; do not guess private information or turn uncertainty into certainty.

Output only repeated pairs in this format:

QUESTION: <question ending in ?>
ANSWER: <one short useful answer>

Do not include an introduction, conclusion or extra commentary.`,
  },
  {
    moduleKey: 'celebrity-writer',
    stageKey: 'QUICK_BIO',
    name: 'Celebrity — Quick Bio',
    description: 'Two-column Attribute | Details HTML table with ~11–13 supported rows.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [KEYWORD, v('bio_rows_range', 'Row range, e.g. 11–13', true, 'settings'), LANGUAGE],
    content: `For the biography about "{{keyword}}", create a clean HTML Quick Bio table containing approximately {{bio_rows_range}} useful rows supported by the research. Use exactly two columns: Attribute and Details. Candidate fields: Full Name, Known As, Profession, Date of Birth, Age, Birthplace, Nationality, Education, Public Relationship Status, Career, Known For, Famous Works, Social Media, Height and Estimated Net Worth. Omit irrelevant fields rather than inventing values; for an important unavailable field, write "Not publicly confirmed" or the natural German equivalent.

Use valid HTML only: <table>, <thead>, <tbody>, <tr>, <th> and <td>. First row headers are Attribute and Details. No CSS, scripts, Markdown fences, citations of invented sources or surrounding commentary. Language: {{language}}.`,
  },
  {
    moduleKey: 'celebrity-writer',
    stageKey: 'PHOTO_CHECK',
    name: 'Celebrity — Photo check',
    description: 'Asks ChatGPT which photos carry a watermark or are another site\'s collage, and for alt text (owner\'s earlier tool). Never identifies people.',
    version: 2,
    kind: 'vision',
    // v1 only said “a collage made from multiple images”: a designed thumbnail (a photo with a circle around one person,
    // owner report) was not called a collage. v2 is the earlier tool's wording plus shapes drawn over people.
    previousHashes: ['ba797c3cb90409610c6ee7f4f7ae205f4bfda14d1f2092049e5f6b9742252044'],
    variables: [v('photo_count', 'Number of attached candidate images', true, 'stage'), KEYWORD],
    content: `I am writing an article about "{{keyword}}". I attached {{photo_count}} photos from an image search, numbered 1 to {{photo_count}} in the order they are attached.

For every photo, write one line in exactly this format:
<number>: watermark=<yes or no> | collage=<yes or no> | alt=<alt text>

watermark=yes when the photo has a watermark, a website name or web address, a channel or photo agency logo, or large text written over the picture. Text that belongs to the scene itself (a sign, the backdrop at an event, a shirt print) does not count.
collage=yes when the picture is not one plain photo but several photos put together or a designed thumbnail: side by side, split by a line, in frames or a grid, a photo inside another photo, or circles, arrows, shapes, borders or boxes drawn around or over people.
alt: at most 12 words describing what is visible: the place, the occasion, what the people wear or do. Do not name anyone and do not guess who the people are; the name is added separately.

Write nothing else.`,
  },
  {
    moduleKey: 'celebrity-writer',
    stageKey: 'IMAGE_SEARCH',
    name: 'Celebrity — Image search',
    description: 'Asks ChatGPT to search the web and show a picture gallery of the person; the extension saves the pictures (owner\'s earlier tool).',
    version: 2,
    kind: 'image',
    // v1 asked for “at least 10 recent” photos: ChatGPT answered with text only for people with few or old photos (owner report).
    previousHashes: ['0caa5c7a1b90ab21ace8afbd041703ccefd6e2dd647cc51feac2c6157525bbb0'],
    variables: [v('person_name', 'The person: the Quick Bio full name, otherwise the keyword', true, 'stage')],
    content: `Search the web for real photos of {{person_name}} and show them as an image gallery.

Show as many different, high-quality photos as you can find (up to 10) in which {{person_name}} is clearly visible, for example portraits, red carpet, event or archival photos. Older photos are fine when there are no recent ones, and so are photos of {{person_name}} together with a well-known partner or family member.
No drawings, no AI-made pictures, no memes, no collages and no screenshots of articles.
Do not write an article; one short caption line is enough.`,
  },
  {
    moduleKey: 'tigram-writer',
    stageKey: 'ARTICLE',
    name: 'Tigram — Article',
    description: 'General SEO article starting with SEO TITLE / META DESCRIPTION / URL SLUG lines.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [COUNTRY, LANGUAGE, KEYWORD, SECONDARY, v('word_range', 'Target word range, e.g. 1500-2200', true, 'settings'), v('faq_count', 'Number of H3 FAQ questions (default 7)', true, 'settings')],
    content: `Write a well-researched, helpful, original, reader-friendly SEO article for a {{country}} audience in {{language}}.

Primary keyword: "{{keyword}}"
{{#if secondary_keywords}}Secondary keywords (use only where natural): {{secondary_keywords}}{{/if}}
Word target: {{word_range}}.

Start with exactly these three machine-readable lines:

SEO TITLE: <clear title under 60 characters with the primary keyword where possible>
META DESCRIPTION: <specific description between 100 and 150 characters>
URL SLUG: <clear lower-case words separated by hyphens>

Then deliver the full article as Markdown, without a redundant title heading or introductory chatbot commentary. Start with an interesting, direct introduction of approximately 100–150 words that uses the primary keyword naturally in the first 100 words. Follow with a direct-answer paragraph of around 40–60 words where that format matches reader intent. Use 5–7 substantial ## H2 sections; add ### H3 headings only when useful. Include one practical step-by-step explanation and one meaningful comparison/pros-cons table if the topic lends itself to them. Include a ## Frequently Asked Questions section with {{faq_count}} specific ### H3 questions and brief answers. End with ## Conclusion and a relevant, non-salesy next step.

Keep paragraphs easy to follow and varied in length. Distinguish verified facts from estimates, opinions, unsupported product claims and current information you cannot confirm. Do not pretend to have tested software or products unless the research actually provides that evidence. No fabricated statistics, links, release dates, quotations or testimonials. No empty filler sections. The primary goal is to solve the reader's question, not to game a plugin score.`,
  },
  {
    moduleKey: 'tigram-writer',
    stageKey: 'CATEGORY',
    name: 'Tigram — Category',
    description: 'Pick exactly one existing synchronized WordPress category.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [KEYWORD, v('categories', 'Synchronized category names, one per line', true, 'stage')],
    content: `Select exactly one suitable WordPress category for the article about "{{keyword}}" from this list:

{{categories}}

Choose only a category literally present in the list. Output a single line:

CATEGORY: <exact category name>`,
  },
  {
    moduleKey: 'tigram-writer',
    stageKey: 'IMAGE_PLAN',
    name: 'Tigram — Image plan',
    description: 'Plans the featured image (with a short title text written on it) and two simple flat body images, with alt texts (owner\'s earlier tool).',
    version: 2,
    kind: 'text',
    previousHashes: [],
    variables: [KEYWORD, v('image_title', 'Short title for the featured picture: the article title before “:” or “–”, at most ~45 characters', true, 'stage')],
    content: `Plan 3 images for this article about "{{keyword}}". Do not create the images yet.

Image 1 — FEATURED IMAGE (blog header), landscape.
It shows this short title text, spelled exactly: "{{image_title}}".
Large, bold, easy to read text in the middle, with empty space above and below it (the top and bottom edges will be cropped to 16:9).
Clean, modern background that fits the topic, strong contrast, no logos, no watermark, no other words.

Image 2 — BODY IMAGE, landscape. A simple flat illustration of the main topic of the article.
Image 3 — BODY IMAGE, landscape. A simple flat illustration of another key part of the article (for example the step-by-step part or the comparison).

Body image style (images 2 and 3): minimal flat illustration, soft colours, plain light background, lots of empty space, only a few simple objects, NO text, letters or numbers at all, no logos, no faces.

Answer only with these six lines and nothing else:
IMAGE 1 PROMPT: <complete prompt for image 1, including the title text and style>
IMAGE 1 ALT: <alt text, max 120 characters, contains "{{keyword}}">
IMAGE 2 PROMPT: <complete prompt for image 2, including the style>
IMAGE 2 ALT: <alt text, max 120 characters>
IMAGE 3 PROMPT: <complete prompt for image 3, including the style>
IMAGE 3 ALT: <alt text, max 120 characters>`,
  },
  {
    moduleKey: 'tigram-writer',
    stageKey: 'IMAGE_GENERATION',
    name: 'Tigram — Image generation',
    description: 'Sent once per planned image: ChatGPT creates the picture; the app adds the website logo and places it (owner\'s earlier tool).',
    version: 2,
    kind: 'image',
    previousHashes: [],
    variables: [v('image_brief', 'The complete prompt for this image from the image plan', true, 'stage')],
    content: `Create this image now, landscape (wide) format:

{{image_brief}}

Only create the image — no text answer is needed.`,
  },
  {
    moduleKey: 'shared',
    stageKey: 'EXTERNAL_LINKS',
    name: 'Shared — External links',
    description: 'Up to N "LINK: phrase | URL" candidates; every link is verified locally before insertion.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [v('link_count', 'Number of candidates to request', true, 'settings'), v('wikipedia_site', 'Wikipedia for the article language', true, 'settings'), KEYWORD, v('final_article', 'Current article body', true, 'stage')],
    content: `Review the article below and propose up to {{link_count}} genuinely useful outbound references. Each anchor must appear **exactly** in the supplied article body. Prefer independently checkable official sites, educational institutions, recognized publications, relevant IMDb entries and {{wikipedia_site}} where appropriate. Do not link the primary focus keyword "{{keyword}}" itself, a social media profile, unrelated store, gossip aggregator or unverified net-worth site. Avoid more than two proposed anchors from the same paragraph.

Verify the destination's subject and URL if you have browsing available. If you cannot check a URL, do not invent it; simply return fewer suggestions. Never rewrite the article.

Return one line per link, with nothing else:

LINK: <exact phrase in the body> | <full verified URL>

Article:

{{final_article}}`,
  },
  {
    moduleKey: 'shared',
    stageKey: 'SEO_CORRECTION',
    name: 'Shared — SEO correction',
    description: 'Bounded, fact-preserving revision for concrete Rank Math / local SEO issues.',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [KEYWORD, v('rankmath_issues', 'Concrete issues reported', true, 'stage'), v('max_words', 'Maximum words', true, 'settings'), LANGUAGE, v('final_article', 'Current article', true, 'stage')],
    content: `The WordPress Rank Math panel and local SEO checker reported the following concrete issues for the article about "{{keyword}}":

{{rankmath_issues}}

Revise only what is reasonably correctable in article content while preserving all verified facts, names, dates, quotations, hyperlinks, HTML structure, images, FAQ meaning and headings. Keep the revised article at or below {{max_words}} words. The focus keyword may be placed naturally in the introduction or a relevant heading if absent, but never repeat it artificially. Do not satisfy a plugin check at the expense of accuracy or clarity. Use Markdown ## H2 and ### H3 as in the original. Output only the full revised article in {{language}}.

Article:

{{final_article}}`,
  },
  {
    moduleKey: 'shared',
    stageKey: 'HUMANIZE',
    name: 'Shared — Editorial humanizer',
    description: 'Paragraph-level editorial polish with fact locks (not a detector bypass).',
    version: 1,
    kind: 'text',
    previousHashes: [],
    variables: [KEYWORD, v('problems', 'Issues found by the local editor', false, 'stage'), v('paragraphs', 'Labelled paragraphs [P1]…', true, 'stage')],
    content: `You are a senior magazine editor. Improve the labelled paragraphs below so they read as careful, natural, precise editorial writing. This is an editorial improvement task, not a request to fool AI-detection software.

Non-negotiable constraints:
1. Preserve every factual claim and all existing uncertainty. Do not add facts, examples, quotes, sources, statistics or first-hand experience.
2. Preserve names, dates, numbers, quoted words and the number of occurrences of "{{keyword}}" within each individual paragraph.
3. Preserve every exact link mark {L1}anchor{/L1} and every {b}bold{/b} and {i}italic{/i} span with identical inner text.
4. Keep the language and regional spelling of each paragraph unchanged.
5. Remove empty phrases such as "It is important to note", "It is worth noting", "This highlights" and "In conclusion" when they add nothing.
6. Avoid opening sentences with Additionally, Furthermore, Moreover, Notably, Overall or Ultimately; connect ideas by meaning.
7. Replace inflated words such as delve, pivotal, intricate, meticulous, underscore, showcase, testament, tapestry, realm, vibrant, embark, navigate, leverage, foster, crucial, remarkable, renowned and boasts with plain, accurate language where appropriate.
8. Vary sentence length naturally. Do not insert deliberate errors, slang, awkward fragments or artificial quirks.
9. Prefer commas and full stops over excessive em dashes. Keep each output as one paragraph with roughly the same length as its original (normally within 20%).
10. If a paragraph is already clear, preserve it or make only a very small change. Do not make a guess sound certain.

Specific issues identified by the local editor:
{{#if problems}}{{problems}}{{/if}}{{#unless problems}}None beyond the general rules above.{{/unless}}

Reply with only the edited paragraphs in the same numbered order. Put each original label alone on a line, followed by its single edited paragraph, for example:

[P4]
Edited paragraph text.

No titles, notes, code fences, introductions, explanations or extra paragraphs.

Paragraphs:

{{paragraphs}}`,
  },
];

export function findPromptDefault(moduleKey: string, stageKey: string): PromptDefault | undefined {
  return PROMPT_DEFAULTS.find((p) => p.moduleKey === moduleKey && p.stageKey === stageKey);
}
