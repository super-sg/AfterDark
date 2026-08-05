'use strict';

/**
 * Seeds boards, a staff account and a starter set of threads.
 *
 * Idempotent: re-running tops the site up rather than duplicating it. Pass
 * --reset to wipe content first (boards and users included).
 */

require('../src/env');

const { db } = require('../src/db');
const store = require('../src/store');
const { hashPassword } = require('../src/auth');

const RESET = process.argv.includes('--reset');

if (RESET) {
  db.exec(`
    DELETE FROM votes; DELETE FROM comments; DELETE FROM posts;
    DELETE FROM reports; DELETE FROM mod_actions;
    DELETE FROM board_subs; DELETE FROM sessions;
    DELETE FROM boards; DELETE FROM users;
  `);
  console.log('reset: content cleared');
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

const BOARDS = [
  {
    slug: 'newsroom',
    name: 'The Newsroom',
    kind: 'news',
    accent: '#ff5c7a',
    sortOrder: 1,
    tagline: 'Staff-written reporting on the adult industry',
    description:
      'Original reporting and edited summaries covering the adult entertainment industry: regulation, platforms, labour, money and technology. Comments are open on every story.',
    rules: [
      'Stories are staff-published; anyone can comment.',
      'Corrections are welcome — reply with a source and a mod will amend.',
      'No content involving minors, ever. Instant permanent ban.',
    ],
  },
  {
    slug: 'business',
    name: 'Trade Wire',
    kind: 'news',
    accent: '#f5a524',
    sortOrder: 2,
    tagline: 'Headlines pulled from the trade press',
    description:
      'Aggregated headlines from industry trade publications. Headline, source and link only — click through to read the publisher.',
    rules: ['Wire items link out; read and discuss at the source.', 'Flag anything mis-attributed.'],
  },
  {
    slug: 'policy',
    name: 'Law & Policy',
    kind: 'news',
    accent: '#7c9cff',
    sortOrder: 3,
    tagline: 'Age verification, obscenity law, platform regulation',
    description:
      'Legislation, court rulings and regulator action affecting adult media worldwide — US state AV laws, the UK Online Safety Act, EU DSA, payment-processor policy.',
    rules: ['Cite the bill, ruling or regulator document.', 'Legal opinion is not legal advice.'],
  },
  {
    slug: 'discussion',
    name: 'Open Floor',
    kind: 'discussion',
    accent: '#e0245e',
    sortOrder: 4,
    tagline: 'General discussion',
    description:
      'The general board. Media criticism, industry chatter, questions, opinions. Text discussion only — this is not a place to host or trade media.',
    rules: [
      'Discussion, not distribution. No links to pirated or non-consensual material.',
      'No personal information about anyone, performers included.',
      'Argue with the post, not the poster.',
    ],
  },
  {
    slug: 'industry',
    name: 'Inside the Industry',
    kind: 'discussion',
    accent: '#22c55e',
    sortOrder: 5,
    tagline: 'Production, distribution, studios, contracts',
    description:
      'How the business actually works: studio economics, distribution deals, contract terms, tube-site relationships, revenue splits.',
    rules: ['No naming private individuals who are not public figures.', 'Rumour must be labelled as rumour.'],
  },
  {
    slug: 'creators',
    name: 'Creator Desk',
    kind: 'discussion',
    accent: '#a855f7',
    sortOrder: 6,
    tagline: 'Independent creators: platforms, payouts, safety',
    description:
      'For people who make the work. Platform comparisons, payout and chargeback problems, tax, security, burnout, leaving the industry.',
    rules: [
      'No self-promotion, no traffic trading, no links to your own paid pages.',
      'Do not ask creators to identify themselves.',
      'Scam warnings need evidence.',
    ],
  },
  {
    slug: 'ethics',
    name: 'Consent & Labour',
    kind: 'discussion',
    accent: '#14b8a6',
    sortOrder: 7,
    tagline: 'Consent, working conditions, harm reduction',
    description:
      'Consent standards, on-set conditions, unionisation, health and testing protocols, content-removal rights, and the research literature on all of it.',
    rules: [
      'Survivor accounts are welcome; do not interrogate them.',
      'Report, do not repost, non-consensual material.',
      'Evidence beats vibes — link the study.',
    ],
  },
  {
    slug: 'tech',
    name: 'Platform & Tech',
    kind: 'discussion',
    accent: '#38bdf8',
    sortOrder: 8,
    tagline: 'Streaming, moderation systems, AI, piracy',
    description:
      'The technical layer: CDNs and streaming, recommendation systems, moderation tooling, age-assurance implementations, generative AI, DMCA and piracy enforcement.',
    rules: ['No piracy tooling or link dumps.', 'Security disclosures go to the vendor first.'],
  },
  {
    slug: 'videos',
    name: 'The Reel',
    kind: 'news',
    accent: '#f43f5e',
    sortOrder: 4,
    nsfw: true,
    tagline: 'What is being watched this week, pulled from the tube sites',
    description:
      'Trending scenes as reported by the platforms themselves — title, thumbnail, runtime, view count and a link. Nothing is hosted or mirrored here; every item plays on the publisher that made it. Thumbnails are blurred until you choose to see them.',
    rules: [
      'Links out only. Nothing is hosted here.',
      'Report anything that looks non-consensual or misattributed — it goes to a human.',
      'Discuss the work; do not post personal information about anyone in it.',
    ],
  },
  {
    slug: 'jav',
    name: 'JAV Desk',
    kind: 'discussion',
    accent: '#ef4444',
    sortOrder: 10,
    tagline: 'Japanese adult video: industry, releases, subtitles, law',
    description:
      'The JAV industry and its coverage: studios and labels, release news, the 2022 AV Appearance Damage Prevention Act and its aftermath, subtitling, distribution and import questions.',
    rules: [
      'Discussion and news. No file links, no torrent or magnet dumps, no "sauce" requests.',
      'Performer welfare and consent reporting is on-topic and taken seriously.',
      'Romanise names where you can — it helps search.',
    ],
  },
  {
    slug: 'hentai',
    name: 'Hentai & Ero-Anime',
    kind: 'discussion',
    accent: '#d946ef',
    sortOrder: 11,
    tagline: 'Adult animation, doujin, eroge — industry and criticism',
    description:
      'Adult animation and games as a business and a medium: studios and OVA production, doujin economics, eroge and visual-novel localisation, censorship and platform policy, and criticism of the work itself.',
    rules: [
      'All characters depicted must be adults. Loli/shota content is an instant permanent ban.',
      'No file links, no trading, no rips. Talk about it; do not distribute it.',
      'Tag spoilers for anything released in the last month.',
    ],
  },
  {
    slug: 'meta',
    name: 'Meta',
    kind: 'discussion',
    accent: '#94a3b8',
    sortOrder: 12,
    tagline: 'About AfterDark itself',
    description: 'Site feedback, moderation appeals, feature requests, rule changes.',
    rules: ['Appeals get one thread each.', 'Bug reports: say what you did and what happened.'],
  },
];

for (const b of BOARDS) {
  if (store.boards.bySlug(b.slug)) {
    // Re-running the seed should bring an existing install's copy, ordering and
    // NSFW flag up to date — not silently leave it on the old definition.
    store.boards.update(b.slug, b);
  } else {
    store.boards.create(b);
    console.log(`board: +${b.slug}`);
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const SEED_PASSWORD = process.env.SEED_PASSWORD || 'afterdark-demo-2026';

const ACCOUNTS = [
  ['admin', 'admin', 'Site admin. Rules questions and appeals: post in Meta.'],
  ['newsdesk', 'mod', 'AfterDark editorial account. Tips welcome.'],
  ['clause_and_effect', 'user', 'Reads bills so you do not have to.'],
  ['gaffer_tape', 'user', 'Fifteen years on set, mostly holding a light.'],
  ['chargeback_queen', 'user', 'Independent creator. Payments are my villain origin story.'],
  ['ctrl_alt_defeat', 'user', 'Backend engineer, formerly at a tube site.'],
  ['margin_call', 'user', 'Follows the money.'],
  ['red_flagged', 'user', 'Moderation nerd. Ask me about hash matching.'],
  ['second_camera', 'user', 'Documentary background. Here for the labour threads.'],
  ['quietriot', 'user', 'Lurker who occasionally has opinions.'],
];

const userIds = {};
for (const [username, role, bio] of ACCOUNTS) {
  let existing = store.users.byUsername(username);
  if (!existing) {
    const id = store.users.create(username, hashPassword(SEED_PASSWORD), role);
    store.users.updateBio(id, bio);
    existing = { id };
    console.log(`user: +${username} (${role})`);
  }
  userIds[username] = existing.id;
  for (const slug of ['newsroom', 'discussion', 'industry', 'policy']) {
    const board = store.boards.bySlug(slug);
    try {
      if (board) store.boards.subscribe(existing.id, board.id);
    } catch { /* already subscribed */ }
  }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const HOUR = 3600e3;
const DAY = 86400e3;

const THREADS = [
  {
    board: 'newsroom',
    author: 'newsdesk',
    age: 4 * HOUR,
    flair: 'Analysis',
    title: 'Twenty-six states now require age verification — the compliance map has stopped making sense',
    body: `Since the Supreme Court upheld Texas HB 1181 in June 2025, state age-verification requirements have gone from a regional oddity to the default operating condition for anyone publishing adult material in the United States.

The problem is not that verification is required. It is that no two statutes require the same thing.

**Where the thresholds diverge.** Most states use a "substantial portion" test set at one third of a site's content. Kansas sets it at a quarter. Several states apply the duty to any site that "knowingly publishes" qualifying material with no threshold at all, which on a plain reading sweeps in general-purpose forums that host a single qualifying thread.

**Where liability lands.** Louisiana's Act 440 provides civil penalties reaching five figures per day. Arizona allows a court to reach a quarter of a million dollars where a minor actually obtained access. Others route enforcement through the state attorney general, others through a private right of action — which means the compliance question is not only "will a regulator act" but "can any resident sue".

**What counts as verification.** Self-declaration is nowhere near sufficient. Transactional data, government ID with liveness, or a third-party attestation are the recognised methods. The UK's Online Safety Act uses the phrase "highly effective age assurance" and Ofcom has been explicit that a checkbox does not qualify.

**The practical result** is that mid-sized publishers are geoblocking. That is not a policy win for anyone: traffic does not disappear, it moves to operators outside any enforcement reach, which is precisely the population least likely to run consent documentation or content-removal processes.

Discussion below. If you run a site and have been through an implementation, the community would benefit from hearing what it actually cost.`,
    comments: [
      {
        author: 'clause_and_effect',
        body: 'The "substantial portion" test is the part that should worry general forums. It was drafted with tube sites in mind and it reads onto anything with a mixed feed. Until a court draws the line, a discussion board with an adult section is guessing.',
        replies: [
          { author: 'red_flagged', body: 'We took the conservative reading and gated the whole site. Losing the crawler traffic hurt, but the alternative was arguing about it with an AG.' },
          { author: 'margin_call', body: 'Conservative reading is also the cheap reading. One gate at the edge beats per-section logic you have to defend later.' },
        ],
      },
      {
        author: 'ctrl_alt_defeat',
        body: 'Implementation notes from doing this at a mid-size platform: budget for the drop-off, not the integration. The vendor work was about three weeks. The conversion loss on first-time visitors was 60-70% and it never fully recovered.',
        replies: [
          { author: 'chargeback_queen', body: 'That matches what independents saw. The people who complete a verification flow are the ones already paying you. Discovery basically stops.' },
        ],
      },
      { author: 'second_camera', body: 'Worth noting the displacement effect is measurable now, not theoretical. VPN sign-ups spike in each state the week its law takes effect. Every study of this has found the same thing.' },
    ],
  },
  {
    board: 'policy',
    author: 'clause_and_effect',
    age: 11 * HOUR,
    flair: 'Explainer',
    title: 'Ofcom vs the FTC: two regulators, two completely different theories of what a platform owes you',
    body: `Reading the UK and US approaches side by side is instructive because they are not disagreeing about facts, they are disagreeing about who the duty runs to.

**Ofcom (Online Safety Act)** treats the platform as owing a *systems* duty. You are not judged on whether a particular minor got through; you are judged on whether your access controls are proportionate, documented and reviewed. The register of risk assessments matters as much as the gate itself. Penalties reach 10% of global revenue.

**The US state statutes** treat this as a *transactional* duty. Did you verify this user before serving this content? The record you need is per-access, not per-system. That is a much simpler thing to litigate and a much harder thing to build without retaining exactly the data everyone agrees you should not retain.

The retention conflict is the real story and almost nobody covers it. A per-access duty pushes you toward keeping verification records. Every privacy regime in the world, and several of the same states' own data laws, push you toward keeping nothing. Double-blind attestation via a third party is the only design that satisfies both, and it is the design least likely to survive a subpoena unaltered.`,
    comments: [
      { author: 'red_flagged', body: 'The systems-duty framing is genuinely better engineering policy. You can build to it. A per-access rule just produces a compliance theatre log that becomes a breach liability.' },
      {
        author: 'ctrl_alt_defeat',
        body: 'Double-blind works right up until someone asks the attestation provider for their logs. "We only store a token" is true until discovery asks what the token is derived from.',
        replies: [{ author: 'clause_and_effect', body: 'Which is why the good implementations derive it from something the provider itself cannot reverse. Very few of them do.' }],
      },
    ],
  },
  {
    board: 'creators',
    author: 'chargeback_queen',
    age: 20 * HOUR,
    flair: 'PSA',
    title: 'Payout hold patterns: what I have learned after four platforms and one very bad quarter',
    body: `Posting this because I keep seeing the same panic thread and the answers are always "contact support", which is not an answer.

**What actually triggers a hold, in rough order of frequency:**

1. A chargeback rate over roughly 1% in a rolling window. Not per month — rolling. One bad weekend can put you over.
2. A sudden revenue jump. Growth looks identical to fraud in an automated risk model. If you have a viral week, expect a review.
3. Payout-method changes. Changing your bank details resets several platforms' trust clocks by 7–30 days.
4. Mismatched KYC. A legal name change that never made it to the platform will silently freeze everything.

**What helps:**

- Keep the chargeback rate visible to yourself. Most dashboards bury it. Check it weekly.
- Respond to every dispute with evidence, even the ones you will lose. Response rate is itself a risk-model input.
- Never change payout details and pricing in the same week.
- Keep three months of expenses somewhere that is not a platform balance. This is the entire lesson, honestly.

**What does not help:** escalating publicly. Every creator who has tried it has told me the same thing — it moves you to a different queue, not a faster one.

Happy to answer specifics. I am not going to name platforms in the post because the pattern is universal, but I will in comments where I have receipts.`,
    comments: [
      {
        author: 'margin_call',
        body: 'The rolling-window detail is the one people miss. It is also why the "just refund everyone who complains" advice backfires — voluntary refunds do not reduce a chargeback rate that already booked.',
        replies: [
          { author: 'chargeback_queen', body: 'Correct, and worse: on two of the four, a voluntary refund inside the dispute window still counts. You eat it twice.' },
          { author: 'quietriot', body: 'This thread should be pinned somewhere permanent. I lost a month of income to reason 3 and had no idea it was a category.' },
        ],
      },
      { author: 'gaffer_tape', body: 'Studio side has the same dynamic with distributors, just slower. Nobody tells you the trust clock exists until you reset it.' },
      { author: 'second_camera', body: 'Three months of runway off-platform is the single most repeated piece of advice from everyone who has been doing this for a decade, and it is still the least followed.' },
    ],
  },
  {
    board: 'tech',
    author: 'ctrl_alt_defeat',
    age: 30 * HOUR,
    flair: 'Technical',
    title: 'How synthetic media broke every takedown workflow that was designed for copies',
    body: `Content moderation for adult platforms was built on one assumption: the thing you are removing exists somewhere else first, and you can match it.

Perceptual hashing works because a re-encode, a crop and a watermark all leave enough structure to match against a known-bad hash. That is the entire foundation of PhotoDNA-style pipelines and it works remarkably well against redistribution.

Generated material breaks it at the root. There is no first copy to hash. Two generations from the same prompt do not match each other. Take-down-once-and-it-stays-down becomes take-down-forever, and the volume is bounded only by GPU time.

**What is actually being tried:**

- *Provenance signing* (C2PA and friends). Solves attribution for compliant producers, does nothing about non-compliant ones. Useful, oversold.
- *Detector models.* Accuracy falls off a cliff every time generators improve. Any published benchmark is stale within two model generations.
- *Identity-side matching* — hash the face, not the file. Technically the most effective and by a distance the most dangerous thing to build. A working database of "find every image of this person" is exactly the tool you would not want to exist, regardless of who runs it first.

The honest position is that the takedown model does not survive this and the remedy is shifting to the distribution layer — payment, hosting and discovery — rather than the file. Which is a policy answer wearing an engineering costume, and everyone in the field knows it.`,
    comments: [
      { author: 'red_flagged', body: 'Identity-side matching is the one that keeps me up. The victim-protection case for it is genuinely strong. So is every abuse case. There is no version where only the good actors have it.' },
      {
        author: 'clause_and_effect',
        body: 'Several jurisdictions have now written non-consensual synthetic media into statute with a takedown-window requirement. Nobody drafting those clauses asked whether the matching technology to comply exists.',
        replies: [{ author: 'ctrl_alt_defeat', body: 'It does not, at the accuracy the statutes imply. What exists is a process that produces a compliance record.' }],
      },
      { author: 'second_camera', body: 'Distribution-layer enforcement is where this lands, and the industry should say so out loud rather than let regulators discover it in three years.' },
    ],
  },
  {
    board: 'ethics',
    author: 'second_camera',
    age: 2 * DAY,
    flair: 'Discussion',
    title: 'Consent documentation has improved enormously. Content removal rights have not.',
    body: `Give the industry credit where it is due: pre-shoot consent paperwork on legitimate productions is dramatically better than it was fifteen years ago. Scene-specific consent, documented limits, an on-set contact who is not the director. That is real progress and it came largely from performers organising for it.

The gap that has not closed is what happens afterwards.

A performer who wants their work removed generally cannot get it removed. The rights were assigned in perpetuity, the material has been syndicated across licensees, and the practical remedy is a DMCA process they do not control against a distribution network they cannot see. "I consented to filming" and "I consent to this existing forever" were collapsed into one signature.

Some studios have started offering time-limited licences and post-hoc withdrawal windows. It is a small number and it is mostly the ones who were already good.

**The question worth arguing about:** is there a workable version of a withdrawal right that does not simply destroy the economics of licensing? Music has term reversion. Publishing has out-of-print clauses. Neither industry collapsed.

I do not think "it would be commercially difficult" is a sufficient answer here, but I also do not think the people proposing a blanket right have costed it.`,
    comments: [
      {
        author: 'gaffer_tape',
        body: 'Reversion after a term is the version that could actually pass. Studios amortise a scene within a couple of years. A ten-year reversion costs the honest ones close to nothing and gives performers something real.',
        replies: [
          { author: 'margin_call', body: 'Ten years is roughly right on the numbers. The revenue curve on a scene is brutal — most of it lands in the first eighteen months.' },
          { author: 'second_camera', body: 'If that is true, and I think it is, then the resistance is not economic. It is about not wanting to set the precedent.' },
        ],
      },
      { author: 'chargeback_queen', body: 'Independent side has the opposite problem — I own everything and still cannot get it off the tube sites. Rights without enforcement are a hobby.' },
      { author: 'quietriot', body: 'The collapse of "consent to film" and "consent to distribute forever" into one signature is the clearest framing of this I have read.' },
    ],
  },
  {
    board: 'industry',
    author: 'margin_call',
    age: 3 * DAY,
    flair: 'Analysis',
    title: 'The subscription platforms did not disrupt the studios. They disrupted the middle.',
    body: `The common story is that creator platforms replaced studio production. The numbers do not support it.

Top-end studio production is still there, is still expensive, and still commands licensing. What has been hollowed out is everything between: the mid-tier producers, the regional distributors, the DVD-era catalogue houses, the aggregators who existed to move inventory between them.

This is the same shape that hit music and journalism. Direct-to-audience does not kill the expensive top of a market; it kills the intermediaries whose function was distribution.

**What that means practically:**

- Performer income distribution got *more* unequal, not less. A platform where discovery is the constraint concentrates income at the top harder than a studio system with day rates.
- The floor fell out of mid-tier day rates because the mid-tier buyers are gone.
- Studios that survived did it by becoming licensors and brand-holders rather than producers.
- The genuinely new money is in the platform layer — payments, hosting, discovery — not in production at all.

The uncomfortable version: for the median performer, "be your own studio" transferred the business risk without transferring the business infrastructure.`,
    comments: [
      { author: 'chargeback_queen', body: 'Transferred the risk without the infrastructure is exactly it. I am my own producer, accountant, marketer, and legal department, and the platform takes 20% for hosting.' },
      {
        author: 'gaffer_tape',
        body: 'Crew side confirms the mid-tier collapse. The work that vanished was the steady mid-budget stuff. What is left is a handful of big productions and a lot of two-person shoots that do not hire crew at all.',
        replies: [{ author: 'second_camera', body: 'And the two-person shoots are where the safety practices that took fifteen years to build quietly stopped being standard.' }],
      },
      { author: 'ctrl_alt_defeat', body: 'Discovery being the constraint is underrated here. The algorithm is the new distributor, and it has worse terms than the old ones.' },
    ],
  },
  {
    board: 'discussion',
    author: 'quietriot',
    age: 5 * HOUR,
    flair: 'Question',
    title: 'What is the strongest argument against your own position on this industry?',
    body: `Genuine question, not a gotcha. Threads here tend to sort into two camps quickly and I think most of us could state the other side better than we do.

I will start. My position is broadly that consenting adults making and watching adult media is fine and the harms are concentrated in specific fixable practices rather than the medium.

The strongest argument against it that I have not fully answered: consent at the point of filming is not consent to the distribution system that exists downstream, and an industry where the exit costs are this high and the removal rights this weak cannot really claim its participation is freely given in the way the defence requires. "They agreed" does a lot of work in my position and I am not sure it holds all of it.

Your turn. Steelman the side you are not on.`,
    comments: [
      {
        author: 'red_flagged',
        body: 'I moderate this stuff, so my position is that better systems fix most of it. The argument I cannot answer: every moderation system I have built is an enormous surveillance apparatus that happens to be pointed somewhere sympathetic. I am one policy change away from having built the wrong thing.',
        replies: [{ author: 'ctrl_alt_defeat', body: 'This is the honest version of working in trust and safety and almost nobody says it publicly.' }],
      },
      { author: 'gaffer_tape', body: 'I am pro-industry, I work in it. The argument I struggle with is that the practices I point to as evidence it is fine are the ones on productions like mine, and I have no idea what fraction of total output that is. Probably small.' },
      { author: 'clause_and_effect', body: 'I am anti-regulation-by-obscenity-law. Steelman against me: the alternative I propose is industry self-governance, and self-governance has failed in every comparable sector without a statutory backstop.' },
      { author: 'margin_call', body: 'Refreshing thread. Most of these turn into position statements by comment four.' },
    ],
  },
  {
    board: 'meta',
    author: 'admin',
    age: 6 * DAY,
    pinned: true,
    flair: 'Rules',
    title: 'Read this first: what AfterDark is, and the three lines that get you removed instantly',
    body: `**What this is.** A discussion board and newsroom about the adult industry. Text discussion, industry reporting, policy, labour, technology and criticism.

**What this is not.** A place to host, link to, request or trade explicit media. There is no media hosting here and there will not be. If you are looking for content, this is the wrong site.

**The three instant-removal lines.** These are not warnings and there is no appeal:

1. Any sexual content or discussion involving minors, in any form, real or drawn or generated.
2. Non-consensual material — leaks, hidden-camera footage, or synthetic media of a real person made without their consent — including requests for it.
3. Personal information about anyone. Legal names of performers who work under a stage name, addresses, workplaces, family. This applies to people you like as well as people you do not.

**Everything else** is handled by ordinary moderation: be civil, argue with the argument, no spam, no self-promotion, use the report button rather than starting a second thread about it.

**Age.** This site is for adults. See the notice in the footer about how age assurance is configured for this deployment.

**Appeals** go in one thread each, here in Meta. Include what happened and what you think should have happened.`,
    comments: [
      { author: 'red_flagged', body: 'Reporting works better than replying. A report goes to a queue a human reads; a reply just gives the post engagement.' },
      { author: 'quietriot', body: 'The "this applies to people you like" line on rule 3 is a good addition. Doxxing gets excused constantly when the target is unpopular.' },
    ],
  },
  {
    board: 'newsroom',
    author: 'newsdesk',
    age: 26 * HOUR,
    flair: 'Report',
    title: 'Payment processors are quietly setting content policy again — and nobody voted for them',
    body: `The most consequential content rules in the adult industry are not written by legislators or platforms. They are written into card-network risk categories and enforced by acquiring banks who would rather not have the account at all.

The pattern repeats every few years: a network updates its high-risk merchant requirements, acquirers over-comply because the penalty for under-complying is losing the network relationship, and platforms rewrite their content policies in a week to keep processing. The public explanation is always a platform decision. It rarely is.

**What has changed in this round:**

- Documentation requirements now reach *uploader identity verification for every participant in a scene*, not just the account holder. Several platforms have had to retro-fit consent records for archives going back a decade, and material without complete records is being removed rather than documented.
- Chargeback thresholds for the category have tightened, which pushes platforms toward larger minimum transaction sizes and away from the micro-payment models independents rely on.
- Some acquirers have begun applying the adult category to *discussion* platforms with no media at all, on the grounds that the category is defined by subject matter.

That last one should worry anyone running a forum. The category test is not what you host, it is what you are about.

**Why this is hard to report on:** almost every source is under an NDA with an acquirer, and the networks do not publish the relevant bulletins. What is public is the downstream effect — policy changes that appear simultaneously across unrelated platforms.`,
    comments: [
      {
        author: 'margin_call',
        body: 'Simultaneous policy changes across competitors is the tell. Companies do not independently arrive at the same rewrite in the same fortnight.',
        replies: [{ author: 'newsdesk', body: 'That is essentially the whole method for reporting this beat. You cannot get the bulletin, so you date the diffs.' }],
      },
      { author: 'chargeback_queen', body: 'Minimum transaction size is the part that hits independents hardest and gets the least coverage. My $3 tier stopped being viable and it was 40% of my subscribers.' },
      { author: 'clause_and_effect', body: 'Private regulation by risk category, with no notice-and-comment and no appeal. If a government did this there would be a constitutional case.' },
      { author: 'red_flagged', body: 'The discussion-platform expansion is real. We are not adult by content and got categorised as adult by topic. Took four months to find an acquirer who would look at it.' },
    ],
  },
  {
    board: 'tech',
    author: 'red_flagged',
    age: 4 * DAY,
    flair: 'Technical',
    title: 'What a moderation stack for a text-only adult forum actually looks like in 2026',
    body: `Since a few people asked in the other thread, here is the honest architecture. This is for a text discussion site — a media-hosting platform is a completely different and much larger problem.

**Layer 1 — submission-time hard blocks.** A small set of high-precision patterns for the categories that are never acceptable. Tuned for precision, not recall: false positives on this layer are extremely expensive because they train users to rephrase until they get through, which is the opposite of what you want. Anything caught here is rejected at submission and logged.

**Layer 2 — soft flags into a queue.** Contact details, off-platform solicitation, link dumps, obvious spam shapes. These post normally and land in a human queue. Roughly 2-4% of submissions in practice.

**Layer 3 — user reports.** Still the highest-signal input by a wide margin. Everything automated combined does not beat a moderately engaged user base with a working report button.

**Layer 4 — rate and reputation limits.** Most abuse is volume abuse. Per-account action limits, new-account restrictions, and a karma threshold on certain boards remove more bad content than any classifier.

**What I deliberately do not do:** no LLM classifier in the submission path. Latency is bad, cost scales with abuse volume rather than legitimate volume, and prompt injection in user-submitted text is an unsolved problem. Use it offline for queue triage if at all.

**On CSAM specifically:** if you host any images at all, you are legally obliged to have a reporting relationship with the relevant authority in your jurisdiction, and you should be running hash matching. Do not build this yourself. For text-only, the hard block layer plus a fast human escalation path is the practical answer.`,
    comments: [
      { author: 'ctrl_alt_defeat', body: 'Precision over recall on layer 1 is the counter-intuitive one. Every team learns it by shipping an aggressive filter and watching users speedrun around it within a day.' },
      {
        author: 'quietriot',
        body: 'The report button being the best signal matches everything I have read about it. Which means the moderation problem is really a community-health problem wearing a technical hat.',
        replies: [{ author: 'red_flagged', body: 'Yes. A site where users do not bother reporting has a much worse moderation problem than one with a bad classifier.' }],
      },
      { author: 'second_camera', body: 'Appreciate the "do not build this yourself" on hash matching. A lot of small operators genuinely do not know the reporting obligation exists.' },
    ],
  },
];

const stmtBackdatePost = db.prepare(
  'UPDATE posts SET created_at = ?, published_at = ?, ups = ?, score = ?, hot = hot_rank(?, ?) WHERE id = ?'
);
const stmtBackdateComment = db.prepare(
  'UPDATE comments SET created_at = ?, ups = ?, score = ?, confidence = ? WHERE id = ?'
);

const { confidence } = require('../src/ranking');

// Deterministic pseudo-randomness so re-seeding produces a stable-looking site.
let seedState = 1337;
const rnd = () => {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
};
const between = (lo, hi) => Math.floor(lo + rnd() * (hi - lo));

let created = 0;

for (const t of THREADS) {
  const board = store.boards.bySlug(t.board);
  if (!board) continue;

  const existing = db
    .prepare('SELECT id FROM posts WHERE title = ? AND board_id = ?')
    .get(t.title, board.id);
  if (existing) continue;

  const createdAt = Date.now() - t.age;
  const postId = store.posts.create({
    boardId: board.id,
    authorId: userIds[t.author],
    kind: 'text',
    title: t.title,
    body: t.body,
    flair: t.flair || '',
  });

  const ups = between(40, 900);
  stmtBackdatePost.run(createdAt, createdAt, ups, ups, ups, createdAt, postId);
  if (t.pinned) store.posts.setPinned(postId, true);

  const addComments = (list, parentId, baseTime) => {
    for (const c of list) {
      const id = store.comments.create({
        postId,
        parentId,
        authorId: userIds[c.author],
        body: c.body,
      });
      const at = baseTime + between(5 * 60e3, 4 * HOUR);
      const cUps = between(3, 220);
      const cDowns = between(0, Math.max(1, Math.floor(cUps / 12)));
      stmtBackdateComment.run(at, cUps, cUps - cDowns, confidence(cUps, cDowns), id);
      if (c.replies) addComments(c.replies, id, at);
    }
  };
  addComments(t.comments || [], null, createdAt);

  // Spread votes around so scores are not all author-only.
  const voters = Object.values(userIds);
  for (const voterId of voters) {
    if (rnd() > 0.55) continue;
    try {
      store.votes.cast({ userId: voterId, targetType: 'post', targetId: postId, value: rnd() > 0.15 ? 1 : -1 });
    } catch { /* self-vote already recorded */ }
  }

  created++;
  console.log(`thread: +${t.board}/${t.title.slice(0, 60)}…`);
}

require('../src/db').reheatRecentPosts();

console.log(`\nseeded. ${created} new threads, ${store.users.count()} users, ${store.boards.all().length} boards.`);
if (created || RESET) {
  console.log(`demo accounts use password: ${SEED_PASSWORD}`);
  console.log('sign in as "admin" for moderator tools.');
}
