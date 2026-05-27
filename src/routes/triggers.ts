import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnCommentCreateRequest,
  OnCommentSubmitRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import type {
  CommentReport,
  PostReport,
} from '@devvit/protos/json/devvit/events/v1alpha/events.js';
import {
  ensureHeatFlairOnInstall,
  handleCommentReportHeatCheck,
  handleCommentSubmitHeatCheck,
  handlePostReportHeatCheck,
} from '../core/heat';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log('App installed to subreddit: r/' + input.subreddit?.name);
  await ensureHeatFlairOnInstall(input);

  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-comment-submit', async (c) => {
  const input = await c.req.json<OnCommentSubmitRequest>();
  const result = await handleCommentSubmitHeatCheck(input);

  console.info(
    `Comment heat check ${result.action} score=${result.score}/${result.threshold} post=${result.postId ?? 'unknown'}`
  );

  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-comment-create', async (c) => {
  const input = await c.req.json<OnCommentCreateRequest>();
  const result = await handleCommentSubmitHeatCheck(input);

  console.info(
    `Comment create heat check ${result.action} score=${result.score}/${result.threshold} post=${result.postId ?? 'unknown'}`
  );

  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-post-report', async (c) => {
  const input = await c.req.json<PostReport>();
  const result = await handlePostReportHeatCheck(input);

  console.info(
    `Post report heat check ${result.action} score=${result.score}/${result.threshold} post=${result.postId ?? 'unknown'}`
  );

  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-comment-report', async (c) => {
  const input = await c.req.json<CommentReport>();
  const result = await handleCommentReportHeatCheck(input);

  console.info(
    `Comment report heat check ${result.action} score=${result.score}/${result.threshold} post=${result.postId ?? 'unknown'}`
  );

  return c.json<TriggerResponse>({}, 200);
});
