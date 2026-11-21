# Kural — Who will pay first? (Problem 2)

An agent that decides who to reach today, calls them in Tamil, helps them pay through Cashfree,
and re-plans the moment anything changes — with a reason for every decision.

## How it works

1. **Clean the book.** Upload any borrower file (CSV/TSV). Odd column names, `₹2,499` / `4.8k` / `0.062L`
   amounts, `+91` phones, Indian date formats, duplicate rows and free-text field notes
   ("salary 5th-ku varum", "branch-la kattiten") are handled. Every guess is shown as a data issue —
   nothing is silently fixed. Rows with no valid phone or unreadable amount go to a person, not the AI.
2. **Rank.** A transparent rule-based score (0–100) from behaviour only, with a sentence per person a
   manager can read aloud. People are split into: **AI agent calls**, **Promised later**,
   **Human team · verify a claim**, **Human team · needs a person**, **Paid**.
3. **Call.** The Relay voice agent calls in Tamil (Sarvam speech), discloses recording, and creates a
   Cashfree payment link with part payment allowed.
4. **Learn and re-plan.** Call outcomes (or just the transcript, read by Sarvam's chat model) and Cashfree
   payment events (PAID / PARTIALLY_PAID / failed attempt) update the person and the list re-forms live.

## Key design choices

| Choice | Why |
|---|---|
| Rule-based, explainable score (not a black-box model) | Every score must have a reason a manager or regulator can read aloud. Weights are in one file (`src/rank.js`). |
| Behaviour signals only | On 30,000 real records, payment history predicts strongly (88% vs 30% pay rate) while gender, age and education barely move it (75–81%). |
| People who never promise are judged by what they paid | "Some never promise and always pay" — they are not marked down for having no promise history. |
| Hard rules enforced in code, not only in the prompt | Calling window 8 AM–7 PM IST, max 3 attempts, no AI calls for hardship / disputed / bad-data cases. |
| "Already paid" → human verification with UTR | A claim is a lifeline or an excuse; a person checks it instead of the AI calling again. |
| Part payment by default | Cashfree links allow part payment with a minimum first amount (25% of what's left) — a way forward, not a harder push. |
| 10% random checks | Avoids the self-learning trap: the ranker keeps seeing people it would skip. |
| Keyword fallback for notes / transcripts | The demo works even if the network or the LLM is down; Sarvam is used when available. |

## What we chose not to use, and why

- **Name, area / pincode, language, gender, age** — can stand in for caste, religion or class. Language only
  picks the call language. Checked by a shuffle test: swapping these fields between people never changes the order.
- **Religious festival calendars for ranking** — reveal religion. The agent may *offer* a date after a festival
  the customer mentions, but it never ranks on it.
- **Phone model, contacts, social media** — wealth / community proxies and privacy risks.
- **Images (receipts, GPay screenshots)** — not supported in Relay; we ask for the UTR number instead.
- **A trained ML model** — with synthetic data and a demo-day file we have not seen, an explainable score
  that is easy to audit is safer than a model that might learn shortcuts.

## Does the ranking work?

Look-back test on the public **UCI Default of Credit Card Clients** dataset (30,000 real, anonymised
borrowers, 6 months of history; outcome = paid next month). Same capacity as the brief: 360 calls/day × 10 days.

| | Our order | Loan-number order (today) | Random |
|---|---|---|---|
| Payers reached in 3,600 calls | **3,195** | 2,792 | 2,791 |
| Calls wasted on non-payers | **405** | 808 | 809 |
| Payers in the first 360 calls | **317** | 276 | 286 |

Higher score, more likely to pay: 87.5% → 61.9% → 45.2% → 32.9% → 19.4% across score bands.
Gender and age groups are called roughly in proportion to their share of the book.
Re-run with `npm run proof` after changing the algorithm.

## Success case (fill in from the live run)

**Lakshmi Narayanan (L-20442)** — promised to pay on 20 Nov, didn't. The list moved her up
("Promise lapsed on 20 Nov"). The AI called in Tamil, disclosed recording; she could pay only part.
The agent sent a part-payment link (minimum ₹700); she paid ₹1,400 → status PARTIALLY_PAID,
her promise counted as kept, and she moved down the list with "Part paid ₹1,400 of ₹2,750. Follow up on the rest".

## Failure case handled (fill in from the live run)

**Joseph Antony (L-20278)** — field note "father in hospital". The agent did **not** call: the server blocked
it ("Hardship or unreachable cases go to a person, not the AI") and placed him under *Human team · needs a person*
with "A person offers a plan, no pressure". Similarly, a row with an unreadable amount ("abc") was imported
but held back for a person with "Data needs fixing first: amount due unreadable".
