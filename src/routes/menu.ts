import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';
import {
  handleForceChaoticFlair,
  handleForceHeatFlair,
  handleManualHeatCheck,
} from '../core/heat';
import { getOrCreateDashboardPost } from '../core/radarStore';

export const menu = new Hono();

const toRedditUrl = (permalink: string) =>
  permalink.startsWith('http')
    ? permalink
    : `https://www.reddit.com${permalink}`;

menu.post('/open-dashboard', async (c) => {
  const subreddit = await reddit.getCurrentSubreddit();
  const post = await getOrCreateDashboardPost(subreddit.name);

  console.info(
    `Opened radar dashboard post=${post.id} subreddit=${subreddit.name}`
  );

  return c.json<UiResponse>(
    {
      navigateTo: toRedditUrl(post.permalink),
      showToast: {
        text: 'Opening EscalationRadar dashboard.',
        appearance: 'success',
      },
    },
    200
  );
});

menu.post('/check-thread-heat', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const result = await handleManualHeatCheck(request.targetId);

  console.info(
    `Manual heat check ${result.action} score=${result.score}/${result.threshold} target=${request.targetId}`
  );

  return c.json<UiResponse>(
    {
      showToast: {
        text: result.message,
        appearance: result.success ? 'success' : 'neutral',
      },
    },
    200
  );
});

menu.post('/mark-heated', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const result = await handleForceHeatFlair(request.targetId);

  console.info(
    `Manual heat mark ${result.action} target=${request.targetId} post=${result.postId ?? 'unknown'}`
  );

  return c.json<UiResponse>(
    {
      showToast: {
        text: result.message,
        appearance: result.success ? 'success' : 'neutral',
      },
    },
    200
  );
});

menu.post('/mark-chaotic', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const result = await handleForceChaoticFlair(request.targetId);

  console.info(
    `Manual chaotic mark ${result.action} target=${request.targetId} post=${result.postId ?? 'unknown'}`
  );

  return c.json<UiResponse>(
    {
      showToast: {
        text: result.message,
        appearance: result.success ? 'success' : 'neutral',
      },
    },
    200
  );
});
