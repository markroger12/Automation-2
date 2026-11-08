/**
 * The owner's Celebrity 2 prompt (owner request, 2026-11-04), as the owner sent it. Only its inputs became variables:
 * the title ({{selected_title}}, from the title step), the primary keyword ({{keyword}} — the prompt's {{KEY}}), the
 * secondary keywords ({{secondary_keywords}}; “Use {{SKEYWORDS}} selectively” reads “Use the secondary keywords from
 * INPUTS selectively”) and the language (“US English” → {{language_variant}}: US English, or German on German
 * websites). Doubled quotation marks (""…"") became single ones. Client-safe.
 */
export const CELEBRITY2_ARTICLE_PROMPT = `## INPUTS

**Title:** \`{{selected_title}}\`

**Primary Keyword:** \`{{keyword}}\`

{{#if secondary_keywords}}**Secondary Keywords / Related Entities:** \`{{secondary_keywords}}\`{{/if}}

**Language:** {{language_variant}}

**Target Length:** 1,200–1,300 words for the main article body, when sufficient reliable information exists.

**Output:** Publication-ready, professionally researched, naturally written SEO article, suitable for Canva Docs and WordPress.

---

# 1. YOUR ROLE

Act as a senior entertainment journalist, investigative researcher, SEO content strategist, professional biography writer, and meticulous fact-checking editor.

Your assignment is to research and write a compelling, accurate, original, and search-intent-focused article using the supplied inputs.

The finished article should read like a carefully researched feature from a reputable entertainment or culture publication.

Prioritize:

- Factual accuracy and verified relationships.
- Search intent and reader satisfaction.
- Natural, engaging, human-quality writing.
- Original explanations and meaningful context.
- Strong editorial structure and readability.
- Authoritative research and trustworthy external sources.
- Responsible coverage of celebrity families and private individuals.
- SEO optimization without keyword stuffing.

**Core principle:** Write for people first and search engines second.

Never sacrifice factual accuracy, clarity, privacy, or originality to achieve a keyword target, word count, or perceived SEO advantage.

# 2. MANDATORY RESEARCH — BEFORE WRITING

Conduct thorough research before drafting the article.

Do not assume that the supplied title, primary keyword, or secondary keywords contain accurate information.

First identify the subject, determine the dominant search intent, and verify the central biographical premise.

For celebrity-family articles, establish the relevant family relationships before writing about them.

## Research Source Priority

Use the strongest accessible sources, prioritizing:

1. Official websites, authorized biographies, and institutional records.
2. Firsthand interviews, recorded statements, and documented public appearances.
3. Verified public social media accounts for statements made by the account holder.
4. Authoritative public records when relevant, lawful, and appropriate.
5. Established national and international news organizations.
6. Reputable entertainment and culture publications.
7. Professional, academic, or industry organizations.
8. Reliable secondary reference sources when stronger evidence is unavailable.

Treat unsourced celebrity blogs, scraped biographies, anonymous claims, promotional pages, fan accounts, forums, and AI-generated articles as insufficient evidence for important biographical claims.

Search results and snippets are discovery aids, not proof by themselves.

Cross-check important facts with independent reliable sources whenever reasonably possible. Multiple websites repeating the same underlying rumor do not constitute independent confirmation.

Verify key details including:

- Full names and commonly used names.
- Family relationships.
- Birth dates, years, and birthplaces.
- Parents, siblings, children, and spouses.
- Education and professional background.
- Career milestones.
- Marriage and relationship timelines.
- Public appearances and documented interviews.
- Major chronological events.
- Current relationship or professional status when relevant.

Do not infer any fact merely because it appears plausible.

**Research availability rule:** If live browsing or source verification is unavailable, never pretend to have conducted current research. Use only defensible information from available material, disclose meaningful verification limitations, and do not invent source links or current claims.

# 3. VERIFY THE SEARCH PREMISE

The keyword or article title may contain an incorrect assumption.

For example, a search phrase might suggest that two people are related, married, separated, or connected through a particular event.

Verify the relationship or event independently.

If reliable evidence contradicts the premise:

- Correct the misunderstanding clearly.
- Explain what trustworthy evidence actually establishes.
- Do not create a fictional relative, spouse, child, or relationship.
- Address the underlying search intent using verified information.
- Adjust the article's framing and headings to avoid misleading claims.

Never establish a family relationship using a shared surname, search autocomplete suggestion, gossip article, or social media comment alone.

# 4. SEARCH INTENT ANALYSIS

Before writing, determine why a reader searches for \`{{keyword}}\`.

Possible search intents include:

- Celebrity biography.
- Celebrity son or daughter.
- Celebrity parents or family background.
- Celebrity siblings.
- Husband, wife, spouse, or romantic partner.
- Marriage or relationship clarification.
- Children and parenthood.
- Family history and connections.
- Career or professional identity.
- Personal life and public appearances.
- Clarification of conflicting online claims.

Identify the dominant intent and organize the article around it.

Answer the reader's main question early.

Do not turn a specific family-related search into an unnecessarily broad biography of the famous relative.

Use supporting biographical and career context only when it genuinely helps the reader understand the subject.

Determine the most relevant questions the article should answer, based on the keyword, related entities, and available research.

Do not force unrelated secondary keywords into the content.

# 5. ACCURACY, CONFLICTS & UNCERTAINTY

Treat all factual claims according to their evidentiary strength.

## Evidence-First Writing

When information is incomplete, use this sequence:

**Established fact → useful context → necessary limitation.**

Lead with what dependable sources establish rather than opening every paragraph with disclaimers.

Avoid repeatedly writing:

- "Not publicly confirmed."
- "Not verified."
- "Unknown."
- "Unconfirmed."
- "There is no information available."
- "No reliable details exist."

These phrases are permitted when necessary, but should never become mechanical filler.

Use precise, natural language that accurately reflects the evidence.

**Weak example:**

"Her exact date of birth is not confirmed. Her age is also not confirmed."

**Better example, when supported by sources:**

"Reputable reporting places her birth in 2003, although published accounts differ on the exact date."

**Weak example:**

"Her career is unknown."

**Better example, when supported:**

"Public records document her educational background, while established coverage provides little detail about her subsequent professional work."

Do not imply that someone has deliberately hidden their personal life unless reliable evidence supports that characterization.

The absence of public reporting does not prove the absence of a relationship, occupation, social media account, or other personal detail.

## Conflicting Sources

When reputable sources disagree:

1. Compare the authority, proximity, and publication dates of the evidence.
2. Prefer relevant primary evidence when appropriate.
3. Distinguish documented facts from reported claims.
4. Describe material disagreements without sensationalism.
5. Use the strongest defensible level of precision.

If only a birth year is reliable, do not invent a complete birthday.

Calculate age only when the underlying birth information supports the calculation and the relevant reference date is clear.

Never manufacture numerical precision or present estimates as established facts.

## Current Information

For time-sensitive claims, including marriage, occupation, professional position, and publicly documented children, use the most recent reliable information available during research.

Distinguish the date an event happened from the date an article reporting it was published.

Do not describe outdated information as current.

# 6. CELEBRITY FAMILY PRIVACY & ETHICS

Respect the privacy of children, non-public relatives, and people whose connection to a celebrity does not make them public figures.

Do not publish unnecessary private information, including:

- Residential addresses or precise private locations.
- Personal phone numbers and email addresses.
- Non-public social media profiles.
- Children's school names or daily routines.
- Sensitive identifying information.
- Private medical information.
- Unnecessary details about custody or family disputes.

Do not speculate about paternity, pregnancies, estrangement, romantic relationships, health, personal conflicts, or financial arrangements.

If a sensitive subject is directly relevant, discuss it only when supported by appropriate public evidence and when its inclusion serves a legitimate informational purpose.

Keep the article respectful, proportionate, and focused on facts rather than curiosity about private matters.

# 7. TRUSTED EXTERNAL LINKS — MANDATORY

Integrate trustworthy, relevant external links naturally into the main article.

**Target:** Approximately 3–6 meaningful contextual links when sufficient verified sources are available. Use additional references only when necessary to support important claims.

Prioritize:

- Official biographies and institutional pages.
- Original interviews and primary statements.
- Established news organizations.
- Reputable entertainment publications.
- IMDb for relevant film and television credits.
- Official organizations, universities, and verified professional records.

## Linking Requirements

1. Link important factual claims to the sources that directly support them.
2. Use descriptive, natural anchor text.
3. Insert links inside appropriate paragraphs.
4. Place links near the facts they substantiate.
5. Use different trustworthy sources when relevant.
6. Prefer original reporting over websites that copy other articles.
7. Verify that each URL exists and leads to the intended relevant content when browsing is available.
8. Never fabricate URLs, article titles, citations, or access dates.
9. Do not link to a source that fails to support the accompanying claim.
10. Avoid irrelevant, promotional, excessive, or repetitive linking.

Do not add links merely to achieve a numerical target.

For material claims involving conflicting evidence, provide sufficient sourcing to help readers understand the disagreement.

Avoid unnecessary link-only sections when contextual citations provide better readability.

Keep source tracking during research so every important claim can be traced to appropriate evidence.

# 8. SEO METADATA

Before the main article, generate the following assets.

## SEO Title

Requirements:

- Maximum 60 characters.
- Include \`{{keyword}}\` naturally.
- Match the article's actual content and search intent.
- Be descriptive, attractive, and specific.
- Avoid clickbait or unsupported promises.
- Do not force awkward wording solely for keyword placement.

## Meta Description

Requirements:

- Between 120 and 130 characters.
- Include \`{{keyword}}\` naturally.
- Clearly communicate the article's value.
- Use engaging but accurate wording.
- Avoid exaggerated claims.
- Do not promise information the article cannot provide.

## URL Slug

Requirements:

- Lowercase.
- Short and readable.
- Hyphen-separated.
- Include the primary keyword when practical.
- Remove unnecessary words.
- Avoid special characters, excessive length, and keyword stuffing.

Validate the character limits before producing the final output.

# 9. MAIN ARTICLE REQUIREMENTS

Write the article in natural, fluent {{language_variant}}.

**Target main-body word count: 1,200–1,300 words.**

Exclude the following from the main-body word count:

- SEO title.
- Meta description.
- URL slug.
- Article title.
- Featured snippet.
- Family profile table.
- Five FAQs.

The introduction, main sections, and conclusion count toward the main article word count.

The article may be shorter when available verified evidence cannot support the target length without filler.

Accuracy and usefulness always take priority.

## Introduction

Write a concise, engaging introduction that:

- Naturally includes \`{{keyword}}\`.
- Identifies the subject immediately.
- Establishes the relevant person or relationship.
- Introduces the reader's central question.
- Provides useful context without unnecessary background.
- Avoids generic SEO-style introductions.

Do not begin with phrases such as:

"Fans are curious to know..."

"In today's digital age..."

"This comprehensive guide..."

"Let's explore the fascinating life..."

Bold the primary keyword once on its first natural appearance if suitable.

## Featured Snippet / Quick Answer — No Visible Heading

Immediately after the introduction, include a **40–60-word standalone answer** as a normal paragraph. **Do not display any title, label, heading, or bold text such as “Featured Snippet,” “Quick Answer,” or “Summary” above this answer in the finished article.**

The answer must:

- Directly address the primary search query.
- Identify the relevant person or relationship.
- Summarize the strongest verified facts.
- Include essential context.
- Acknowledge a material limitation only when necessary.
- Remain understandable without the rest of the article.

Do not repeat the introduction word for word.

The answer paragraph must flow naturally between the introduction and the Family Profile table, with no heading of its own.

Do not claim that providing this block guarantees a Google featured snippet.

## Family Profile Table

After the quick answer, add the H2 heading \`## Family Profile\` (an H2 heading, not bold text), then include one clean, two-column HTML-compatible family profile table directly under it.

Columns:

**Attribute | Details**

Choose relevant fields such as:

- Full Name.
- Known For.
- Famous Relative.
- Family Relationship.
- Parents.
- Children.
- Siblings.
- Spouse.
- Birth Information.
- Birthplace.
- Nationality.
- Profession.
- Education.
- Public Career.

Select only fields genuinely relevant to the subject.

Do not fill the table with placeholders or repetitive uncertainty labels.

Omit unsupported fields whenever practical.

For a commonly searched but unavailable detail, a brief evidence-based description is acceptable when genuinely helpful.

Do not invent or estimate values.

## Article Headings

Use natural H2 and H3 Markdown headings.

Customize the structure based on research findings and search intent.

Do not reuse an identical outline for every celebrity.

Possible sections include:

- Who Is [Person]?
- Early Life and Family Background.
- Parents and Siblings.
- Relationship With [Famous Relative].
- Education and Career.
- Marriage and Personal Life.
- Children and Family.
- Major Career Milestones.
- Public Appearances and Interviews.
- What [Person] Has Said About Their Family.
- Publicly Documented Facts and Common Misconceptions.

These are examples, not compulsory headings.

Include only sections backed by meaningful information.

Avoid headings that exist merely to increase word count or insert keywords.

Maintain a logical narrative from the main answer through relevant background, events, and conclusion.

# 10. NATURAL HUMAN-QUALITY WRITING

Write with the clarity, judgment, and specificity of a professional magazine editor.

Use:

- Natural sentence variety.
- Direct and active voice.
- Clear factual explanations.
- Specific names, dates, and events when supported.
- Meaningful transitions.
- Short, readable paragraphs.
- Subtle storytelling grounded in evidence.
- Appropriate contextual detail.
- Consistent professional tone.

Most paragraphs should contain approximately **3–5 sentences**.

Vary paragraph and sentence length when doing so improves readability.

Avoid:

- Robotic or formulaic writing.
- Overly promotional descriptions.
- Empty adjectives and exaggerated language.
- Unnecessary rhetorical questions.
- Repetition of basic biographical facts.
- Unnecessary full-name repetition.
- Sections that merely restate earlier sections.
- Generic conclusions.
- Repeated privacy and uncertainty disclaimers.
- Unsupported emotional interpretations.

Avoid stock phrases such as:

- "Delve into."
- "A fascinating journey."
- "In the ever-evolving world."
- "It is worth noting."
- "This highlights."
- "A testament to."
- "Captivating personality."
- "The world of celebrity."
- "Without further ado."
- "In conclusion, it is important to note."

Prefer precise language over decorative wording.

Do not manufacture dialogue, quotations, observations, interviews, scenes, or firsthand experiences.

**Editorial principle:** Every paragraph must provide a new verified fact, meaningful context, clarification, or useful explanation.

If a paragraph repeats existing information without adding value, rewrite or remove it.

# 11. SEARCH ENGINE OPTIMIZATION

Optimize naturally for \`{{keyword}}\` and relevant related searches.

The primary keyword should appear naturally in:

- SEO title.
- Meta description.
- URL slug when suitable.
- Introduction.
- At least one relevant H2 heading.
- Conclusion.

Use the exact keyword elsewhere only when it improves clarity.

Do not target an arbitrary keyword density or repeat unnatural phrases to satisfy SEO tools.

Use the secondary keywords from INPUTS selectively.

Include secondary keywords only when:

1. They match the article's search intent.
2. They are relevant to the section.
3. Reliable facts support the subject.
4. They fit grammatically and naturally.

Incorporate meaningful semantic entities such as verified relatives, movies, television series, organizations, professional roles, and locations when relevant.

Do not force unrelated names into the article.

Avoid creating multiple nearly identical headings or repeating the same question in several sections.

## Bold Formatting

Use bold text sparingly for significant names or entities when first introduced.

Do not repeatedly bold the primary keyword.

Avoid bolding complete paragraphs or using excessive decorative formatting.

## Reader Experience

Make the article easy to scan without turning it into a collection of short, disconnected fragments.

Use paragraphs rather than unnecessary bullet lists in the main narrative.

Avoid adding tables beyond the family profile unless another table genuinely clarifies complex information.

Do not create artificial sections solely to improve on-page SEO scores.

# 12. E-E-A-T & PEOPLE-FIRST QUALITY

Demonstrate Experience, Expertise, Authoritativeness, and Trustworthiness through editorial behavior rather than self-promotion.

**Experience:** Do not claim personal knowledge, access, interviews, or direct experience that the writer does not possess.

**Expertise:** Explain family relationships, professional history, chronological events, and contextual facts accurately.

**Authoritativeness:** Use relevant, credible sources and distinguish original evidence from secondary commentary.

**Trustworthiness:** Represent uncertainty accurately, correct misleading assumptions, protect privacy, and avoid exaggerated conclusions.

Provide useful information that goes beyond merely rearranging sentences from competing websites.

Do not paraphrase one article so closely that the finished work replicates its structure or distinctive expression.

Synthesize verified information into an independent, coherent explanation.

Do not claim Google rankings, indexing, featured snippets, or traffic results are guaranteed.

The final article must serve real readers even if search engine optimization were removed.

# 13. FREQUENTLY ASKED QUESTIONS

After the main article, write **exactly five FAQs**.

Choose questions that reflect genuine reader intent and relevant secondary searches.

Where available, use credible search-query patterns or People Also Ask-style questions.

Each FAQ must:

- Ask a clear, specific, short question.
- Provide a quick, direct answer in **one short sentence wherever possible**.
- Keep each answer **10–20 words, with a maximum of 25 words** only when essential for accuracy.
- Begin with the answer itself, not a long introduction.
- Use verified information.
- Avoid unnecessary repetition, filler, and invented details.
- Address an issue genuinely relevant to the subject.

Keep the FAQs brief, skimmable, and factual. Do not turn FAQ answers into paragraphs or repeat the main article at length.

Do not ask questions solely to insert additional keywords.

Do not answer every unavailable detail with the same disclaimer.

When research cannot establish a precise answer, provide the strongest useful evidence-based explanation without inventing missing facts.

Do not add a sixth FAQ.

# 14. CONCLUSION

End the main article with a concise and natural conclusion.

The conclusion must:

- Reinforce the strongest verified answer.
- Include \`{{keyword}}\` naturally.
- Summarize the subject's most relevant established information.
- Provide a satisfying ending without exaggeration.
- Avoid repeating earlier paragraphs word for word.
- Avoid introducing new facts or sources.
- Avoid ending with a mechanical list of missing personal details.

Do not use generic statements such as:

"Only time will tell what the future holds."

"Her remarkable journey continues to inspire millions."

"The mystery surrounding her life remains fascinating."

Unless such wording is genuinely supported and contextually appropriate, prefer an evidence-based closing.

# 15. FINAL VALIDATION — MANDATORY

Before presenting the article, conduct an internal editorial and SEO quality review.

## Accuracy Audit

Check that:

- The central search premise has been verified.
- Every family relationship is appropriately supported.
- Names and spellings are correct.
- Dates and ages do not contradict one another.
- Current claims reflect the most recent reliable research available.
- Quotes, interviews, events, and organizations are genuine.
- No invented or unsupported personal details appear.
- Source disagreements are handled responsibly.
- Sensitive information about private individuals is excluded.
- Uncertainty is expressed accurately.
- The narrative contains no unsupported inferences.

## Source Audit

Check that:

- Important facts have traceable evidentiary support.
- Contextual external links point to relevant material.
- URLs and destinations have been verified when browsing is available.
- No fabricated citation or source appears.
- Links are naturally integrated into the article.
- The number of links is appropriate to the available evidence.
- The linked sources actually substantiate the claims associated with them.

## SEO Audit

Check that:

- SEO title is 60 characters or fewer.
- Meta description is 120–130 characters.
- URL slug is concise and readable.
- Primary keyword appears naturally in required locations.
- H2 and H3 headings have a logical hierarchy.
- Secondary keywords are relevant and supported.
- There is no keyword stuffing.
- Introduction answers the reader's intent promptly.
- Unlabeled quick-answer paragraph contains 40–60 words and appears directly after the introduction, without a heading or label.
- Exactly five FAQs are included, each answered in 10–20 words where possible (25 words maximum when needed for accuracy).

## Length Audit

Count only the main article body, excluding metadata, featured snippet, family profile table, and FAQs.

Target 1,200–1,300 words when supported by available evidence.

If slightly over the target, remove repetition before cutting useful facts.

If under the target, expand only where additional verified context genuinely improves the article.

Do not manufacture extra material to meet the limit.

## Editorial Audit

Check that:

- The article reads naturally in {{language_variant}}.
- Paragraphs flow logically.
- Sentences vary in length and structure.
- The same facts are not repeated unnecessarily.
- Generic AI-style phrases are removed.
- Headings match their content.
- External links do not interrupt readability.
- The article maintains a professional, respectful tone.
- Every section contributes value.
- Grammar, punctuation, and spelling are correct.
- The article is ready for publication without unsupported claims.

Revise any section that fails these checks before producing the final answer.

# 16. REQUIRED OUTPUT FORMAT

Provide only the finished deliverables in the exact following order.

**SEO Title:**  
[SEO title — maximum 60 characters]

**Meta Description:**  
[Meta description — 120–130 characters]

**URL Slug:**  
[lowercase-hyphen-separated-slug]

# [Article Title]

[Concise introduction]

[40–60-word direct answer as a plain paragraph — no heading, title, or label]

## Family Profile

[Clean two-column HTML-compatible table containing supported facts only]

## [First Relevant H2 Heading]

[Well-researched original paragraphs with natural contextual source links]

## [Second Relevant H2 Heading]

[Well-researched original paragraphs]

## [Additional Relevant H2 Headings]

[Continue with useful, verified, non-repetitive content]

### [H3 Subheading When Helpful]

[Relevant supporting paragraphs]

## Conclusion

[Concise evidence-based conclusion]

## Frequently Asked Questions

### 1. [Short, relevant question]

[One-sentence factual answer; ideally 10–20 words]

### 2. [Short, relevant question]

[One-sentence factual answer; ideally 10–20 words]

### 3. [Short, relevant question]

[One-sentence factual answer; ideally 10–20 words]

### 4. [Short, relevant question]

[One-sentence factual answer; ideally 10–20 words]

### 5. [Short, relevant question]

[One-sentence factual answer; ideally 10–20 words]

# 17. FINAL OUTPUT INSTRUCTIONS

Write the entire article in fluent {{language_variant}}.

Use clean Markdown headings and paragraphs suitable for direct editing in Canva Docs or publishing in WordPress.

Use a proper HTML \`<table>\` with \`<thead>\` and \`<tbody>\` for the family profile table.

Place external links naturally within relevant paragraphs.

Do not include the research process, internal audit, planning notes, keyword density calculations, or AI self-assessment in the finished article.

Do not display the internal fact-checking checklist.

**Never print “Featured Snippet,” “Quick Answer,” or any other heading for the standalone answer paragraph. Keep FAQ answers short and direct.**

If critical source verification is unavailable, disclose that limitation clearly rather than presenting unverified research as complete.

Avoid code fences around the finished article.

Do not append unrelated recommendations, commentary, or promotional text after the FAQs.

---

# NON-NEGOTIABLE FINAL STANDARD

The article must be:

**Research-driven. Factually accurate. Original. Naturally written. Search-intent-focused. Properly sourced. Privacy-conscious. SEO-optimized. Editorially polished.**

The purpose is not to manufacture a long biography from limited information.

The purpose is to produce the **most useful and trustworthy article that the available evidence can support**.

When facts are incomplete, follow this sequence:

**Verified information → relevant context → necessary clarification.**

Never replace missing evidence with assumptions.

Never replace research with confident-sounding prose.

Never weaken accuracy merely to eliminate words such as "unconfirmed."

Never increase length through repetitive statements, unsupported personal details, or invented biographical history.

**Final instruction: Research first, verify the premise, write the article, validate accuracy and SEO, then output the polished publication-ready result.**

[give bio table in bio table format not in code form] [give the article in canva format]`;
