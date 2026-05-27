import { reddit, redis } from '@devvit/web/server';
import { T3 as toPostThingId } from '@devvit/shared-types/tid.js';
import type {
  RadarDashboardData,
  RadarDecision,
  RadarPattern,
  RadarRuntimeConfig,
  RadarScorePoint,
  RadarThreadSnapshot,
  RadarWorkflowState,
} from '../shared/dashboard';

const RADAR_DATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GEMINI_COOLDOWN_MS = 60 * 1000;
const REPORT_WINDOW_MS = 10 * 60 * 1000;
const DASHBOARD_LIMIT = 50;
const TIMELINE_LIMIT = 12;
const DASHBOARD_POST_TITLE = 'EscalationRadar Mod Dashboard';
const DEFAULT_RUNTIME_CONFIG: RadarRuntimeConfig = {
  velocityWindowMinutes: 5,
  baselineWindowMinutes: 30,
  velocityZThreshold: 2.5,
  minimumCommentsInWindow: 4,
  uniqueCommenterThreshold: 3,
  flairTtlMinutes: 60,
  rageBaitReplyThreshold: 4,
  rageBaiterUserFlairEnabled: true,
  rageBaiterUserFlairText: 'Rage baiter',
};

const keyPrefix = (subredditName: string) =>
  `radar:${subredditName.toLowerCase()}`;

const dashboardPostKey = (subredditName: string) =>
  `${keyPrefix(subredditName)}:dashboard-post`;

const dashboardIndexKey = (subredditName: string) =>
  `${keyPrefix(subredditName)}:threads`;

const runtimeConfigKey = (subredditName: string) =>
  `${keyPrefix(subredditName)}:runtime-config`;

const threadSnapshotKey = (subredditName: string, postId: string) =>
  `${keyPrefix(subredditName)}:thread:${postId}`;

const geminiCooldownKey = (subredditName: string, postId: string) =>
  `${keyPrefix(subredditName)}:gemini-cooldown:${postId}`;

const postReportKey = (subredditName: string, postId: string) =>
  `${keyPrefix(subredditName)}:reports:post:${postId}`;

const commentAuthorReportKey = (
  subredditName: string,
  postId: string,
  authorName: string
) => `${keyPrefix(subredditName)}:reports:post-author:${postId}:${authorName}`;

const authorReportKey = (subredditName: string, authorName: string) =>
  `${keyPrefix(subredditName)}:reports:author:${authorName}`;

const emptyPattern: RadarPattern = {
  kind: 'none',
  label: 'No dominant interaction pattern',
  count: 0,
};

const parseSnapshot = (
  value: string | null | undefined
): RadarThreadSnapshot | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as RadarThreadSnapshot;
  } catch {
    return undefined;
  }
};

const parseRuntimeConfig = (
  value: string | null | undefined
): RadarRuntimeConfig => {
  if (!value) {
    return DEFAULT_RUNTIME_CONFIG;
  }

  try {
    return normalizeRuntimeConfig(
      JSON.parse(value) as Partial<RadarRuntimeConfig>
    );
  } catch {
    return DEFAULT_RUNTIME_CONFIG;
  }
};

const clampConfigNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, min), max);
};

const normalizeConfigBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') {
    return value;
  }

  return fallback;
};

const normalizeConfigString = (
  value: unknown,
  fallback: string,
  maxLength: number
) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed.slice(0, maxLength);
};

const normalizeRuntimeConfig = (
  value: Partial<RadarRuntimeConfig>
): RadarRuntimeConfig => ({
  velocityWindowMinutes: clampConfigNumber(
    value.velocityWindowMinutes,
    DEFAULT_RUNTIME_CONFIG.velocityWindowMinutes,
    1,
    60
  ),
  baselineWindowMinutes: clampConfigNumber(
    value.baselineWindowMinutes,
    DEFAULT_RUNTIME_CONFIG.baselineWindowMinutes,
    5,
    240
  ),
  velocityZThreshold: clampConfigNumber(
    value.velocityZThreshold,
    DEFAULT_RUNTIME_CONFIG.velocityZThreshold,
    0.5,
    10
  ),
  minimumCommentsInWindow: clampConfigNumber(
    value.minimumCommentsInWindow,
    DEFAULT_RUNTIME_CONFIG.minimumCommentsInWindow,
    1,
    100
  ),
  uniqueCommenterThreshold: clampConfigNumber(
    value.uniqueCommenterThreshold,
    DEFAULT_RUNTIME_CONFIG.uniqueCommenterThreshold,
    1,
    100
  ),
  flairTtlMinutes: clampConfigNumber(
    value.flairTtlMinutes,
    DEFAULT_RUNTIME_CONFIG.flairTtlMinutes,
    5,
    1440
  ),
  rageBaitReplyThreshold: clampConfigNumber(
    value.rageBaitReplyThreshold,
    DEFAULT_RUNTIME_CONFIG.rageBaitReplyThreshold,
    2,
    50
  ),
  rageBaiterUserFlairEnabled: normalizeConfigBoolean(
    value.rageBaiterUserFlairEnabled,
    DEFAULT_RUNTIME_CONFIG.rageBaiterUserFlairEnabled
  ),
  rageBaiterUserFlairText: normalizeConfigString(
    value.rageBaiterUserFlairText,
    DEFAULT_RUNTIME_CONFIG.rageBaiterUserFlairText,
    32
  ),
});

const withoutIgnoredUntil = (snapshot: RadarThreadSnapshot) => {
  const copy: RadarThreadSnapshot = { ...snapshot };
  delete copy.ignoredUntil;
  return copy;
};

const normalizeWorkflow = (
  previous: RadarThreadSnapshot | undefined,
  now: number
): Pick<
  RadarThreadSnapshot,
  'workflowState' | 'workflowUpdatedAt' | 'ignoredUntil'
> => {
  if (!previous) {
    return { workflowState: 'new' };
  }

  if (
    previous.workflowState === 'ignored' &&
    previous.ignoredUntil !== undefined &&
    previous.ignoredUntil <= now
  ) {
    return { workflowState: 'new' };
  }

  return {
    workflowState: previous.workflowState ?? 'new',
    ...(previous.workflowUpdatedAt
      ? { workflowUpdatedAt: previous.workflowUpdatedAt }
      : {}),
    ...(previous.ignoredUntil ? { ignoredUntil: previous.ignoredUntil } : {}),
  };
};

const appendTimelinePoint = (
  previous: RadarThreadSnapshot | undefined,
  snapshot: RadarThreadSnapshot
): RadarScorePoint[] => {
  const previousTimeline = previous?.timeline ?? [];
  const nextPoint: RadarScorePoint = {
    checkedAt: snapshot.checkedAt,
    decision: snapshot.decision,
    heatScore: snapshot.heatScore,
    chaosScore: snapshot.chaosScore,
  };

  return [...previousTimeline, nextPoint].slice(-TIMELINE_LIMIT);
};

const hideDashboardPostFromPublicFeed = async (
  post: Awaited<ReturnType<typeof reddit.getPostById>>
) => {
  try {
    if (!post.locked) {
      await post.lock();
    }
  } catch (error: unknown) {
    console.warn('Could not lock dashboard post.', error);
  }

  try {
    if (!post.removed) {
      await post.remove(false);
    }
  } catch (error: unknown) {
    console.warn('Could not remove dashboard post from public feed.', error);
  }
};

export const saveRadarSnapshot = async (snapshot: RadarThreadSnapshot) => {
  const indexKey = dashboardIndexKey(snapshot.subredditName);
  const snapshotKey = threadSnapshotKey(
    snapshot.subredditName,
    snapshot.postId
  );
  const previous = parseSnapshot(await redis.get(snapshotKey));
  const workflow = normalizeWorkflow(previous, snapshot.checkedAt);
  const enrichedSnapshot: RadarThreadSnapshot = {
    ...snapshot,
    pattern: snapshot.pattern ?? emptyPattern,
    suggestedAction: snapshot.suggestedAction || 'No action needed.',
    ...workflow,
    timeline: appendTimelinePoint(previous, snapshot),
  };
  const staleBefore = Date.now() - RADAR_DATA_TTL_MS;

  try {
    await redis.set(snapshotKey, JSON.stringify(enrichedSnapshot), {
      expiration: new Date(Date.now() + RADAR_DATA_TTL_MS),
    });
    await redis.zAdd(indexKey, {
      member: enrichedSnapshot.postId,
      score: enrichedSnapshot.checkedAt,
    });
    await redis.zRemRangeByScore(indexKey, 0, staleBefore);
  } catch (error: unknown) {
    console.warn('Could not save radar dashboard snapshot.', error);
  }

  return enrichedSnapshot;
};

const isManagedFlaggedDecision = (decision: RadarDecision) =>
  decision === 'heated' || decision === 'chaotic';

const isExpiredFlaggedSnapshot = (
  snapshot: RadarThreadSnapshot,
  config: RadarRuntimeConfig,
  now: number
) =>
  isManagedFlaggedDecision(snapshot.decision) &&
  snapshot.checkedAt + config.flairTtlMinutes * 60 * 1000 <= now;

const expireQuietSnapshotFlair = async (
  snapshot: RadarThreadSnapshot,
  config: RadarRuntimeConfig,
  now: number
): Promise<RadarThreadSnapshot> => {
  if (!isExpiredFlaggedSnapshot(snapshot, config, now)) {
    return snapshot;
  }

  const reason = `No new comment events for ${config.flairTtlMinutes} minutes`;
  let action = 'below-threshold';

  try {
    const post = await reddit.getPostById(toPostThingId(snapshot.postId));
    const currentFlair = post.flair?.text?.trim().toLowerCase();
    const snapshotFlair = snapshot.flairText.trim().toLowerCase();

    if (currentFlair && currentFlair === snapshotFlair) {
      await reddit.removePostFlair(snapshot.subredditName, post.id);
      action = 'flair-cleared';
    }
  } catch (error: unknown) {
    console.warn('Could not expire quiet radar flair.', error);
    return snapshot;
  }

  const expired: RadarThreadSnapshot = {
    ...snapshot,
    action,
    decision: 'clear',
    heatScore: 0,
    chaosScore: 0,
    checkedAt: now,
    reasons: [reason],
    pattern: emptyPattern,
    suggestedAction: 'No action needed.',
    commentCount: 0,
  };
  delete expired.velocity;
  delete expired.conversation;

  return saveRadarSnapshot(expired);
};

const expireQuietSnapshotFlairs = async (
  incidents: RadarThreadSnapshot[],
  config: RadarRuntimeConfig
) => {
  const now = Date.now();

  return Promise.all(
    incidents.map((incident) => expireQuietSnapshotFlair(incident, config, now))
  );
};

export const getRadarRuntimeConfig = async (subredditName: string) =>
  parseRuntimeConfig(await redis.get(runtimeConfigKey(subredditName)));

export const updateRadarRuntimeConfig = async (
  subredditName: string,
  input: Partial<RadarRuntimeConfig>
) => {
  const current = await getRadarRuntimeConfig(subredditName);
  const updated = normalizeRuntimeConfig({ ...current, ...input });
  await redis.set(runtimeConfigKey(subredditName), JSON.stringify(updated));
  return updated;
};

export const getRadarDashboard = async (
  subredditName: string
): Promise<RadarDashboardData> => {
  const config = await getRadarRuntimeConfig(subredditName);
  const indexKey = dashboardIndexKey(subredditName);
  const indexedPosts = await redis.zRange(indexKey, 0, DASHBOARD_LIMIT - 1, {
    by: 'rank',
    reverse: true,
  });
  const snapshotKeys = indexedPosts.map((post) =>
    threadSnapshotKey(subredditName, post.member)
  );
  const values = snapshotKeys.length > 0 ? await redis.mGet(snapshotKeys) : [];
  const incidents = values
    .map(parseSnapshot)
    .filter((snapshot): snapshot is RadarThreadSnapshot => Boolean(snapshot));
  const activeIncidents = await expireQuietSnapshotFlairs(incidents, config);

  return {
    subredditName,
    generatedAt: Date.now(),
    totals: {
      total: activeIncidents.length,
      chaotic: activeIncidents.filter(
        (incident) => incident.decision === 'chaotic'
      ).length,
      heated: activeIncidents.filter(
        (incident) => incident.decision === 'heated'
      ).length,
      clear: activeIncidents.filter((incident) => incident.decision === 'clear')
        .length,
      failed: activeIncidents.filter(
        (incident) => incident.decision === 'failed'
      ).length,
    },
    config,
    incidents: activeIncidents,
  };
};

export const getOrCreateDashboardPost = async (subredditName: string) => {
  const key = dashboardPostKey(subredditName);
  const existingPostId = await redis.get(key);

  if (existingPostId) {
    try {
      const post = await reddit.getPostById(toPostThingId(existingPostId));
      await hideDashboardPostFromPublicFeed(post);
      return post;
    } catch {
      await redis.del(key);
    }
  }

  const post = await reddit.submitCustomPost({
    subredditName,
    title: DASHBOARD_POST_TITLE,
    entry: 'default',
    sendreplies: false,
    spoiler: true,
    postData: {
      kind: 'escalationradar-dashboard',
    },
    textFallback: {
      text: 'EscalationRadar moderation dashboard.',
    },
  });

  await hideDashboardPostFromPublicFeed(post);
  await redis.set(key, post.id);

  return post;
};

export const updateRadarIncidentState = async (
  subredditName: string,
  postId: string,
  workflowState: RadarWorkflowState
) => {
  const snapshotKey = threadSnapshotKey(subredditName, postId);
  const snapshot = parseSnapshot(await redis.get(snapshotKey));
  if (!snapshot) {
    return undefined;
  }

  const updatedAt = Date.now();
  const baseSnapshot =
    workflowState === 'ignored' ? snapshot : withoutIgnoredUntil(snapshot);
  const updated: RadarThreadSnapshot = {
    ...baseSnapshot,
    workflowState,
    workflowUpdatedAt: updatedAt,
    ...(workflowState === 'ignored'
      ? { ignoredUntil: updatedAt + 60 * 60 * 1000 }
      : {}),
  };

  await redis.set(snapshotKey, JSON.stringify(updated), {
    expiration: new Date(Date.now() + RADAR_DATA_TTL_MS),
  });

  return updated;
};

export const getGeminiCooldownRemainingMs = async (
  subredditName: string,
  postId: string
) => {
  const value = await redis.get(geminiCooldownKey(subredditName, postId));
  const cooldownUntil = Number(value);

  if (!Number.isFinite(cooldownUntil) || cooldownUntil <= Date.now()) {
    return 0;
  }

  return cooldownUntil - Date.now();
};

export const markGeminiCooldown = async (
  subredditName: string,
  postId: string
) => {
  const cooldownUntil = Date.now() + GEMINI_COOLDOWN_MS;
  await redis.set(
    geminiCooldownKey(subredditName, postId),
    String(cooldownUntil),
    {
      expiration: new Date(cooldownUntil),
    }
  );
};

const addReportEvent = async (key: string, now: number, label: string) => {
  await redis.zAdd(key, {
    member: `${now}:${label}:${Math.random().toString(36).slice(2)}`,
    score: now,
  });
  await redis.zRemRangeByScore(key, 0, now - REPORT_WINDOW_MS);
  return redis.zCard(key);
};

export type ReportAnomalySignal = {
  triggered: boolean;
  reportCount: number;
  targetedAuthorReports: number;
  authorReportsAcrossPosts: number;
  reasons: string[];
  pattern: RadarPattern;
};

export const recordPostReportSignal = async (
  subredditName: string,
  postId: string,
  reason: string
): Promise<ReportAnomalySignal> => {
  const now = Date.now();
  const reportCount = await addReportEvent(
    postReportKey(subredditName, postId),
    now,
    reason || 'post-report'
  );
  const reasons =
    reportCount >= 3
      ? [`${reportCount} reports on this post in 10 minutes`]
      : [];

  return {
    triggered: reportCount >= 3,
    reportCount,
    targetedAuthorReports: 0,
    authorReportsAcrossPosts: 0,
    reasons,
    pattern: {
      kind: reportCount >= 3 ? 'report-burst' : 'none',
      label:
        reportCount >= 3
          ? `${reportCount} reports on this post in 10 minutes`
          : 'No report anomaly detected',
      count: reportCount,
    },
  };
};

export const recordCommentReportSignal = async (
  subredditName: string,
  postId: string,
  authorName: string,
  reason: string
): Promise<ReportAnomalySignal> => {
  const now = Date.now();
  const [reportCount, targetedAuthorReports, authorReportsAcrossPosts] =
    await Promise.all([
      addReportEvent(postReportKey(subredditName, postId), now, reason),
      addReportEvent(
        commentAuthorReportKey(subredditName, postId, authorName),
        now,
        reason
      ),
      addReportEvent(authorReportKey(subredditName, authorName), now, reason),
    ]);
  const reasons = [
    ...(reportCount >= 5
      ? [`${reportCount} reports under this post in 10 minutes`]
      : []),
    ...(targetedAuthorReports >= 2
      ? [
          `${targetedAuthorReports} reports target comments by the same user here`,
        ]
      : []),
    ...(authorReportsAcrossPosts >= 4
      ? [
          `${authorReportsAcrossPosts} reports target comments by the same user across posts`,
        ]
      : []),
  ];
  const triggered = reasons.length > 0;
  const strongestCount = Math.max(
    reportCount,
    targetedAuthorReports,
    authorReportsAcrossPosts
  );

  return {
    triggered,
    reportCount,
    targetedAuthorReports,
    authorReportsAcrossPosts,
    reasons,
    pattern: {
      kind:
        targetedAuthorReports >= 2 || authorReportsAcrossPosts >= 4
          ? 'targeted-reports'
          : triggered
            ? 'report-burst'
            : 'none',
      label: triggered
        ? (reasons[0] ?? 'Report anomaly detected')
        : 'No report anomaly detected',
      count: strongestCount,
    },
  };
};

export const radarDecisionForResult = (
  action: string,
  intendedDecision: Exclude<RadarDecision, 'failed'>
): RadarDecision => (action === 'flair-failed' ? 'failed' : intendedDecision);
