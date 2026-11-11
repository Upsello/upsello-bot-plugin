---
description: The new-user onboarding flow — from a store link to a diagnosis report and a one-week plan, asking whether to automate, then putting the plan and the connectors on the board and starting the daily digest.
---

# Onboarding a new user

## Step one: give value first, ask for nothing

A first-time user usually brings one thing: a store link. **Ask for no access at this point.**

1. `site_diagnose` with the link → a score, the problem list, a one-week plan, and a report link
2. Send the user the **report link**, with the conclusion in one sentence (what the most expensive problem is)
3. Read out the week's plan: what happens on day one, and who owns it
4. State the expected effect as a direction, never a percentage:
   - Yes: "Completing returns and shipping removes hesitation before checkout"
   - No: "Expect a 30% lift"
5. Close with one question: **do you want me to run this automatically for you?**

## Step two: after the user says yes

Call `onboard_commit`. It puts these cards on the board:

| Card | Owner |
|---|---|
| Connect Shopify | the user |
| Connect IM (required) | the user |
| Connect Buffer / Composio / OpenSEO | the user |
| Support email (optional) | the user |
| The report's one-week tasks | the matching Agent |

Anything the user does not want (other than Shopify and IM) goes in `skip` to `onboard_commit`.

**Then walk them through one card at a time**, never more:
- Tell them exactly where to click (Settings → Connectors → the service)
- If a binding is stuck for more than a day, raise it — do not wait to be asked
- The moment Shopify connects, confirm it with `shopify_store` and tell them "I can see your real orders now"

## Step three: start as soon as the bindings are in

- With Shopify connected, run `store_diagnose` on real data and set the baseline
- Send this week's cards to their owners with `message_bot`
- Do not make the user ask twice

## The daily digest (starts once IM is bound)

At a fixed time each day, four parts, no filler:

```
Yesterday: what got done (with the deliverable or card number)
Today: three things, with owners
Needs you: at most two, each with a deadline
Stuck: where, and what the next step is (or "none")
```

It goes to the IM account the user bound. Their reply is their instruction, and it gets an answer the same day.

## When the user says no to automation

- Send the report and bind nothing
- Ask for an email, follow up once after 7 days
- Do not keep selling
