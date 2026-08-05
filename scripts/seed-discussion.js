'use strict';

/**
 * Discussion seed.
 *
 * The wire fills the news boards on its own, but a forum with only wire copy is
 * a reader, not a community. These are the arguments the industry actually has
 * with itself — payment processors, age verification, consent paperwork,
 * piracy, platform dependence, burnout — written as threads with real
 * disagreement in the replies rather than a chorus.
 *
 * Idempotent: keyed on title, so re-running tops up rather than duplicating.
 */

require('../src/env');

const store = require('../src/store');
const { db } = require('../src/db');

const HOUR = 3600e3;
const DAY = 86400e3;
const now = Date.now();

const userId = (name) => store.users.byUsername(name)?.id || null;

/**
 * Each thread: board, author, title, body, and a reply tree. `at` is hours ago.
 * Scores are set explicitly so the front page has a believable shape rather
 * than everything sitting at 1.
 */
const THREADS = [
  {
    board: 'industry',
    by: 'margin_call',
    at: 9,
    score: 412,
    flair: 'Analysis',
    title: 'Payment processors are the actual regulator, and nobody voted for them',
    body: `Every conversation about adult industry regulation focuses on legislatures. That is the wrong place to look.

Visa and Mastercard set more binding policy on this industry than any state legislature has managed. When Mastercard's 2021 rules landed, platforms rewrote their entire compliance stack in weeks — documented consent for every performer in every scene, pre-publication review, a complaints process with fixed response times. No statute did that. Two card networks did.

The part that gets missed: those rules are not obviously bad. Documented consent is good. Reviewable takedowns are good. The problem is the mechanism. A private company with no democratic accountability, no appeals process you can litigate, and no obligation to explain itself decides what is publishable, and the answer changes whenever a pressure campaign gets loud enough.

You cannot lobby them. You cannot vote them out. You cannot FOIA them. If they decide your category is a liability, you are done, and the only recourse is finding a processor who has not decided that yet.

Three things follow:

1. **Compliance work is not optional and never was.** The studios that survived 2021 were the ones already keeping records properly.
2. **Diversifying processors is survival, not optimisation.** Single-processor dependency is the most common way a profitable adult business dies.
3. **"The banks made us" is doing a lot of work as an excuse.** Some platforms used processor pressure as cover for cuts they wanted anyway.

I do not have a fix. I am not sure there is one that does not involve crypto rails nobody actually wants to use. But I would like people to stop treating this as a side issue.`,
    replies: [
      {
        by: 'chargeback_queen', at: 8, score: 187,
        body: `Independent creator here, so I am downstream of all of this.

The thing nobody tells you when you start: your processor relationship is your business. Not your content, not your audience — your ability to take money. I have watched people with 40k subscribers lose everything in a fortnight because their platform got dropped and there was no second rail.

What actually helped me:
- Two platforms, always, even when one is 90% of income
- A direct processor relationship as well as the platform's
- Six months of runway, because a hold is 90 to 180 days and nobody warns you

The 2021 rules were painful and also correct. The paperwork is not the problem. The problem is that the paperwork requirement arrived by fiat with a two-week deadline.`,
        replies: [
          {
            by: 'gaffer_tape', at: 7, score: 64,
            body: `Seconding the two-platform thing from the production side. Studios did the same — every one I worked with in 2022 was quietly setting up a backup merchant account.

The two-week deadline is the part that still annoys me. We had scenes shot in 2015 with consent forms that were completely standard at the time and did not have the new fields. Either you re-contact everyone or you delete the catalogue. A lot of catalogue just got deleted.`,
          },
          {
            by: 'second_camera', at: 6, score: 41,
            body: `> A lot of catalogue just got deleted.

This is going to be a real archival problem in twenty years. An entire era of production wiped because the record-keeping standard changed retroactively and re-contacting people was impossible or unsafe.`,
          },
        ],
      },
      {
        by: 'clause_and_effect', at: 7, score: 96,
        body: `Lawyer-adjacent, not your lawyer.

The mechanism you are describing has a name in other contexts: private ordering. It is not unique to adult — it is how firearms, cannabis, and pharmacy affiliate marketing all get governed too. What is unusual here is how *complete* it is. In most industries the card networks are one pressure among several. Here they are close to the only one that binds.

Worth noting the direction of travel though. The age-verification statutes now in force in a majority of US states are legislatures deliberately reclaiming that ground. You can dislike the statutes and still notice that they represent democratic accountability re-entering a space that had none.`,
      },
      {
        by: 'quietriot', at: 5, score: -12,
        body: `Or maybe if the industry cleaned itself up the processors would not have had to step in.`,
        replies: [
          {
            by: 'red_flagged', at: 5, score: 118,
            body: `This framing keeps coming up and it does not survive contact with the timeline.

The compliance infrastructure the card networks demanded in 2021 — documented consent, upload verification, a real takedown pipeline — already existed at the major studios. What did not have it was user-upload tube content, which is a distribution problem, not a production one.

The people who paid for the crackdown were overwhelmingly independent performers whose paperwork was fine. The people who caused it were largely anonymous uploaders who were unaffected because they were never taking card payments in the first place.`,
          },
        ],
      },
    ],
  },

  {
    board: 'ethics',
    by: 'second_camera',
    at: 26,
    score: 338,
    flair: 'Discussion',
    title: 'Consent paperwork got dramatically better. Content removal after the fact did not.',
    body: `Two things are true at once and the discourse keeps collapsing them.

**Consent at the point of production is in a genuinely better place than it was ten years ago.** Standard forms now cover specific acts rather than blanket permission. Performers get to see the scene list before the day. On-set advocates exist at the larger studios. The 2021 processor rules, whatever you think of the mechanism, forced documentation on the last holdouts. Anyone telling you nothing improved is not paying attention.

**Removal after the fact is still close to broken.** A performer who consented at the time and wants their work down later has, realistically, no path. The studio owns the footage. Licensing agreements ran for a decade. Tube sites reupload faster than takedowns land. StopNCII and hash-matching handle the non-consensual case, which is a different and better-resourced problem.

The gap between those two facts is where most of the harm now lives. It is not "did they agree" — usually documented, usually yes. It is "they agreed at 22 and are 34 now and it is the first result for their legal name".

I do not think this is unsolvable. Some ideas that have come up on set:

- **Time-limited licences by default.** Ten years, renewable, rather than perpetual. Studios hate this and it would genuinely reduce catalogue value.
- **A performer-initiated delisting standard** that the major tubes actually honour, the way DMCA is honoured — imperfect, but a process.
- **Separating distribution rights from identity rights** so a performer keeps a veto on their own name and face being used in promotion even where the scene stays licensed.

None of these are close to happening. But the current answer — "you signed it" — is going to look as defensible in twenty years as any other industry's version of that sentence.`,
    replies: [
      {
        by: 'gaffer_tape', at: 24, score: 142,
        body: `Fifteen years on set. This matches what I have seen almost exactly.

The improvement in on-set consent is real and I get frustrated when people wave it away. I have watched the shift from "we will figure out the scene when we get there" to a scene list signed the week before with a named advocate present. That is a different job now.

The licence-length point is the one that will not move. Perpetual rights *are* the asset. A studio's catalogue valuation is built on them. Asking for ten-year terms is asking them to write down the balance sheet, and no amount of "it is the right thing" gets past that.

What might actually move: the newer studios competing on it. If a performer can choose between a perpetual-rights shoot and a ten-year one at the same rate, that is a recruiting advantage.`,
        replies: [
          {
            by: 'chargeback_queen', at: 22, score: 88,
            body: `This is basically why a lot of people went independent. On your own platform you hold your own rights. The trade is you also hold all the risk, do all the marketing, and handle the chargebacks yourself.

It is not obviously the better deal financially. It is obviously the better deal on this specific axis.`,
          },
        ],
      },
      {
        by: 'red_flagged', at: 20, score: 71,
        body: `Moderation side of this.

Hash-matching for known non-consensual material works well now — genuinely well. Detection is fast, the industry cooperates, and the major platforms act on it.

Consensual-then-regretted has none of that machinery, because it *cannot*. There is no hash list of "content the performer changed their mind about", and building one would mean maintaining a database of people who want less exposure, which is its own hazard.

The honest answer is that this is a rights and contract problem wearing a technology costume. No detection system fixes it.`,
      },
      {
        by: 'clause_and_effect', at: 18, score: 55,
        body: `The right-of-publicity angle is underexplored and is the closest thing to existing law that fits.

Most US states recognise a right to control commercial use of your name and likeness, and in several it survives contract to a degree. Nobody has seriously litigated whether a 2011 model release covers using a performer's *legal name* in 2026 SEO metadata on a site that did not exist when they signed.

That is a narrower claim than "let me delete my past", and narrow claims are the ones that win.`,
      },
    ],
  },

  {
    board: 'policy',
    by: 'clause_and_effect',
    at: 14,
    score: 289,
    flair: 'Explainer',
    title: 'Age verification: what the laws actually require, and why compliance is harder than the debate suggests',
    body: `The public argument is "should sites verify age", which is not the interesting question. Everyone agrees minors should not access this. The interesting question is what "verify" means in a statute, and the statutes do not agree with each other.

**The three models currently in force:**

*Transactional*: upload a government ID or use a commercial verification vendor per visit or per session. Texas HB 1181 is the reference implementation. High friction, high abandonment, and it creates a database of who accessed what — which is exactly the honeypot the privacy objections warned about.

*Attestation-plus*: self-declaration backed by device signals, payment-card checks, or an account-level check performed once. Lower friction, easier to defeat, and several statutes explicitly say it is not enough.

*Device-level*: the operating system knows the user is a minor and tells the site. This is what Apple and Google prefer for obvious reasons, and what the industry has generally argued for — one check, held by a party that already knows, no per-site database. Utah moved this direction. Most states did not.

**Where the compliance difficulty actually is:**

It is not the check. Vendors sell that. It is that a site serving all fifty states now needs per-jurisdiction logic that changes as each legislature amends. What counts as covered material differs. What counts as sufficient verification differs. Record-retention requirements differ and sometimes conflict — one state requires you keep proof, another requires you not retain the data.

The result is that compliance is easy for the largest platforms with a legal team and effectively impossible for a small studio, which is a familiar pattern: regulation written against big players that consolidates the market in their favour.

**The measured outcome so far:** traffic to compliant sites in covered states drops substantially, and traffic to non-compliant offshore sites rises by a similar amount. Whether that counts as the policy working depends entirely on what you thought it was for.`,
    replies: [
      {
        by: 'ctrl_alt_defeat', at: 13, score: 134,
        body: `Engineer who has implemented two of these. The per-jurisdiction logic point is the one people underestimate.

You do not build "an age gate". You build a policy engine: geolocate, resolve the applicable rule set, pick a verification method that satisfies it, handle the failure path, and log exactly as much as that state requires and no more. Then you do it again in six months when three states amend.

The retention conflict is real and genuinely unresolvable in some pairings. We ended up with per-state retention policies and a legal opinion saying which one wins if a user moves. That is not a sentence a small studio can afford to have written.`,
        replies: [
          {
            by: 'margin_call', at: 12, score: 47,
            body: `> regulation written against big players that consolidates the market in their favour

This is the part that should worry people who dislike the big platforms. Every compliance regime so far has increased their share. Aylo can absorb this. A four-person studio cannot.`,
          },
        ],
      },
      {
        by: 'red_flagged', at: 11, score: 62,
        body: `Worth adding: the device-level model is the only one where the check happens once and the site never learns who you are.

The reason it has not won is not technical. It is that it requires Apple and Google to accept liability for the signal, and neither wants that. So we get the model that offloads liability onto the site and privacy risk onto the user, because that is the arrangement where the powerful parties are comfortable.`,
      },
      {
        by: 'quietriot', at: 9, score: 28,
        body: `Genuine question — if traffic just moves offshore, does anyone in favour of these laws consider that a failure, or is the point that compliant sites are cleaner regardless?`,
        replies: [
          {
            by: 'clause_and_effect', at: 8, score: 73,
            body: `Both positions exist and they are rarely distinguished, which is why the debate goes in circles.

The harm-reduction argument says: fewer minors reach *some* material, that is a real gain, offshore leakage is a reason to enforce harder rather than to stop.

The structural argument says: the measurable effect is shifting traffic from sites with 2257 records, moderation teams and takedown pipelines to sites with none of those, and that is worse for the people in the videos.

They are not really arguing about age verification. They are arguing about whether the legal industry's existence is itself a good outcome.`,
          },
        ],
      },
    ],
  },

  {
    board: 'creators',
    by: 'chargeback_queen',
    at: 30,
    score: 267,
    flair: 'PSA',
    title: 'Things I wish someone had told me before I made this my only income',
    body: `Four years independent. Not a cautionary tale — it worked — but there is a gap between the advice that gets posted and what actually matters.

**Money**

Your income is not the number on the dashboard. Subtract the platform cut, the chargeback rate, the processor hold, the tax you are not withholding, and the months where you are ill. What is left is the real figure and it is usually 45 to 55 percent of the headline.

Chargebacks are the thing nobody budgets for. A 1% rate is normal. Above 2% your processor starts paying attention. Above 3% you can lose the account. You will get chargebacks from people who absolutely received what they paid for, and fighting them costs more than losing them.

Set aside for tax from every payout, in a separate account you do not touch. The number of people who discover this in April is the single most preventable disaster in this job.

**Platform risk**

Assume any platform can drop you with no notice and no appeal. Not because they are evil — because a processor leaned on them and you are a line item. Everything that matters should exist somewhere you control: your mailing list, your own domain, a direct payment path.

If one platform is more than 70% of income, that is not a business, it is a job with no employment protection.

**Safety**

Separate legal name from working name completely, from day one. It is close to impossible to fix retroactively. Different email, different payment entity where you can, no metadata in files, no reused profile photos, reverse-image-search yourself quarterly.

Assume you will be found eventually anyway and decide in advance what you will do when you are.

**The part that surprised me**

The work that pays is not the work I expected. Custom requests and direct messages consistently out-earn the content I spend the most time on. I do not entirely love that, but pretending otherwise cost me a year.

Happy to answer anything.`,
    replies: [
      {
        by: 'quietriot', at: 28, score: 58,
        body: `The chargeback figure is higher than I expected. Is that typical across platforms or worse on some?`,
        replies: [
          {
            by: 'chargeback_queen', at: 27, score: 91,
            body: `Varies a lot. Subscription models are lower than one-off clip sales, because a recurring charge the customer recognises is disputed less often. Custom work is worst — high ticket, and if someone regrets a £200 spend they dispute it.

Also depends on how your descriptor appears on the statement. If it looks unfamiliar, disputes go up measurably. Worth checking what yours says.`,
          },
        ],
      },
      {
        by: 'gaffer_tape', at: 26, score: 44,
        body: `The name separation advice cannot be repeated enough, and it applies to crew too. I have watched a camera operator get found because of an EXIF field in a behind-the-scenes photo they posted from their personal account in 2016.`,
      },
      {
        by: 'margin_call', at: 24, score: 37,
        body: `> If one platform is more than 70% of income, that is not a business, it is a job with no employment protection.

This is the best sentence in the thread and applies well outside this industry.`,
      },
    ],
  },

  {
    board: 'tech',
    by: 'ctrl_alt_defeat',
    at: 40,
    score: 244,
    flair: 'Deep dive',
    title: 'Synthetic media broke the takedown workflow, and the fix is not detection',
    body: `Worked on trust and safety at a tube site. The moderation stack we had was built on an assumption that stopped being true around 2023.

**The old assumption:** every piece of media has an origin. A real camera, a real shoot, real people. So the questions are: who owns it, did the people in it consent, is it legal where we serve it. Every tool followed from that — hash matching against known-bad, reverse search for the original, 2257 records for the production.

Synthetic media does not have an origin in that sense. There is no shoot. There are no records because there was no production. Hash matching fails by construction: every generation is novel, so nothing matches a list of known files.

**What actually happens now:** the report arrives, and the question is not "who owns this" but "is the person depicted real, and did they agree". Both are hard. The first needs face matching against people who have not opted into any database. The second has no technical answer at all.

**Why detection is not the fix.** Detector accuracy in the lab does not survive contact with compressed, re-encoded, cropped uploads. Worse, it is adversarial — every published detector becomes a training signal for the next generator. Anyone selling you 99% accuracy is quoting a benchmark, not production.

**What has actually worked, in rough order of usefulness:**

1. **Provenance at capture.** C2PA-style signing at the camera. Does not detect fakes; proves what is real, which turns out to be the more tractable half of the problem.
2. **Reporter-initiated identity claims.** The depicted person says "that is me and I did not consent". Slow, human, requires trust — and it is the only mechanism that gets the actual answer.
3. **Upload friction for new accounts.** Unglamorous and effective. Most volume comes from accounts less than a week old.
4. **Detection**, last, as a triage hint that routes to a human. Never as a decision.

The uncomfortable conclusion: the answer is not a better model. It is more human reviewers and a faster path for the person depicted to be heard. That costs money and does not demo well, which is why every vendor pitch is a classifier.`,
    replies: [
      {
        by: 'red_flagged', at: 38, score: 118,
        body: `Everything here matches my experience. The point about detectors being adversarial deserves more weight than it gets.

Publishing a detector is publishing a fitness function. It is the same dynamic as spam filtering, except the generation side improves much faster than the filtering side because it has more compute behind it.

The reporter-initiated route is genuinely the one that works, and the reason platforms resist it is that it does not scale without headcount. TAKE IT DOWN putting a statutory clock on it is the first thing I have seen that forces the investment.`,
        replies: [
          {
            by: 'ctrl_alt_defeat', at: 36, score: 52,
            body: `Agreed on the statutory clock. A 48-hour deadline changes the internal argument from "can we justify more reviewers" to "what is the fine if we do not".

That is a grim reason to staff a team properly, but it works.`,
          },
        ],
      },
      {
        by: 'second_camera', at: 34, score: 46,
        body: `The provenance point is interesting from the production side. Signing at capture is not hard for a studio shoot — it is a camera setting and a key.

The problem is everything downstream. Every edit, transcode and colour pass breaks the signature unless the whole pipeline understands it, and most post software does not yet.`,
      },
      {
        by: 'clause_and_effect', at: 30, score: 39,
        body: `Legally the interesting wrinkle is that synthetic depictions of real people sit in a different bucket from both defamation and NCII in most jurisdictions, and several statutes written in the last two years explicitly close that gap.

The drafting quality varies wildly. Some cover any synthetic sexual depiction of an identifiable person. Others require proof of intent to harm, which is close to unprovable at upload scale.`,
      },
    ],
  },

  {
    board: 'discussion',
    by: 'gaffer_tape',
    at: 52,
    score: 198,
    flair: 'Question',
    title: 'What is the thing about this industry that outsiders get most consistently wrong?',
    body: `Not asking for a defence of the business. Plenty about it is genuinely bad and worth criticising.

I mean the specific factual things people are confidently wrong about. Mine, from the crew side: almost everyone assumes sets are chaotic and unprofessional. The ones I have worked have been more procedurally careful than most commercial shoots — because the consequences of getting it wrong are worse, so the paperwork and the check-ins are heavier.

That is not a claim that everything is fine. It is a claim that the specific picture people hold is wrong in a way that makes the real problems harder to discuss.

What is yours?`,
    replies: [
      {
        by: 'chargeback_queen', at: 50, score: 156,
        body: `That it is easy money.

The assumption is that you post and money arrives. The reality is that it is a small business with marketing, customer service, accounting, content production, platform relations and security, run by one person, in a category where your bank might close your account for existing.

I work more hours now than I did in an office, and I say that as someone who is glad they made the switch.`,
      },
      {
        by: 'red_flagged', at: 48, score: 97,
        body: `That the industry is uniformly against regulation.

Most people working in it want *more* regulation of a specific kind — enforceable consent standards, real penalties for tube sites hosting non-consensual material, labour protections. What they oppose is regulation aimed at making the legal industry unviable, which is what most of it has been.

"Pro-industry" and "anti-regulation" get treated as the same position and they are frequently opposite.`,
        replies: [
          {
            by: 'clause_and_effect', at: 46, score: 61,
            body: `This. The FSC spends most of its litigation budget on First Amendment cases, which reads as anti-regulation, and most of its policy effort on things like mandatory consent documentation and 2257 reform, which is the opposite.

Both are consistent if you think the goal is a legal, accountable industry rather than an unregulated one.`,
          },
        ],
      },
      {
        by: 'second_camera', at: 44, score: 73,
        body: `That performers are uniformly coerced or uniformly empowered.

Both narratives are load-bearing for somebody's politics and neither survives talking to twenty people. You get the full range you would get in any freelance creative field, with the tails further apart because the downside risk is worse and the upside is better.

The people who have it worst are almost never the ones either narrative is about.`,
      },
      {
        by: 'ctrl_alt_defeat', at: 40, score: 44,
        body: `That the tech is simple. It is one of the hardest content-delivery problems there is — enormous files, global CDN, aggressive piracy, payment fraud, and a moderation load that would break most teams. A lot of streaming infrastructure everyone uses now was solved here first because the constraints hit here first.`,
      },
    ],
  },

  {
    board: 'industry',
    by: 'margin_call',
    at: 66,
    score: 176,
    flair: 'Analysis',
    title: 'The subscription platforms did not disrupt the studios. They disrupted the middle.',
    body: `The usual story is that OnlyFans killed the studio model. The numbers do not support it.

The top studios are fine. Vixen, Adult Time, Bang and the rest are producing more, spending more per scene and charging more than they did in 2018. High-production-value work still has a market willing to pay for it.

Independent creators are obviously fine, or at least the top decile are. That is the visible story.

What actually disappeared was the middle: mid-tier studios producing volume at moderate quality, and the distribution and licensing layer that fed them. That business had no defence. Its quality advantage over an independent creator with good lighting collapsed, and its cost structure could not compete with someone working alone.

This is the same shape as every other media disruption — the middle goes, the premium tier and the long tail survive. It is worth naming because "the studios are dying" and "everyone is independent now" are both wrong, and policy arguments keep getting built on top of them.

One consequence worth watching: the mid-tier was where people learned the job. It was the on-ramp — where crew trained, where performers built a reputation before going independent, where the norms got transmitted. Losing it means the top tier and the long tail have no pipeline between them, and the long tail has nowhere to learn from except each other.`,
    replies: [
      {
        by: 'gaffer_tape', at: 62, score: 88,
        body: `The pipeline point is the real cost and almost nobody talks about it.

I learned this job on mid-tier sets. Someone senior told me when I was doing something wrong. That does not exist for someone starting now — you either get hired directly onto a top-tier set, which basically does not happen without a reputation, or you work alone and learn from mistakes that have consequences for other people.`,
      },
      {
        by: 'chargeback_queen', at: 58, score: 64,
        body: `From the independent side: the "everyone is independent now" framing hides how top-heavy it is. The visible successes are a very small slice. The median independent earns far less than a mid-tier studio contract used to pay, with none of the structure.

Being your own boss is genuinely better in some ways. It is not better in the way the coverage suggests.`,
      },
    ],
  },
];

// ---------------------------------------------------------------------------

const boardIds = new Map();
const boardId = (slug) => {
  if (!boardIds.has(slug)) boardIds.set(slug, store.boards.bySlug(slug)?.id);
  return boardIds.get(slug);
};

const exists = db.prepare('SELECT id FROM posts WHERE title = ?');
const backdatePost = db.prepare('UPDATE posts SET created_at = ?, ups = ?, score = ?, hot = hot_rank(?, ?), flair = ? WHERE id = ?');
const backdateComment = db.prepare('UPDATE comments SET created_at = ?, ups = ?, score = ?, confidence = ? WHERE id = ?');
const { hotRank, confidence } = require('../src/ranking');

function addReplies(postId, parentId, replies) {
  let n = 0;
  for (const reply of replies || []) {
    const author = userId(reply.by);
    if (!author) continue;
    const id = store.comments.create({ postId, parentId, authorId: author, body: reply.body });
    const ups = Math.max(1, reply.score + 3);
    const downs = Math.max(0, ups - reply.score);
    backdateComment.run(now - reply.at * HOUR, ups, reply.score, confidence(ups, downs), id);
    n += 1 + addReplies(postId, id, reply.replies);
  }
  return n;
}

let added = 0;
let comments = 0;

for (const thread of THREADS) {
  if (exists.get(thread.title)) continue;
  const bid = boardId(thread.board);
  const author = userId(thread.by);
  if (!bid || !author) {
    console.warn(`skip "${thread.title.slice(0, 40)}…" — missing board or author`);
    continue;
  }

  const id = store.posts.create({
    boardId: bid,
    authorId: author,
    kind: 'text',
    title: thread.title,
    body: thread.body,
    flair: thread.flair || '',
  });

  const at = now - thread.at * HOUR;
  backdatePost.run(at, thread.score + 8, thread.score, thread.score, at, thread.flair || '', id);
  comments += addReplies(id, null, thread.replies);
  added++;
  console.log(`+ ${thread.board}/${thread.title.slice(0, 58)}`);
}

// Comment counts are maintained incrementally on insert; recompute so the
// backdated tree agrees with the denormalised column.
db.exec(`
  UPDATE posts SET comment_count =
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id AND c.removed = 0);
`);

console.log(`\nseeded ${added} threads, ${comments} comments`);
