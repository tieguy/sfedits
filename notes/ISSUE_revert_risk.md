## Idea: flag high revert-risk edits on posts

Wikimedia's [LiftWing](https://api.wikimedia.org/wiki/Lift_Wing_API/Reference) inference service hosts a language-agnostic [revert-risk model](https://meta.wikimedia.org/wiki/Machine_learning_models/Production/Language-agnostic_revert_risk) — the probability that an edit will be reverted. When the score is very high (proposed threshold: ≥85%), the bot could annotate the post so followers can spot likely vandalism in the feed.

### Mockup

Using a real posted edit (the "worthless children" vandalism to Shamann Walton, which the model scores at 95% and which was in fact reverted 13 seconds later):

*(mockup image here)*

The badge sits in the image header. The post text would get a matching note:

> Shamann Walton Wikipedia article edited by ~2026-38537-08 ⚠️ high revert risk https://en.wikipedia.org/w/index.php?diff=1362940098&oldid=1362939728

Alt text picks it up too:

> Diff of Wikipedia article "Shamann Walton" (American politician), flagged as high revert risk: 1 line changed. Added text: "Despite it all, … identifies … worthless" Removed text: "is"

### Mechanics

- One anonymous POST per edit to `revertrisk-language-agnostic:predict` with `rev_id` + `lang` (~1s, fits the existing pre-post pipeline; works on all the wikis the bot watches, not just enwiki)
- Fail-soft: no score → no badge, post goes out as normal
- Badge only above the threshold — no score shown on ordinary edits

### Calibration from real posted edits

| Edit | Nature | Score |
|---|---|---|
| Walton "worthless children" | blatant vandalism | 95% |
| Breed "mandate" → "passport" | subtle vandalism | 60% |
| Breed "Fransisco" → "Francisco" | benign typo fix | 38% |

The gray zone between ~40–80% contains both subtle vandalism and benign edits, hence the high threshold: annotate only when the model is confident, accept missing subtle cases.

### Open questions

- Is publicly badging an edit (and implicitly its author) as likely vandalism consistent with the bot's neutral, just-the-facts voice? A softer wording ("edit flagged by ML review model") might fit better.
- Threshold: 85%? 90%?
- Should the score also be logged / shown in the admin console regardless of threshold? (Probably yes — that part seems uncontroversial.)
