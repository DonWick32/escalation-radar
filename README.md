# EscalationRadar

EscalationRadar is a Reddit Devvit moderation tool that detects when a comment thread is heating up or becoming chaotic, then automatically marks the parent post with a visible `Heated` or `Chaotic` flair.

The goal is early warning, not automatic punishment. Mods get a fast signal that a discussion may need attention before it turns into a removal-heavy cleanup job.

## What It Does

- Watches `onCommentCreate` events.
- Scores the newest comment plus recent comments on the same post.
- Looks for argument patterns:
  - charged wording
  - repeated direct replies
  - fast comment bursts
  - two-user back-and-forth
  - one user repeatedly commenting
  - multiple heated comments in the same recent window
- Detects comment velocity anomalies using a rolling current window compared with a baseline window.
- Watches report bursts on posts and targeted comment reports against the same author.
- Applies `Chaotic` when a thread has too many recent comments, two users repeatedly replying to each other, or one user posting 3 recent comments in the same thread.
- Uses optional Gemini classification only after cheap signals decide the thread still needs semantic review.
- Applies configurable post flair when the relevant score crosses its threshold.
- Stores recent thread checks in Reddit Redis for moderator review.
- Adds a custom moderator dashboard post with scores, reasons, trends, suggested actions, workflow state, and links to risky threads.
- Adds moderator menu actions for manual checking and manual flairing during demos.

## Why This Helps Mods

Large communities often do not need another blunt removal bot. They need earlier visibility into threads that are likely to consume moderator time. EscalationRadar gives mods a lightweight triage signal directly on the post, while leaving final judgment and enforcement to humans.

## MVP Flow

1. A user submits a new comment.
2. EscalationRadar receives the comment-create trigger.
3. The app samples recent comments from the post.
4. The app computes a heat score.
5. If the heat score is above the subreddit threshold, the app applies the `Heated` post flair.
6. If the chaos score is above the subreddit threshold, the app applies the `Chaotic` post flair. Chaos wins over heat when both are true because Reddit displays one post flair.
7. EscalationRadar stores the latest check in Redis for the dashboard.
8. Mods can open the post or the dashboard and decide whether to monitor, lock, remove, or leave it alone.

## Moderator Settings

EscalationRadar exposes subreddit-level settings:

- `Enable automatic heat detection`
- `Heat threshold`
- `Recent comments to inspect`
- `Lookback window in minutes`
- `Heated flair text`
- `Chaotic flair text`
- `Chaotic threshold`
- `Chaotic comment threshold`
- `Chaotic reply threshold`
- `Create reusable flair template`
- `Use Gemini classifier`
- `Send every comment to Gemini`
- `Gemini model`

## Moderator Dashboard

Use the subreddit mod menu action `Open EscalationRadar dashboard` to create or open the dashboard custom post. The app requests moderator-scope Reddit permission so it can lock and remove the dashboard post from the public subreddit feed after creating it, then reuse the same post for moderator access.

It shows recent tracked threads, their `Heated` or `Chaotic` state, heat and chaos scores, classifier reasons, direct links back to the post, the dominant interaction pattern, and a score trend from recent checks.

Moderators can mark an incident as `Acknowledged`, `Resolved`, `Ignored for 1 hour`, or `Reopened`. These workflow states are stored in Redis with the incident snapshot.

The dashboard also includes editable velocity trigger settings:

- `Velocity window`
- `Baseline window`
- `Z-threshold`
- `Minimum comments`
- `Unique commenters`

Dashboard data is stored in Reddit Redis for seven days. The dashboard API checks that the current viewer is a moderator before returning incident data.

The default threshold is tuned for demos and early warning. A clearly heated reply in an active branch can flag the post automatically, while quieter disagreement still needs more thread context.

## Gemini Setup

Gemini is optional. EscalationRadar still works with local heuristics when Gemini is disabled, missing a key, or temporarily unavailable.

Gemini calls are rate-limited per post with a short Redis cooldown to avoid burning quota when the same thread is checked repeatedly. If chaos, velocity, or report signals already explain the risk, Gemini is skipped.

Store the Gemini key as a Devvit app secret:

```bash
npx devvit settings set geminiApiKey
```

Do not commit API keys to source control. If a key was pasted into chat or logs, rotate it before using the app in a real subreddit.

## Demo Script

1. Install the app on a Devvit test subreddit.
2. Create a normal post.
3. Add a few comments from different users or test accounts.
4. Add a heated reply with direct language and punctuation, create a rapid back-and-forth between two users, or add 3 comments from one user.
5. Use the moderator menu action `Check thread heat` on the post or comment.
6. Show that the post gets the `Heated` or `Chaotic` flair when the threshold is met.
7. Use the subreddit menu action `Open EscalationRadar dashboard`.
8. Show the stored score, reasons, and direct thread link in the custom UI.
9. Open settings and show that moderators can tune sensitivity without code changes.

## Tech Stack

- Devvit Web
- Hono
- TypeScript
- Reddit API through `@devvit/web/server`

## Development

Install dependencies:

```bash
npm install
```

Run type checks:

```bash
npm run type-check
```

Run lint:

```bash
npm run lint
```

Build:

```bash
npm run build
```

Playtest with Devvit:

```bash
npm run dev
```

## Submission Positioning

EscalationRadar is designed to score well as a hackathon project because it is:

- Impactful: reduces moderator reaction time during escalating discussions.
- Simple to adopt: install, tune settings, and let the trigger run.
- Polished for demos: includes automatic triggers, manual moderator actions, and a dashboard.
- Broadly useful: works across debate, advice, support, news, hobby, and local communities.

## Next Improvements

- Add trend charts from stored Redis score history.
- Add per-post cooldowns for Gemini calls and repeated flair writes.
- Add optional modmail or private mod comment alerts.
- Add allowlists for community-specific words that should not raise heat.
- Add an undo action that restores the previous flair.
