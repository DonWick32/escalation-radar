import { Hono } from 'hono';
import { reddit } from '@devvit/web/server';
import {
  getRadarDashboard,
  updateRadarRuntimeConfig,
  updateRadarIncidentState,
} from '../core/radarStore';
import type {
  RadarRuntimeConfig,
  RadarWorkflowState,
} from '../shared/dashboard';

export const api = new Hono();

const isCurrentUserModerator = async (subredditName: string) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return false;
  }

  const moderators = await reddit
    .getModerators({
      subredditName,
      username,
      limit: 1,
    })
    .all();

  return moderators.some(
    (moderator) => moderator.username.toLowerCase() === username.toLowerCase()
  );
};

api.get('/dashboard', async (c) => {
  const subredditName = c.req.query('subredditName')?.trim();
  if (!subredditName) {
    return c.json({ error: 'Missing subredditName.' }, 400);
  }

  if (!(await isCurrentUserModerator(subredditName))) {
    return c.json({ error: 'Moderator access required.' }, 403);
  }

  return c.json(await getRadarDashboard(subredditName), 200);
});

api.post('/incident-state', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    subredditName?: string;
    postId?: string;
    workflowState?: RadarWorkflowState;
  };
  const subredditName = body.subredditName?.trim();
  const postId = body.postId?.trim();
  const workflowState = body.workflowState;

  if (!subredditName || !postId || !workflowState) {
    return c.json(
      { error: 'Missing subredditName, postId, or workflowState.' },
      400
    );
  }

  if (!['new', 'acknowledged', 'resolved', 'ignored'].includes(workflowState)) {
    return c.json({ error: 'Invalid workflowState.' }, 400);
  }

  if (!(await isCurrentUserModerator(subredditName))) {
    return c.json({ error: 'Moderator access required.' }, 403);
  }

  const incident = await updateRadarIncidentState(
    subredditName,
    postId,
    workflowState
  );

  if (!incident) {
    return c.json({ error: 'Incident not found.' }, 404);
  }

  return c.json({ incident }, 200);
});

api.post('/dashboard-config', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    subredditName?: string;
    config?: Partial<RadarRuntimeConfig>;
  };
  const subredditName = body.subredditName?.trim();

  if (!subredditName || !body.config) {
    return c.json({ error: 'Missing subredditName or config.' }, 400);
  }

  if (!(await isCurrentUserModerator(subredditName))) {
    return c.json({ error: 'Moderator access required.' }, 403);
  }

  const config = await updateRadarRuntimeConfig(subredditName, body.config);
  return c.json({ config }, 200);
});
