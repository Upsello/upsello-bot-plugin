---
description: The weekly operating loop for a store — diagnose on Monday into three actions for the week, review on Friday and record the decision. Use for the weekly meeting, a new store's onboarding, and whenever the user asks what to do now or why nothing is working.
---

# The operating loop

## When to use it

The Monday agenda, the Friday review, a new store's onboarding, and any time the user asks "what should we do now" or "why isn't this working". If the question is about **priority**, run this skill first instead of handing out work.

## Monday

1. `shopify_store`: confirm the currency and timezone. Every amount and date after this follows it.
2. Pull the baseline, and only as much as will actually run:
   - `shopify_sales_by_product` (30 days): where the money is concentrated
   - `shopify_orders` (30 days): order count and average order value
   - `shopify_inventory`: what is out of stock or overstocked
   - `shopify_pages`: whether the trust pages are all there (about, returns, shipping, FAQ)
3. Rank the problems by **revenue impact** and keep only the top three. Write one sentence each: which product, which step, roughly how much money.
4. Give each problem **one action**, and every action carries four things:
   - an owner (which Agent)
   - one metric (only one)
   - a baseline (the number as of the start of the week)
   - a rollback condition (when to stop)
5. Send the actions to their Agents with `message_bot`; tell the user what they have to do themselves.
6. Give the user one paragraph: this week's three actions, who owns each, which number to watch, when it rolls back.

## Friday

1. Ask each owner what actually happened, with `message_bot`. If there is no data, say so — never fill the gap.
2. Judge each action as keep / rollback / scale.
3. Write one decision per action: what we thought, what happened, what changes next time.
4. Next week does one of two things: keep testing, or change the approach. **Never add new actions on top.**

## Board and the gate

**The order cannot be skipped; the tools refuse it:**

1. **Diagnose first**: `store_diagnose` reads the store and produces gaps ranked by revenue impact. Without a diagnosis there is no plan.
2. **Then plan**: the Main Bot uses `plan_propose`. Every action must point at a real gap (`gapId`) and carry an owner, one metric, a baseline, a rollback condition, a deliverable and acceptance criteria. **The user sees the plan first and agrees to it.**
3. **Then distribute**: after the user agrees, `plan_commit` turns the plan into board cards (To do), and each card goes to its owner with `message_bot`, stating the deliverable and the acceptance criteria.

A diagnosis older than 24 hours is stale and must be re-run. Never plan a new week on old data.

**What an owner does**
1. `board_my_cards` to see their cards (a rejected card carries the reason)
2. `board_start` to begin
3. `board_deliver` to hand over: **the deliverable itself** (a page link, a file path, or the copy in full) plus one line of explanation. A card without the thing does not count as delivered.
   After delivery the card moves to review, where both the user and the Main Bot can see the deliverable.

**What needs a person**
Any step only the user can do (shoot footage, grant access, confirm a price, send a sample) is assigned to `用户`:
the card lands on the board, the user presses "I've done this", and it moves to review. Never hand these to an Agent to pretend.

**What the Main Bot does (the gate)**
1. When a card is in review, run `board_check` first:
   - `trust-pages`: whether the four trust pages are complete
   - `orders>=N`: the order count over the last 30 days
   - `product:<handle>`: description length and the main image
   - anything without an automatic check is read by a person
2. Pass → `board_review approve`; fail → `board_review reject` with the reason (the reason goes back to the owner)
3. **Only the Main Bot approves.** An owner never moves their own card to Done.
4. A card that says "done" without the deliverable is rejected — review looks at the thing, not the claim.

**Stage gate**: when every card in the stage is done, confirm with `board_stage_gate`. Move to the next stage only if the stage's metrics are met; otherwise stay and keep working.

## Who owns what

| Kind of problem | Owner |
|---|---|
| Product pages, copy, image order, trust pages | PDP Agent |
| Organic traffic, short-video topics | Social Agent |
| Paid traffic, creative, angles | Ads Agent |
| Measurement, priority, coordinating the Agents | Main Bot |

## Rules

- A number you did not read never enters a conclusion.
- One action follows one metric.
- No rollback condition, no work.
- New ideas wait outside the agenda; they do not cut in.
- Changing a price, a page, a post or a budget needs the user's explicit approval.
- A problem that has not moved for two weeks gets a new approach, not more of the same.

## Launch Pack mode (a new store's first 90 days)

A new store's bottleneck is not conversion, it is **traffic and trust**. So the loop runs in this order:

1. **Weeks 1–4: can it sell at all**
   - Product pages: main image, selling points, specs, price
   - Trust pages: returns, shipping, about, FAQ
   - Metrics: page completeness, first organic traffic
2. **Weeks 5–8: are there orders**
   - Cold-start content (3–5 short videos a week)
   - Small ad tests (test angles, not budgets)
   - Metrics: the first 30 orders, cost per first order
3. **Weeks 9–12: does it hold**
   - Repeat purchases, abandoned checkouts, reusing content
   - Metrics: repeat rate, whether CAC is stable

Review at the end of each stage. If the metrics are not met, stay in the stage — do not skip ahead.

## Output format

- This week's three actions: action / owner / metric / rollback
- One-line diagnosis: the most expensive problem
- Missing data: the fields the user has to supply
