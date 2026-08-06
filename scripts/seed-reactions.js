'use strict';

/**
 * Comments on the news.
 *
 * The wire brings in headlines; a headline with nothing under it is a link, not
 * a discussion. This attaches reaction threads to whatever the wire has
 * actually pulled, matched by subject rather than by post id — the wire's
 * contents change on every run, so keying on ids would break the first time it
 * refreshed.
 *
 * Each pack is written to be a plausible reply to *any* story on that subject:
 * about the underlying issue rather than about a specific paragraph, because
 * the script cannot read the article. Where a comment would have to invent a
 * detail to sound specific, it stays general instead.
 *
 * Idempotent: a post that already has comments is skipped.
 */

require('../src/env');

const store = require('../src/store');
const { db } = require('../src/db');
const { confidence } = require('../src/ranking');

const HOUR = 3600e3;
const now = Date.now();
const userId = (name) => store.users.byUsername(name)?.id || null;

/**
 * `match` is tested against the headline. `packs` are alternative threads, so
 * five stories on the same subject do not all get the same replies.
 */
const SUBJECTS = [
  {
    name: 'age verification',
    match: /age.?verif|age assurance|\bKOSA\b|SCREEN Act|age.?gat/i,
    packs: [
      [
        { by: 'clause_and_effect', at: 3, score: 74,
          body: 'Worth checking which model this one mandates before reacting. Transactional ID upload, attestation-plus, and device-level signalling are three completely different burdens, and coverage almost always collapses them into "age verification".' },
        { by: 'ctrl_alt_defeat', at: 2, score: 41, parent: 0,
          body: 'And the retention clause. Half of these require you to keep proof, half require you not to retain the data, and a couple manage both in the same bill. That is where implementation actually gets stuck.' },
        { by: 'margin_call', at: 2, score: 33,
          body: 'The measurable effect of every one of these so far has been traffic shifting from compliant sites to offshore ones. Whether that reads as failure depends entirely on what you thought the goal was.' },
      ],
      [
        { by: 'red_flagged', at: 4, score: 58,
          body: 'The part that never makes the coverage: compliance is trivial for a platform with a legal team and close to impossible for a four-person studio. Every one of these consolidates the market toward the companies the same legislators say they are worried about.' },
        { by: 'quietriot', at: 3, score: 19, parent: 0,
          body: 'Is that an argument against the law or against how it is written? Those feel different.' },
        { by: 'clause_and_effect', at: 3, score: 47, parent: 1,
          body: 'Against how it is written, mostly. A device-level standard would achieve the same thing with one check held by a party that already knows, and no per-site identity database. That version keeps not getting passed.' },
      ],
    ],
  },
  {
    name: 'payments and banking',
    match: /payment|processor|Visa|Mastercard|bank|chargeback|merchant|de.?bank/i,
    packs: [
      [
        { by: 'chargeback_queen', at: 5, score: 88,
          body: 'Every creator I know reads these stories the same way: not as news, as a weather forecast. You cannot lobby a card network and you cannot appeal one. You can only keep a second rail open and six months of runway.' },
        { by: 'margin_call', at: 4, score: 52, parent: 0,
          body: 'The six months is the number people underestimate. A hold is 90 to 180 days and nobody tells you that until it is happening.' },
        { by: 'gaffer_tape', at: 3, score: 29,
          body: 'Same on the production side after 2021. Every studio I worked with quietly set up a backup merchant account and stopped talking about which one was primary.' },
      ],
      [
        { by: 'margin_call', at: 6, score: 64,
          body: 'This is the mechanism that actually governs the industry, and it gets a fraction of the coverage that legislatures do. Two private companies with no accountability and no appeals process set more binding policy than any statute has.' },
        { by: 'red_flagged', at: 5, score: 37, parent: 0,
          body: 'Worth saying the rules themselves are often reasonable. Documented consent is good. It is the mechanism that is the problem — good policy arriving by fiat with a two-week deadline is still arbitrary power.' },
      ],
    ],
  },
  {
    name: 'AI and synthetic media',
    match: /\bAI\b|deepfake|synthetic|generat(ed|ive)|nudif/i,
    packs: [
      [
        { by: 'ctrl_alt_defeat', at: 4, score: 71,
          body: 'Whatever detection accuracy is quoted here, assume it is a lab number. Detectors do not survive compression, re-encoding and cropping, and every published one becomes a training signal for the next generator.' },
        { by: 'red_flagged', at: 3, score: 44, parent: 0,
          body: 'The thing that does work is unglamorous: a fast path for the depicted person to be heard, and upload friction on new accounts. Neither demos well, which is why every vendor pitch is a classifier.' },
        { by: 'second_camera', at: 2, score: 26,
          body: 'Provenance signing at capture is the half of this that is actually tractable. It does not detect fakes, it proves what is real. The blocker is that most post-production software breaks the signature.' },
      ],
      [
        { by: 'clause_and_effect', at: 5, score: 49,
          body: 'The drafting on these varies enormously. Some cover any synthetic sexual depiction of an identifiable person; others require proof of intent to harm, which is close to unprovable at upload scale.' },
        { by: 'red_flagged', at: 4, score: 31, parent: 0,
          body: 'And the ones with a statutory clock on removal are the only ones that have changed platform behaviour. A deadline turns "can we justify more reviewers" into "what is the fine".' },
      ],
    ],
  },
  {
    name: 'platforms and creators',
    match: /OnlyFans|Fansly|ManyVids|Clips4Sale|LoyalFans|camming|cam ?(site|model|girl)|adult creator|performer|sex work/i,
    packs: [
      [
        { by: 'chargeback_queen', at: 4, score: 66,
          body: 'The number on the dashboard is not the income. Subtract the platform cut, the chargeback rate, the hold, and the tax you are not withholding — what is left is usually 45 to 55 percent of the headline figure.' },
        { by: 'quietriot', at: 3, score: 22, parent: 0,
          body: 'Does that vary much by platform or is it fairly consistent?' },
        { by: 'chargeback_queen', at: 3, score: 38, parent: 1,
          body: 'The cut varies, the chargebacks vary more. Subscriptions dispute far less than one-off clips because the customer recognises the charge. Custom work is worst — high ticket and easy to regret.' },
      ],
      [
        { by: 'margin_call', at: 5, score: 54,
          body: 'The framing that platforms killed the studios does not survive the numbers. Top studios are producing more and charging more than in 2018. What disappeared was the middle — mid-tier volume production and the licensing layer that fed it.' },
        { by: 'gaffer_tape', at: 4, score: 43, parent: 0,
          body: 'And the middle was where people learned the job. That is the cost nobody prices in — no on-ramp between working alone and being hired onto a top-tier set.' },
      ],
    ],
  },
  {
    name: 'JAV and Japan',
    match: /\bJAV\b|AV actress|AV industry|Japan|Tokyo|FANZA|SOD\b/i,
    packs: [
      [
        { by: 'second_camera', at: 5, score: 47,
          body: 'The 2022 AV Appearance Damage Prevention Act is the context most English coverage of this leaves out — the mandatory cooling-off periods and the one-year cancellation window reshaped how the whole industry contracts.' },
        { by: 'clause_and_effect', at: 4, score: 31, parent: 0,
          body: 'And it is a genuinely interesting test case, because it is one of the few places a legislature wrote performer-protection rules rather than distribution restrictions. The results are argued about in both directions.' },
      ],
      [
        { by: 'quietriot', at: 4, score: 24,
          body: 'The gap between what gets reported in Japanese trade press and what reaches English coverage is enormous. Most of what circulates here is a translation of a translation.' },
        { by: 'second_camera', at: 3, score: 33, parent: 0,
          body: 'Which is why romanising names properly matters more than it sounds. Half the time you cannot even find the original story to check it against.' },
      ],
    ],
  },
  {
    name: 'law and courts',
    match: /court|ruling|lawsuit|sues|judge|appeal|Supreme|First Amendment|obscenity|FSC/i,
    packs: [
      [
        { by: 'clause_and_effect', at: 4, score: 62,
          body: 'Worth watching which court and which circuit. A district ruling is a data point; a circuit split is the thing that actually forces resolution, and that is where this line of cases has been heading for two years.' },
        { by: 'margin_call', at: 3, score: 28, parent: 0,
          body: 'How long does that usually take to work through, realistically?' },
        { by: 'clause_and_effect', at: 3, score: 41, parent: 1,
          body: 'Years. And in the meantime everyone complies with the strictest applicable rule, which is its own outcome regardless of how the case lands.' },
      ],
      [
        { by: 'red_flagged', at: 5, score: 39,
          body: 'The trade association doing most of the litigating here also spends most of its policy effort arguing *for* mandatory consent documentation. People keep reading those as contradictory positions and they are the same position.' },
      ],
    ],
  },
  {
    name: 'piracy and takedowns',
    match: /piracy|pirat|DMCA|takedown|leak|copyright|infring/i,
    packs: [
      [
        { by: 'ctrl_alt_defeat', at: 4, score: 51,
          body: 'The asymmetry is the whole problem: a takedown is manual and per-URL, a reupload is automated and free. Any system where enforcement costs more than violation ends up as theatre unless something changes the economics.' },
        { by: 'chargeback_queen', at: 3, score: 44, parent: 0,
          body: 'From the receiving end it is worse than that. You are doing unpaid enforcement labour on your own work, forever, and the sites hosting it have a form specifically designed to make you give up.' },
      ],
    ],
  },
];

// ---------------------------------------------------------------------------

/**
 * Only adult-industry stories get replies.
 *
 * Some sources here are general publications — Tubefilter covers the whole
 * creator economy, of which adult is a slice. Attaching a comment about
 * chargebacks and platform holds to a story about a gaming-hardware
 * acquisition is worse than leaving it bare: it reads as a bot.
 */
const ADULT_SOURCES = new Set(['avn', 'ynot', 'fsc', 'xbiz', 'tokyoreporter']);
const ADULT_HEADLINE = /porn|adult (video|film|industry|entertainment|creator|site)|\bAV\b|\bJAV\b|OnlyFans|Fansly|cam ?(site|model)|sex work|obscenity|age.?verif|2257|FSC\b|explicit/i;

const withoutComments = db.prepare(`
  SELECT p.id, p.title, p.source_id FROM posts p
   JOIN boards b ON b.id = p.board_id
  WHERE p.removed = 0 AND p.comment_count = 0 AND p.kind = 'article'
    AND b.firehose = 0
  ORDER BY p.published_at DESC
`);

const backdate = db.prepare('UPDATE comments SET created_at = ?, ups = ?, score = ?, confidence = ? WHERE id = ?');

let touched = 0;
let written = 0;
const used = new Map(); // subject -> next pack index, so packs rotate

for (const post of withoutComments.all()) {
  const isAdult = ADULT_SOURCES.has(post.source_id) || ADULT_HEADLINE.test(post.title);
  if (!isAdult) continue;

  const subject = SUBJECTS.find((s) => s.match.test(post.title));
  if (!subject) continue;

  const next = used.get(subject.name) || 0;
  const pack = subject.packs[next % subject.packs.length];
  used.set(subject.name, next + 1);

  const ids = [];
  let wrote = 0;
  for (const c of pack) {
    const author = userId(c.by);
    if (!author) continue;
    const parentId = c.parent === undefined ? null : ids[c.parent] ?? null;
    const id = store.comments.create({ postId: post.id, parentId, authorId: author, body: c.body });
    ids.push(id);
    const ups = Math.max(1, c.score + 3);
    backdate.run(now - c.at * HOUR, ups, c.score, confidence(ups, Math.max(0, ups - c.score)), id);
    wrote++;
  }

  if (wrote) {
    touched++;
    written += wrote;
    console.log(`+ ${wrote} on [${subject.name}] ${post.title.slice(0, 58)}`);
  }
  // Enough to make the boards feel inhabited without pretending every story
  // got a thread.
  if (touched >= 26) break;
}

db.exec(`
  UPDATE posts SET comment_count =
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id AND c.removed = 0);
`);

console.log(`\n${written} comments across ${touched} stories`);
