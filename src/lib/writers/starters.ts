/**
 * Starting prompts for a new writer (Writers → New writer → start empty). The owner replaces them with their own; the
 * placeholders are filled by the app ({{keyword}}, {{selected_title}}, …). Each asks for the format the app reads.
 */

export const PERSON_STARTER_PROMPT = `Write a well-researched, people-first article about {{keyword}} in {{language_variant}}.

## INPUTS

**Title:** {{selected_title}}
**Primary keyword:** {{keyword}}
{{#if secondary_keywords}}**Secondary keywords:** {{secondary_keywords}} (use them naturally where they fit; never force them){{/if}}

## RESEARCH AND ACCURACY

- Research before writing: official websites, reputable news outlets, public records and interviews.
- Use only facts you can verify. When sources disagree or a detail is not public, say so instead of guessing.
- Respect the privacy of family members, especially children. No rumors presented as facts.
- Link sources naturally inside the text (descriptive anchor text, no bare URLs).

## REQUIRED OUTPUT FORMAT

SEO Title: [under 60 characters, with the primary keyword]
Meta Description: [120–155 characters]
URL Slug: [lowercase-hyphen-separated-slug]

# {{selected_title}}

[A short introduction, then a 40–60-word direct answer to the main question — no heading of its own]

## {{table_heading}}

| Attribute | Details |
|---|---|
| Full Name | … |
[8–14 rows of verified facts only; leave out what is not known]

## [Relevant H2 sections with original paragraphs]

## Conclusion

## Frequently Asked Questions

### 1. [Question]
[Answer]

Write exactly {{faq_count}} questions. Length: {{word_range}}. Natural, human sentences; no bullet lists in the narrative.`;

export const GENERAL_STARTER_PROMPT = `Write a helpful, well-researched article in {{language_variant}} for readers in {{country}}.

## INPUTS

**Primary keyword:** {{keyword}}
{{#if example_title}}**Title idea:** {{example_title}}{{/if}}
{{#if secondary_keywords}}**Secondary keywords:** {{secondary_keywords}} (use them naturally where they fit){{/if}}

## QUALITY

- Answer the reader's question early and completely; practical steps where they help.
- Use only facts you can verify; link reliable sources naturally inside the text.
- Clear H2 sections with H3 subheadings where useful; short paragraphs.

## REQUIRED OUTPUT FORMAT

SEO Title: [under 60 characters, with the primary keyword]
Meta Description: [120–155 characters]
URL Slug: [lowercase-hyphen-separated-slug]

# [Article title with the primary keyword]

[Introduction]

## [H2 sections]

## Conclusion

## Frequently Asked Questions

### [Question]
[Answer]

About {{faq_count}} questions. Length: {{word_range}}.`;

export const OWN_TITLES_STARTER_PROMPT = `Generate 6–10 credible, reader-focused, SEO-friendly titles for an article about "{{keyword}}" in {{language}} for readers in {{country}}.
{{#if example_title}}Reference title for direction only: "{{example_title}}"{{/if}}

Use the primary keyword naturally. No clickbait, no claims that are not supported.

Return the numbered titles, followed by a final line in exactly this format:

Recommended Title: <best title>`;
