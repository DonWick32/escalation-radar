import { reddit, settings } from '@devvit/web/server';
import type { Comment, Post } from '@devvit/web/server';
import {
  T1 as toCommentThingId,
  T3 as toPostThingId,
  isT1,
  isT3,
  type T1,
  type T3,
} from '@devvit/shared-types/tid.js';
import type {
  OnCommentSubmitRequest,
  OnCommentCreateRequest,
  OnAppInstallRequest,
} from '@devvit/web/shared';
import {
  getGeminiCooldownRemainingMs,
  getRadarRuntimeConfig,
  markGeminiCooldown,
  recordCommentReportSignal,
  recordPostReportSignal,
  radarDecisionForResult,
  saveRadarSnapshot,
} from './radarStore';
import type {
  RadarConversationSummary,
  RadarDecision,
  RadarPattern,
  RadarRageBaitCommentSignal,
  RadarRuntimeConfig,
  RadarVelocitySignal,
} from '../shared/dashboard';
import type {
  CommentReport,
  PostReport,
} from '@devvit/protos/json/devvit/events/v1alpha/events.js';

const DEFAULT_HEAT_THRESHOLD = 5;
const DEFAULT_SAMPLE_SIZE = 30;
const DEFAULT_LOOKBACK_MINUTES = 45;
const DEFAULT_FLAIR_TEXT = 'Heated';
const DEFAULT_CHAOTIC_FLAIR_TEXT = 'Chaotic';
const DEFAULT_CHAOTIC_THRESHOLD = 5;
const DEFAULT_CHAOTIC_COMMENT_THRESHOLD = 4;
const DEFAULT_CHAOTIC_REPLY_THRESHOLD = 2;
const SINGLE_USER_CHAOTIC_COMMENT_THRESHOLD = 3;
const HEATED_COMMENT_SCORE = 2.5;
const COMMENT_TREE_DEPTH = 10;
const MAX_FLATTENED_COMMENTS = 250;
const ANCHOR_ANCESTRY_DEPTH = 12;
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_TIMEOUT_MS = 8000;
const HEATED_FLAIR_BACKGROUND = '#d93a00';
const HEATED_FLAIR_TEXT_COLOR = 'light';
const CHAOTIC_FLAIR_BACKGROUND = '#ffb000';
const CHAOTIC_FLAIR_TEXT_COLOR = 'dark';
const RAGE_BAITER_USER_FLAIR_BACKGROUND = '#f0b429';
const RAGE_BAITER_USER_FLAIR_TEXT_COLOR = 'dark';

const HEATED_TERMS = [
  'idiot',
  'moron',
  'stupid',
  'dumb',
  'liar',
  'lying',
  'delusional',
  'pathetic',
  'nonsense',
  'trash',
  'garbage',
  'bullshit',
  'bs',
  'wtf',
  'fuck',
  'fucking',
  'shut up',
];

const HEATED_PHRASES = [
  'are you serious',
  'you are wrong',
  "you're wrong",
  'you have no idea',
  'you clearly',
  'read the',
  'stop lying',
  'try again',
  'no one cares',
  'bad faith',
];

type HeatSettings = {
  enabled: boolean;
  heatThreshold: number;
  sampleSize: number;
  lookbackMinutes: number;
  flairText: string;
  chaoticFlairText: string;
  chaoticThreshold: number;
  chaoticCommentThreshold: number;
  chaoticReplyThreshold: number;
  autoCreateFlair: boolean;
  useGemini: boolean;
  sendAllToGemini: boolean;
  geminiModel: string;
  geminiApiKey?: string;
};

type RawHeatSettings = Partial<Record<keyof HeatSettings, unknown>>;

type TextSignal = {
  score: number;
  reasons: string[];
};

type ThreadComment = {
  id: T1;
  parentId: T1 | T3;
  authorName: string;
  body: string;
  createdAt: Date;
  textScore: number;
  textReasons: string[];
};

type RageBaitCommentCandidate = {
  comment: ThreadComment;
  replyCount: number;
  uniqueRepliers: number;
  heatedReplyCount: number;
  score: number;
  reasons: string[];
};

type GeminiDecision = {
  flag: boolean;
  severity: number;
  confidence: number;
  reason: string;
};

type GeminiResponse = {
  candidates?: {
    finishReason?: string;
    content?: {
      parts?: {
        text?: string;
      }[];
    };
  }[];
  error?: {
    message?: string;
  };
};

type FlairSpec = {
  text: string;
  backgroundColor: string;
  textColor: 'light' | 'dark';
};

export type HeatAction =
  | 'disabled'
  | 'missing-target'
  | 'below-threshold'
  | 'already-flagged'
  | 'flair-applied'
  | 'flair-cleared'
  | 'flair-failed';

export type HeatCheckResult = {
  success: boolean;
  action: HeatAction;
  score: number;
  threshold: number;
  postId?: T3;
  flairText: string;
  reasons: string[];
  message: string;
};

const clampNumber = (
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

const normalizeBoolean = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback;

const normalizeFlairText = (
  value: unknown,
  fallback: string = DEFAULT_FLAIR_TEXT
) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : fallback;
};

const normalizeOptionalString = (value: unknown) => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeModelName = (value: unknown) => {
  const model = normalizeOptionalString(value) ?? DEFAULT_GEMINI_MODEL;
  const normalized = model.replace(/^models\//, '').slice(0, 80);
  return normalized === 'gemini-1.5-flash' ? DEFAULT_GEMINI_MODEL : normalized;
};

const roundScore = (value: number) => Math.round(value * 10) / 10;

const unique = (items: string[]) => Array.from(new Set(items));

const formatAuthorLabel = (authorName: string) => {
  const trimmed = authorName.trim();
  if (!trimmed) {
    return 'unknown user';
  }

  return trimmed.startsWith('u/') || trimmed.startsWith('[')
    ? trimmed
    : `u/${trimmed}`;
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasThingPrefix = (id: string) => /^t[1-6]_/.test(id);

const containsTerm = (text: string, term: string) => {
  const escaped = escapeRegExp(term);
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i').test(text);
};

const normalizeCommentId = (id: string | undefined): T1 | undefined => {
  const trimmed = id?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (hasThingPrefix(trimmed) && !isT1(trimmed)) {
    return undefined;
  }

  return isT1(trimmed) ? trimmed : toCommentThingId(trimmed);
};

const normalizePostId = (id: string | undefined): T3 | undefined => {
  const trimmed = id?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (hasThingPrefix(trimmed) && !isT3(trimmed)) {
    return undefined;
  }

  return isT3(trimmed) ? trimmed : toPostThingId(trimmed);
};

const normalizeParentId = (id: string): T1 | T3 | undefined => {
  if (isT1(id) || isT3(id)) {
    return id;
  }

  return undefined;
};

const loadHeatSettings = async (): Promise<HeatSettings> => {
  const values = await settings.getAll<RawHeatSettings>();
  const geminiApiKey = normalizeOptionalString(values.geminiApiKey);

  return {
    enabled: normalizeBoolean(values.enabled, true),
    heatThreshold: clampNumber(
      values.heatThreshold,
      DEFAULT_HEAT_THRESHOLD,
      4,
      30
    ),
    sampleSize: clampNumber(values.sampleSize, DEFAULT_SAMPLE_SIZE, 10, 100),
    lookbackMinutes: clampNumber(
      values.lookbackMinutes,
      DEFAULT_LOOKBACK_MINUTES,
      5,
      360
    ),
    flairText: normalizeFlairText(values.flairText),
    chaoticFlairText: normalizeFlairText(
      values.chaoticFlairText,
      DEFAULT_CHAOTIC_FLAIR_TEXT
    ),
    chaoticThreshold: clampNumber(
      values.chaoticThreshold,
      DEFAULT_CHAOTIC_THRESHOLD,
      3,
      20
    ),
    chaoticCommentThreshold: clampNumber(
      values.chaoticCommentThreshold,
      DEFAULT_CHAOTIC_COMMENT_THRESHOLD,
      3,
      50
    ),
    chaoticReplyThreshold: clampNumber(
      values.chaoticReplyThreshold,
      DEFAULT_CHAOTIC_REPLY_THRESHOLD,
      2,
      30
    ),
    autoCreateFlair: normalizeBoolean(values.autoCreateFlair, true),
    useGemini: normalizeBoolean(values.useGemini, true),
    sendAllToGemini: normalizeBoolean(values.sendAllToGemini, false),
    geminiModel: normalizeModelName(values.geminiModel),
    ...(geminiApiKey ? { geminiApiKey } : {}),
  };
};

const scoreCommentText = (body: string): TextSignal => {
  const normalized = body.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const termHits = HEATED_TERMS.filter((term) =>
    containsTerm(normalized, term)
  ).length;
  if (termHits > 0) {
    score += Math.min(termHits * 1.4, 4.2);
    reasons.push('charged language');
  }

  const phraseHits = HEATED_PHRASES.filter((phrase) =>
    normalized.includes(phrase)
  ).length;
  if (phraseHits > 0) {
    score += Math.min(phraseHits * 1.3, 3.9);
    reasons.push('argument phrase');
  }

  if (/\b(you|your|youre|you're|u)\b/i.test(body)) {
    score += 0.8;
    reasons.push('direct reply language');
  }

  const letters = body.replace(/[^A-Za-z]/g, '');
  const uppercaseLetters = body.replace(/[^A-Z]/g, '');
  if (letters.length >= 20 && uppercaseLetters.length / letters.length > 0.45) {
    score += 1;
    reasons.push('high caps ratio');
  }

  const punctuationCount = body.match(/[!?]/g)?.length ?? 0;
  if (/[!?]{2,}/.test(body) || punctuationCount >= 4) {
    score += 0.9;
    reasons.push('escalating punctuation');
  }

  return {
    score: roundScore(Math.min(score, 8)),
    reasons,
  };
};

const toThreadComment = (comment: Comment): ThreadComment | undefined => {
  const parentId = normalizeParentId(comment.parentId);
  if (!isT1(comment.id) || !parentId) {
    return undefined;
  }

  const textSignal = scoreCommentText(comment.body);

  return {
    id: comment.id,
    parentId,
    authorName: comment.authorName,
    body: comment.body,
    createdAt: comment.createdAt,
    textScore: textSignal.score,
    textReasons: textSignal.reasons,
  };
};

const loadRecentComments = async (
  postId: T3,
  sampleSize: number
): Promise<Comment[]> => {
  const pageSize = Math.min(sampleSize, 100);
  const roots = await reddit
    .getComments({
      postId,
      sort: 'new',
      limit: sampleSize,
      pageSize,
      depth: COMMENT_TREE_DEPTH,
    })
    .all();

  return flattenCommentTree(roots);
};

const flattenCommentTree = (
  roots: Comment[],
  maxComments = MAX_FLATTENED_COMMENTS
): Comment[] => {
  const flattened: Comment[] = [];
  const seen = new Set<T1>();

  const visit = (comment: Comment, depth: number) => {
    if (!isT1(comment.id) || seen.has(comment.id)) {
      return;
    }

    seen.add(comment.id);
    flattened.push(comment);

    if (flattened.length >= maxComments || depth >= COMMENT_TREE_DEPTH) {
      return;
    }

    for (const reply of comment.replies.children) {
      if (flattened.length >= maxComments) {
        break;
      }

      visit(reply, depth + 1);
    }
  };

  for (const root of roots) {
    if (flattened.length >= maxComments) {
      break;
    }

    visit(root, 0);
  }

  return flattened;
};

const loadAnchorAncestry = async (
  anchorComment?: Comment
): Promise<Comment[]> => {
  if (!anchorComment) {
    return [];
  }

  const ancestors: Comment[] = [];
  const seen = new Set<T1>();
  let parentId = normalizeParentId(anchorComment.parentId);

  while (
    isT1(parentId) &&
    !seen.has(parentId) &&
    ancestors.length < ANCHOR_ANCESTRY_DEPTH
  ) {
    seen.add(parentId);

    try {
      const parent = await reddit.getCommentById(parentId);
      ancestors.push(parent);
      parentId = normalizeParentId(parent.parentId);
    } catch (error: unknown) {
      console.warn('Could not load parent comment for heat context.', error);
      break;
    }
  }

  return ancestors;
};

const dedupeComments = (comments: Comment[]): Comment[] => {
  const seen = new Set<T1>();
  const deduped: Comment[] = [];

  for (const comment of comments) {
    if (!isT1(comment.id) || seen.has(comment.id)) {
      continue;
    }

    seen.add(comment.id);
    deduped.push(comment);
  }

  return deduped;
};

const buildThreadWindow = async (
  postId: T3,
  config: HeatSettings,
  anchorComment?: Comment,
  lookbackMinutes = config.lookbackMinutes
) => {
  const [comments, anchorAncestry] = await Promise.all([
    loadRecentComments(postId, config.sampleSize),
    loadAnchorAncestry(anchorComment),
  ]);
  const contextCommentIds = new Set<T1>(
    [anchorComment, ...anchorAncestry]
      .map((comment) => comment?.id)
      .filter((id): id is T1 => Boolean(id && isT1(id)))
  );
  const threadComments = dedupeComments([
    ...(anchorComment ? [anchorComment] : []),
    ...anchorAncestry,
    ...comments,
  ]);

  const cutoff = Date.now() - lookbackMinutes * 60 * 1000;

  return threadComments
    .filter(
      (comment) =>
        comment.createdAt.getTime() >= cutoff ||
        contextCommentIds.has(comment.id)
    )
    .filter((comment) => !comment.removed && !comment.spam)
    .filter((comment) => !comment.isDistinguished())
    .map(toThreadComment)
    .filter((comment): comment is ThreadComment => Boolean(comment))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
};

const countRecentRepliesBetweenAuthors = (comments: ThreadComment[]) => {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  let replyCount = 0;

  for (const comment of comments) {
    const parent = isT1(comment.parentId)
      ? byId.get(comment.parentId)
      : undefined;
    if (parent && parent.authorName !== comment.authorName) {
      replyCount += 1;
    }
  }

  return replyCount;
};

const commentExcerpt = (body: string) =>
  body.replace(/\s+/g, ' ').trim().slice(0, 140);

const findRageBaitComment = (
  comments: ThreadComment[],
  replyThreshold: number
): RageBaitCommentCandidate | undefined => {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const commentReplies = new Map<
    T1,
    {
      comment: ThreadComment;
      heatedReplyCount: number;
      repliers: Set<string>;
      replyCount: number;
    }
  >();

  for (const comment of comments) {
    const parent = isT1(comment.parentId)
      ? byId.get(comment.parentId)
      : undefined;
    if (!parent || parent.authorName === comment.authorName) {
      continue;
    }

    const existing =
      commentReplies.get(parent.id) ??
      ({
        comment: parent,
        heatedReplyCount: 0,
        repliers: new Set<string>(),
        replyCount: 0,
      } satisfies {
        comment: ThreadComment;
        heatedReplyCount: number;
        repliers: Set<string>;
        replyCount: number;
      });

    existing.replyCount += 1;
    existing.repliers.add(comment.authorName);
    if (comment.textScore >= HEATED_COMMENT_SCORE) {
      existing.heatedReplyCount += 1;
    }

    commentReplies.set(parent.id, existing);
  }

  return [...commentReplies.values()]
    .map((item) => {
      const uniqueRepliers = item.repliers.size;
      const score = roundScore(
        item.replyCount * 0.9 +
          uniqueRepliers * 0.8 +
          item.heatedReplyCount * 1.2 +
          item.comment.textScore
      );
      const hasManyReplies = item.replyCount >= replyThreshold;
      const hasHeatedPressure =
        item.comment.textScore >= HEATED_COMMENT_SCORE ||
        item.heatedReplyCount >= 1;
      const hasBroadPressure = uniqueRepliers >= 2;
      const isRageBaitSignal =
        hasManyReplies && (hasHeatedPressure || hasBroadPressure);

      return {
        comment: item.comment,
        heatedReplyCount: item.heatedReplyCount,
        isRageBaitSignal,
        replyCount: item.replyCount,
        score,
        uniqueRepliers,
        reasons: [
          `${item.replyCount} direct replies`,
          `${uniqueRepliers} unique repliers`,
          ...(item.heatedReplyCount > 0
            ? [`${item.heatedReplyCount} heated replies`]
            : []),
          ...item.comment.textReasons,
        ].slice(0, 4),
      };
    })
    .filter((item) => item.isRageBaitSignal)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.replyCount - a.replyCount ||
        b.heatedReplyCount - a.heatedReplyCount
    )[0];
};

const hasDirectAnchorReply = (
  comments: ThreadComment[],
  anchorComment?: Comment
) => {
  if (!anchorComment || !isT1(anchorComment.parentId)) {
    return false;
  }

  const parent = comments.find(
    (comment) => comment.id === anchorComment.parentId
  );
  return Boolean(parent && parent.authorName !== anchorComment.authorName);
};

const collectAnchorContextIds = (
  comments: ThreadComment[],
  anchorComment?: Comment
) => {
  const contextIds = new Set<T1>();
  if (!anchorComment || !isT1(anchorComment.id)) {
    return contextIds;
  }

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  let parentId = normalizeParentId(anchorComment.parentId);
  contextIds.add(anchorComment.id);

  while (isT1(parentId) && !contextIds.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }

    contextIds.add(parent.id);
    parentId = parent.parentId;
  }

  return contextIds;
};

const scoreThread = (
  comments: ThreadComment[],
  runtimeConfig: RadarRuntimeConfig,
  anchorComment?: Comment
): TextSignal => {
  const reasons: string[] = [];
  let score = 0;

  const authorCounts = new Map<string, number>();
  for (const comment of comments) {
    authorCounts.set(
      comment.authorName,
      (authorCounts.get(comment.authorName) ?? 0) + 1
    );
  }

  const authorCount = authorCounts.size;
  const sortedCounts = [...authorCounts.values()].sort((a, b) => b - a);
  const topPairCount = (sortedCounts[0] ?? 0) + (sortedCounts[1] ?? 0);
  const topPairShare =
    comments.length === 0 ? 0 : topPairCount / comments.length;
  const toxicCommentCount = comments.filter(
    (comment) => comment.textScore >= HEATED_COMMENT_SCORE
  ).length;
  const commentsInLastTenMinutes = comments.filter(
    (comment) => Date.now() - comment.createdAt.getTime() <= 10 * 60 * 1000
  ).length;
  const replyCount = countRecentRepliesBetweenAuthors(comments);
  const rageBaitComment = findRageBaitComment(
    comments,
    runtimeConfig.rageBaitReplyThreshold
  );
  const anchorThreadComment = anchorComment
    ? comments.find((comment) => comment.id === anchorComment.id)
    : undefined;

  if (anchorThreadComment && anchorThreadComment.textScore >= 3) {
    score += anchorThreadComment.textScore;
    reasons.push(...anchorThreadComment.textReasons);
  }

  if (comments.length >= 8) {
    score += comments.length >= 15 ? 2 : 1.2;
    reasons.push('high recent comment volume');
  }

  if (commentsInLastTenMinutes >= 6) {
    score += 1.4;
    reasons.push('fast comment burst');
  }

  if (
    comments.length >= 6 &&
    authorCount <= 3 &&
    topPairShare >= 0.65 &&
    (sortedCounts[1] ?? 0) >= 2
  ) {
    score += 2.4;
    reasons.push('two-user back-and-forth');
  }

  if (replyCount >= 3) {
    score += Math.min(replyCount * 0.7, 2.8);
    reasons.push('cross-author replies');
  }

  if (rageBaitComment) {
    score += Math.min(rageBaitComment.score * 0.45, 3.2);
    reasons.push('comment drew many replies');
  }

  if (hasDirectAnchorReply(comments, anchorComment)) {
    score += 1.6;
    reasons.push('new reply escalates an active branch');
  }

  if (toxicCommentCount >= 3) {
    score += 2;
    reasons.push('multiple heated comments');
  } else if (toxicCommentCount >= 2) {
    score += 1.2;
    reasons.push('repeated heated language');
  }

  return {
    score: roundScore(score),
    reasons: unique(reasons).slice(0, 5),
  };
};

const scoreChaoticThread = (
  comments: ThreadComment[],
  config: HeatSettings,
  runtimeConfig: RadarRuntimeConfig,
  anchorComment?: Comment
): TextSignal => {
  const reasons: string[] = [];
  let score = 0;
  const now = Date.now();
  const authorCounts = new Map<string, number>();
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const pairReplyCounts = new Map<string, number>();

  for (const comment of comments) {
    authorCounts.set(
      comment.authorName,
      (authorCounts.get(comment.authorName) ?? 0) + 1
    );

    const parent = isT1(comment.parentId)
      ? byId.get(comment.parentId)
      : undefined;
    if (parent && parent.authorName !== comment.authorName) {
      const pairKey = [parent.authorName, comment.authorName].sort().join('|');
      pairReplyCounts.set(pairKey, (pairReplyCounts.get(pairKey) ?? 0) + 1);
    }
  }

  const sortedCounts = [...authorCounts.values()].sort((a, b) => b - a);
  const topAuthorCount = sortedCounts[0] ?? 0;
  const topPairCount = (sortedCounts[0] ?? 0) + (sortedCounts[1] ?? 0);
  const topPairShare =
    comments.length === 0 ? 0 : topPairCount / comments.length;
  const topPairReplies = Math.max(0, ...pairReplyCounts.values());
  const commentsInLastTenMinutes = comments.filter(
    (comment) => now - comment.createdAt.getTime() <= 10 * 60 * 1000
  ).length;
  const rageBaitComment = findRageBaitComment(
    comments,
    runtimeConfig.rageBaitReplyThreshold
  );

  if (comments.length >= config.chaoticCommentThreshold) {
    score += 2;
    reasons.push('too many recent comments');
  }

  if (topAuthorCount >= SINGLE_USER_CHAOTIC_COMMENT_THRESHOLD) {
    score = Math.max(score, config.chaoticThreshold);
    reasons.push('same user repeatedly commenting');
  }

  if (
    commentsInLastTenMinutes >= Math.ceil(config.chaoticCommentThreshold / 2)
  ) {
    score += 1.5;
    reasons.push('rapid comment burst');
  }

  if (
    comments.length >= Math.max(4, config.chaoticCommentThreshold - 2) &&
    topPairShare >= 0.65 &&
    (sortedCounts[1] ?? 0) >= 2
  ) {
    score += 2.7;
    reasons.push('two users dominate the thread');
  }

  if (topPairReplies >= config.chaoticReplyThreshold) {
    score += 2.5;
    reasons.push('same two users repeatedly replying');
  }

  if (rageBaitComment) {
    score += 2.2;
    reasons.push('one comment is pulling many replies');
  }

  if (hasDirectAnchorReply(comments, anchorComment)) {
    score += 1;
    reasons.push('new reply continues an active branch');
  }

  return {
    score: roundScore(score),
    reasons: unique(reasons).slice(0, 5),
  };
};

const scoreVelocityAnomaly = (
  comments: ThreadComment[],
  config: RadarRuntimeConfig
): { signal: RadarVelocitySignal; reasons: string[] } => {
  const now = Date.now();
  const windowMs = config.velocityWindowMinutes * 60 * 1000;
  const baselineMs = config.baselineWindowMinutes * 60 * 1000;
  const currentWindowStart = now - windowMs;
  const baselineStart = currentWindowStart - baselineMs;
  const currentComments = comments.filter(
    (comment) => comment.createdAt.getTime() >= currentWindowStart
  );
  const uniqueCommenters = new Set(
    currentComments.map((comment) => comment.authorName)
  ).size;
  const bucketCount = Math.max(
    1,
    Math.ceil(config.baselineWindowMinutes / config.velocityWindowMinutes)
  );
  const buckets = Array.from({ length: bucketCount }, () => 0);

  for (const comment of comments) {
    const createdAt = comment.createdAt.getTime();
    if (createdAt < baselineStart || createdAt >= currentWindowStart) {
      continue;
    }

    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.floor((createdAt - baselineStart) / windowMs)
    );
    buckets[bucketIndex] = (buckets[bucketIndex] ?? 0) + 1;
  }

  const baselineMean =
    buckets.reduce((total, count) => total + count, 0) / bucketCount;
  const variance =
    buckets.reduce((total, count) => total + (count - baselineMean) ** 2, 0) /
    bucketCount;
  const baselineStdDev = Math.sqrt(variance);
  const zScore = roundScore(
    (currentComments.length - baselineMean) / Math.max(baselineStdDev, 1)
  );
  const triggered =
    currentComments.length >= config.minimumCommentsInWindow &&
    uniqueCommenters >= config.uniqueCommenterThreshold &&
    zScore >= config.velocityZThreshold;

  return {
    signal: {
      triggered,
      currentCount: currentComments.length,
      uniqueCommenters,
      baselineMean: roundScore(baselineMean),
      baselineStdDev: roundScore(baselineStdDev),
      zScore,
    },
    reasons: triggered
      ? [
          `velocity anomaly z=${zScore} current=${currentComments.length} baseline=${roundScore(
            baselineMean
          )}`,
        ]
      : [],
  };
};

const summarizeThreadPattern = (
  comments: ThreadComment[],
  config: HeatSettings,
  velocitySignal?: RadarVelocitySignal
): RadarPattern => {
  if (velocitySignal?.triggered) {
    return {
      kind: 'velocity-anomaly',
      label: `${velocitySignal.currentCount} comments in ${velocitySignal.uniqueCommenters} users; z=${velocitySignal.zScore}`,
      count: velocitySignal.currentCount,
    };
  }

  const now = Date.now();
  const authorCounts = new Map<string, number>();
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const pairReplyCounts = new Map<string, number>();

  for (const comment of comments) {
    authorCounts.set(
      comment.authorName,
      (authorCounts.get(comment.authorName) ?? 0) + 1
    );

    const parent = isT1(comment.parentId)
      ? byId.get(comment.parentId)
      : undefined;
    if (parent && parent.authorName !== comment.authorName) {
      const pairKey = [parent.authorName, comment.authorName].sort().join('|');
      pairReplyCounts.set(pairKey, (pairReplyCounts.get(pairKey) ?? 0) + 1);
    }
  }

  const topAuthor = [...authorCounts.entries()].sort(
    ([, a], [, b]) => b - a
  )[0];
  const topPair = [...pairReplyCounts.entries()].sort(
    ([, a], [, b]) => b - a
  )[0];
  const commentsInLastTenMinutes = comments.filter(
    (comment) => now - comment.createdAt.getTime() <= 10 * 60 * 1000
  ).length;

  if (topPair && topPair[1] >= config.chaoticReplyThreshold) {
    const [authorA, authorB] = topPair[0].split('|');
    return {
      kind: 'two-user-back-and-forth',
      label: `${formatAuthorLabel(authorA ?? '')} and ${formatAuthorLabel(
        authorB ?? ''
      )} replied to each other ${topPair[1]} times`,
      count: topPair[1],
    };
  }

  if (topAuthor && topAuthor[1] >= SINGLE_USER_CHAOTIC_COMMENT_THRESHOLD) {
    return {
      kind: 'single-user-flood',
      label: `${formatAuthorLabel(topAuthor[0])} posted ${topAuthor[1]} recent comments`,
      count: topAuthor[1],
    };
  }

  if (
    commentsInLastTenMinutes >= Math.ceil(config.chaoticCommentThreshold / 2)
  ) {
    return {
      kind: 'comment-burst',
      label: `${commentsInLastTenMinutes} comments in the last 10 minutes`,
      count: commentsInLastTenMinutes,
    };
  }

  if (comments.length >= config.chaoticCommentThreshold) {
    return {
      kind: 'high-volume',
      label: `${comments.length} recent comments in the thread`,
      count: comments.length,
    };
  }

  return {
    kind: 'none',
    label: 'No dominant interaction pattern',
    count: 0,
  };
};

type ConversationActorStats = {
  authorName: string;
  label: string;
  commentCount: number;
  heatedCommentCount: number;
  replyCount: number;
  heatScore: number;
};

type ConversationPairStats = {
  authorA: string;
  authorB: string;
  replyCount: number;
};

const summarizeConversation = (
  comments: ThreadComment[],
  runtimeConfig: RadarRuntimeConfig
): RadarConversationSummary => {
  const actorStats = new Map<string, ConversationActorStats>();
  const getActorStats = (authorName: string) => {
    const existing = actorStats.get(authorName);
    if (existing) {
      return existing;
    }

    const created: ConversationActorStats = {
      authorName,
      label: formatAuthorLabel(authorName),
      commentCount: 0,
      heatedCommentCount: 0,
      replyCount: 0,
      heatScore: 0,
    };
    actorStats.set(authorName, created);
    return created;
  };
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const pairStats = new Map<string, ConversationPairStats>();
  let replyCount = 0;
  let heatedCommentCount = 0;

  for (const comment of comments) {
    const actor = getActorStats(comment.authorName);
    actor.commentCount += 1;
    actor.heatScore += comment.textScore;

    if (comment.textScore >= HEATED_COMMENT_SCORE) {
      actor.heatedCommentCount += 1;
      heatedCommentCount += 1;
    }

    const parent = isT1(comment.parentId)
      ? byId.get(comment.parentId)
      : undefined;
    if (!parent || parent.authorName === comment.authorName) {
      continue;
    }

    const parentActor = getActorStats(parent.authorName);
    actor.replyCount += 1;
    parentActor.replyCount += 1;
    replyCount += 1;

    const [authorA, authorB] = [parent.authorName, comment.authorName].sort();
    if (!authorA || !authorB) {
      continue;
    }

    const pairKey = `${authorA}|${authorB}`;
    const existingPair = pairStats.get(pairKey);
    if (existingPair) {
      existingPair.replyCount += 1;
    } else {
      pairStats.set(pairKey, {
        authorA,
        authorB,
        replyCount: 1,
      });
    }
  }

  const toActor = (actor: ConversationActorStats) => ({
    label: actor.label,
    commentCount: actor.commentCount,
    heatedCommentCount: actor.heatedCommentCount,
    replyCount: actor.replyCount,
    heatScore: roundScore(actor.heatScore),
    commentShare: roundScore(
      comments.length === 0 ? 0 : (actor.commentCount / comments.length) * 100
    ),
  });
  const actors = [...actorStats.values()];
  const topAuthorStats = [...actors].sort(
    (a, b) => b.commentCount - a.commentCount || b.heatScore - a.heatScore
  )[0];
  const topPairStats = [...pairStats.values()].sort(
    (a, b) => b.replyCount - a.replyCount
  )[0];
  const summary: RadarConversationSummary = {
    participantCount: actorStats.size,
    replyCount,
    heatedCommentCount,
  };

  if (topAuthorStats) {
    summary.topAuthor = toActor(topAuthorStats);
  }

  if (topPairStats) {
    const actorA = actorStats.get(topPairStats.authorA);
    const actorB = actorStats.get(topPairStats.authorB);
    if (actorA && actorB) {
      summary.topPair = {
        labelA: actorA.label,
        labelB: actorB.label,
        replyCount: topPairStats.replyCount,
        commentCount: actorA.commentCount + actorB.commentCount,
        heatedCommentCount:
          actorA.heatedCommentCount + actorB.heatedCommentCount,
      };
    }
  }

  const rageBaitComment = findRageBaitComment(
    comments,
    runtimeConfig.rageBaitReplyThreshold
  );
  if (rageBaitComment) {
    const signal: RadarRageBaitCommentSignal = {
      label: `comment_${rageBaitComment.comment.id.split('_').at(-1) ?? '1'}`,
      authorLabel: formatAuthorLabel(rageBaitComment.comment.authorName),
      authorName: rageBaitComment.comment.authorName,
      replyCount: rageBaitComment.replyCount,
      uniqueRepliers: rageBaitComment.uniqueRepliers,
      heatedReplyCount: rageBaitComment.heatedReplyCount,
      score: rageBaitComment.score,
      excerpt: commentExcerpt(rageBaitComment.comment.body),
      reasons: rageBaitComment.reasons,
    };
    summary.rageBaitComment = signal;
  }

  const baiterCandidate = actors
    .map((actor) => ({
      actor,
      score: roundScore(
        actor.heatScore +
          actor.commentCount * 0.7 +
          actor.replyCount * 0.9 +
          actor.heatedCommentCount * 1.4 +
          (comments.length > 0 && actor.commentCount / comments.length >= 0.5
            ? 1
            : 0)
      ),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (baiterCandidate) {
    const actor = toActor(baiterCandidate.actor);
    const hasHeatPressure =
      actor.heatedCommentCount > 0 || actor.heatScore >= 3;
    const hasChaosPressure = actor.replyCount >= 3 && actor.commentShare >= 50;
    const isPossibleRageBaiter =
      comments.length >= 3 &&
      actor.commentCount >= 3 &&
      baiterCandidate.score >= 4 &&
      (hasHeatPressure || hasChaosPressure);

    if (isPossibleRageBaiter) {
      summary.rageBaiter = {
        ...actor,
        username: baiterCandidate.actor.authorName,
        score: baiterCandidate.score,
        reasons: [
          `${actor.commentCount} recent comments`,
          ...(actor.heatedCommentCount > 0
            ? [`${actor.heatedCommentCount} heated comments`]
            : []),
          ...(actor.replyCount > 0
            ? [`${actor.replyCount} cross-user replies`]
            : []),
          ...(actor.commentShare >= 45
            ? [`${Math.round(actor.commentShare)}% of recent comments`]
            : []),
        ].slice(0, 4),
      };
    }
  }

  return summary;
};

const suggestModeratorAction = (
  decision: Exclude<RadarDecision, 'failed'>,
  heatScore: number,
  heatThreshold: number,
  chaosScore: number,
  chaosThreshold: number
) => {
  if (decision === 'chaotic') {
    return 'Monitor active reply chain; consider a reminder if replies continue.';
  }

  if (decision === 'heated') {
    return 'Review newest comments; consider a civil reminder before locking.';
  }

  if (
    heatScore >= heatThreshold * 0.75 ||
    chaosScore >= chaosThreshold * 0.75
  ) {
    return 'Watchlist; thread is close to an escalation threshold.';
  }

  return 'No action needed.';
};

const buildGeminiPrompt = (
  post: Post,
  comments: ThreadComment[],
  anchorComment: Comment | undefined,
  signal: TextSignal
) => {
  const authorLabels = new Map<string, string>();
  const labelAuthor = (authorName: string) => {
    const existing = authorLabels.get(authorName);
    if (existing) {
      return existing;
    }

    const label = `user_${authorLabels.size + 1}`;
    authorLabels.set(authorName, label);
    return label;
  };

  const commentContext = comments.slice(0, 14).map((comment) => ({
    id: comment.id,
    author: labelAuthor(comment.authorName),
    isNewComment: anchorComment?.id === comment.id,
    body: comment.body.slice(0, 500),
  }));

  return `You are an early-warning classifier for Reddit moderators.
Decide whether the parent post should be flagged as a heated discussion that may need moderator attention.

Flag true for hostile back-and-forth, personal attacks, escalating insults, threats, or a thread likely to become a moderation cleanup.
Do not flag normal disagreement, criticism of ideas, mild sarcasm, or civil debate.

Your entire response must be exactly one valid JSON object. Do not include markdown, code fences, a preamble, explanation, or any text before or after the JSON.
Required output shape:
{"flag":true|false,"severity":0-100,"confidence":0-1,"reason":"short reason under 120 chars"}

Post title: ${post.title.slice(0, 240)}
Heuristic score: ${signal.score}
Heuristic reasons: ${signal.reasons.join(', ') || 'none'}
Recent comments JSON:
${JSON.stringify(commentContext)}`;
};

const extractJsonObject = (text: string) => {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return cleaned;
  }

  return cleaned.slice(firstBrace, lastBrace + 1);
};

const sanitizeLogPreview = (text: string) =>
  text.replace(/\s+/g, ' ').trim().slice(0, 220);

const parseGeminiDecision = (text: string): GeminiDecision | undefined => {
  const jsonText = extractJsonObject(text);

  try {
    const parsed = JSON.parse(jsonText) as Partial<GeminiDecision>;
    if (
      typeof parsed.flag !== 'boolean' ||
      typeof parsed.severity !== 'number' ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.reason !== 'string'
    ) {
      return undefined;
    }

    return {
      flag: parsed.flag,
      severity: Math.min(Math.max(parsed.severity, 0), 100),
      confidence: Math.min(Math.max(parsed.confidence, 0), 1),
      reason: parsed.reason.trim().slice(0, 120),
    };
  } catch {
    return undefined;
  }
};

const classifyWithGemini = async (
  post: Post,
  comments: ThreadComment[],
  anchorComment: Comment | undefined,
  signal: TextSignal,
  config: HeatSettings
): Promise<GeminiDecision | undefined> => {
  if (!config.useGemini) {
    console.info('Gemini heat classifier skipped: disabled.');
    return undefined;
  }

  if (!config.geminiApiKey) {
    console.info('Gemini heat classifier skipped: missing API key.');
    return undefined;
  }

  if (!config.sendAllToGemini && signal.score < config.heatThreshold) {
    console.info(
      `Gemini heat classifier skipped: heuristic ${signal.score}/${config.heatThreshold}.`
    );
    return undefined;
  }

  const cooldownRemainingMs = await getGeminiCooldownRemainingMs(
    post.subredditName,
    post.id
  );
  if (cooldownRemainingMs > 0) {
    console.info(
      `Gemini heat classifier skipped: cooldown ${Math.ceil(
        cooldownRemainingMs / 1000
      )}s post=${post.id}.`
    );
    return undefined;
  }

  console.info(
    `Gemini heat classifier calling model=${config.geminiModel} heuristic=${signal.score}/${config.heatThreshold} comments=${comments.length} post=${post.id}`
  );
  await markGeminiCooldown(post.subredditName, post.id);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        config.geminiModel
      )}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': config.geminiApiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: buildGeminiPrompt(
                    post,
                    comments,
                    anchorComment,
                    signal
                  ),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    const body = (await response.json()) as GeminiResponse;
    if (!response.ok) {
      console.warn('Gemini heat classifier failed.', body.error?.message);
      return undefined;
    }

    const text =
      body.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('') ?? '';
    const finishReason = body.candidates?.[0]?.finishReason ?? 'unknown';

    const decision = parseGeminiDecision(text);
    if (!decision) {
      console.warn(
        `Gemini heat classifier returned unparsable JSON. finishReason=${finishReason} preview="${sanitizeLogPreview(
          text
        )}"`
      );
      return undefined;
    }

    console.info(
      `Gemini heat classifier result flag=${decision.flag} severity=${decision.severity} confidence=${decision.confidence} reason="${decision.reason}"`
    );

    return decision;
  } catch (error: unknown) {
    console.warn('Gemini heat classifier unavailable.', error);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
};

const ensurePostFlairTemplate = async (
  subredditName: string,
  flair: FlairSpec
) => {
  const templates = await reddit.getPostFlairTemplates(subredditName);
  const existing = templates.find(
    (template) => template.text.toLowerCase() === flair.text.toLowerCase()
  );

  if (existing) {
    return existing.id;
  }

  const created = await reddit.createPostFlairTemplate({
    subredditName,
    text: flair.text,
    backgroundColor: flair.backgroundColor,
    textColor: flair.textColor,
    allowableContent: 'text',
    modOnly: true,
    allowUserEdits: false,
  });

  return created.id;
};

const ensureUserFlairTemplate = async (
  subredditName: string,
  flair: FlairSpec
) => {
  const templates = await reddit.getUserFlairTemplates(subredditName);
  const existing = templates.find(
    (template) => template.text.toLowerCase() === flair.text.toLowerCase()
  );

  if (existing) {
    return existing.id;
  }

  const created = await reddit.createUserFlairTemplate({
    subredditName,
    text: flair.text,
    backgroundColor: flair.backgroundColor,
    textColor: flair.textColor,
    allowableContent: 'text',
    modOnly: true,
    allowUserEdits: false,
  });

  return created.id;
};

const applyHeatFlair = async (
  post: Post,
  config: HeatSettings,
  options: { force?: boolean } = {}
) => {
  const flair: FlairSpec = {
    text: config.flairText,
    backgroundColor: HEATED_FLAIR_BACKGROUND,
    textColor: HEATED_FLAIR_TEXT_COLOR,
  };

  if (
    !options.force &&
    post.flair?.text?.toLowerCase() === flair.text.toLowerCase()
  ) {
    return 'already-flagged' as const;
  }

  let flairTemplateId: string | undefined;
  if (config.autoCreateFlair) {
    try {
      flairTemplateId = await ensurePostFlairTemplate(
        post.subredditName,
        flair
      );
    } catch (error: unknown) {
      console.warn('Could not create or reuse heat flair template.', error);
    }
  }

  await reddit.setPostFlair({
    subredditName: post.subredditName,
    postId: post.id,
    ...(flairTemplateId
      ? { flairTemplateId }
      : {
          text: flair.text,
          backgroundColor: flair.backgroundColor,
          textColor: flair.textColor,
        }),
  });

  return 'flair-applied' as const;
};

const getRageBaiterUsernames = (conversation: RadarConversationSummary) => {
  const usernames = [
    conversation.rageBaiter?.username,
    conversation.rageBaitComment?.authorName,
  ].filter((username): username is string =>
    Boolean(username && username.trim().length > 0)
  );

  return unique(usernames);
};

const applyRageBaiterUserFlairs = async (
  post: Post,
  runtimeConfig: RadarRuntimeConfig,
  conversation: RadarConversationSummary
) => {
  if (!runtimeConfig.rageBaiterUserFlairEnabled) {
    return [];
  }

  const usernames = getRageBaiterUsernames(conversation);
  if (usernames.length === 0) {
    return [];
  }

  const flair: FlairSpec = {
    text: runtimeConfig.rageBaiterUserFlairText,
    backgroundColor: RAGE_BAITER_USER_FLAIR_BACKGROUND,
    textColor: RAGE_BAITER_USER_FLAIR_TEXT_COLOR,
  };
  let flairTemplateId: string | undefined;

  try {
    flairTemplateId = await ensureUserFlairTemplate(post.subredditName, flair);
  } catch (error: unknown) {
    console.warn(
      'Could not create or reuse rage-baiter user flair template.',
      error
    );
  }

  const applied: string[] = [];
  for (const username of usernames) {
    try {
      await reddit.setUserFlair({
        subredditName: post.subredditName,
        username,
        ...(flairTemplateId
          ? { flairTemplateId }
          : {
              text: flair.text,
              backgroundColor: flair.backgroundColor,
              textColor: flair.textColor,
            }),
      });
      applied.push(username);
    } catch (error: unknown) {
      console.warn(
        `Could not apply rage-baiter user flair to ${username}.`,
        error
      );
    }
  }

  return applied;
};

const withRageBaiterUserFlairReason = async (
  post: Post,
  runtimeConfig: RadarRuntimeConfig,
  conversation: RadarConversationSummary,
  reasons: string[]
) => {
  const applied = await applyRageBaiterUserFlairs(
    post,
    runtimeConfig,
    conversation
  );

  if (applied.length === 0) {
    return reasons;
  }

  return unique([
    ...reasons,
    `rage-baiter user flair applied to ${applied.length} user${
      applied.length === 1 ? '' : 's'
    }`,
  ]);
};

const applyChaoticFlair = async (
  post: Post,
  config: HeatSettings,
  options: { force?: boolean } = {}
) => {
  const flair: FlairSpec = {
    text: config.chaoticFlairText,
    backgroundColor: CHAOTIC_FLAIR_BACKGROUND,
    textColor: CHAOTIC_FLAIR_TEXT_COLOR,
  };

  if (
    !options.force &&
    post.flair?.text?.toLowerCase() === flair.text.toLowerCase()
  ) {
    return 'already-flagged' as const;
  }

  let flairTemplateId: string | undefined;
  if (config.autoCreateFlair) {
    try {
      flairTemplateId = await ensurePostFlairTemplate(
        post.subredditName,
        flair
      );
    } catch (error: unknown) {
      console.warn('Could not create or reuse chaotic flair template.', error);
    }
  }

  await reddit.setPostFlair({
    subredditName: post.subredditName,
    postId: post.id,
    ...(flairTemplateId
      ? { flairTemplateId }
      : {
          text: flair.text,
          backgroundColor: flair.backgroundColor,
          textColor: flair.textColor,
        }),
  });

  return 'flair-applied' as const;
};

const isManagedHeatFlair = (post: Post, config: HeatSettings) => {
  const currentFlair = post.flair?.text?.trim().toLowerCase();
  if (!currentFlair) {
    return false;
  }

  return [config.flairText, config.chaoticFlairText].some(
    (flairText) => flairText.trim().toLowerCase() === currentFlair
  );
};

const clearIdleHeatFlair = async (
  post: Post,
  config: HeatSettings,
  runtimeConfig: RadarRuntimeConfig,
  comments: ThreadComment[]
): Promise<HeatCheckResult | undefined> => {
  if (!isManagedHeatFlair(post, config)) {
    return undefined;
  }

  const ttlMs = runtimeConfig.flairTtlMinutes * 60 * 1000;
  const hasRecentComment = comments.some(
    (comment) => Date.now() - comment.createdAt.getTime() <= ttlMs
  );

  if (hasRecentComment) {
    return undefined;
  }

  await reddit.removePostFlair(post.subredditName, post.id);

  return withMessage({
    success: true,
    action: 'flair-cleared',
    score: 0,
    threshold: config.heatThreshold,
    postId: post.id,
    flairText: post.flair?.text ?? config.flairText,
    reasons: [
      `No comments in the last ${runtimeConfig.flairTtlMinutes} minutes`,
    ],
  });
};

const buildResultMessage = (result: Omit<HeatCheckResult, 'message'>) => {
  const reasonText =
    result.reasons.length > 0
      ? ` ${result.reasons.slice(0, 3).join('; ')}.`
      : '';

  if (result.action === 'disabled') {
    return 'EscalationRadar is disabled in app settings.';
  }

  if (result.action === 'missing-target') {
    return 'EscalationRadar could not find the post or comment to analyze.';
  }

  if (result.action === 'flair-applied') {
    return `EscalationRadar applied "${result.flairText}" flair. Score ${result.score}/${result.threshold}.${reasonText}`;
  }

  if (result.action === 'flair-cleared') {
    return `EscalationRadar removed "${result.flairText}" flair.${reasonText}`;
  }

  if (result.action === 'already-flagged') {
    return `EscalationRadar already marked this post. Score ${result.score}/${result.threshold}.${reasonText}`;
  }

  if (result.action === 'flair-failed') {
    return `EscalationRadar saw score ${result.score}/${result.threshold}, but could not set flair.${reasonText}`;
  }

  return `Score ${result.score}/${result.threshold}; no flair needed.${reasonText}`;
};

const withMessage = (
  result: Omit<HeatCheckResult, 'message'>
): HeatCheckResult => ({
  ...result,
  message: buildResultMessage(result),
});

const disabledResult = (config: HeatSettings) =>
  withMessage({
    success: true,
    action: 'disabled',
    score: 0,
    threshold: config.heatThreshold,
    flairText: config.flairText,
    reasons: [],
  });

const missingTargetResult = (config: HeatSettings) =>
  withMessage({
    success: false,
    action: 'missing-target',
    score: 0,
    threshold: config.heatThreshold,
    flairText: config.flairText,
    reasons: [],
  });

const evaluatePostHeat = async (
  post: Post,
  config: HeatSettings,
  anchorComment?: Comment
): Promise<HeatCheckResult> => {
  if (!config.enabled) {
    return disabledResult(config);
  }

  const runtimeConfig = await getRadarRuntimeConfig(post.subredditName);
  const velocityLookbackMinutes =
    runtimeConfig.velocityWindowMinutes + runtimeConfig.baselineWindowMinutes;
  const comments = await buildThreadWindow(
    post.id,
    config,
    anchorComment,
    Math.max(
      config.lookbackMinutes,
      velocityLookbackMinutes,
      runtimeConfig.flairTtlMinutes
    )
  );
  const heatCutoff = Date.now() - config.lookbackMinutes * 60 * 1000;
  const anchorContextIds = collectAnchorContextIds(comments, anchorComment);
  const heatComments = comments.filter(
    (comment) =>
      comment.createdAt.getTime() >= heatCutoff ||
      anchorContextIds.has(comment.id)
  );
  const signal = scoreThread(heatComments, runtimeConfig, anchorComment);
  const chaoticSignal = scoreChaoticThread(
    heatComments,
    config,
    runtimeConfig,
    anchorComment
  );
  const velocity = scoreVelocityAnomaly(comments, runtimeConfig);
  const effectiveChaosScore = velocity.signal.triggered
    ? Math.max(chaoticSignal.score, config.chaoticThreshold)
    : chaoticSignal.score;
  const chaoticReasons = unique([
    ...chaoticSignal.reasons,
    ...velocity.reasons,
  ]).slice(0, 5);
  const pattern = summarizeThreadPattern(heatComments, config, velocity.signal);
  const conversation = summarizeConversation(heatComments, runtimeConfig);
  const chaoticTriggered = effectiveChaosScore >= config.chaoticThreshold;
  const geminiDecision = chaoticTriggered
    ? undefined
    : await classifyWithGemini(
        post,
        heatComments,
        anchorComment,
        signal,
        config
      );
  const effectiveScore = geminiDecision?.flag
    ? Math.max(signal.score, roundScore(geminiDecision.severity / 10))
    : signal.score;
  const reasons = unique([
    ...signal.reasons,
    ...(geminiDecision
      ? [
          `Gemini ${geminiDecision.flag ? 'flagged' : 'cleared'}: ${geminiDecision.reason}`,
        ]
      : []),
  ]).slice(0, 5);
  const heatTriggered =
    Boolean(geminiDecision?.flag) || effectiveScore >= config.heatThreshold;
  const persistResult = async (
    result: HeatCheckResult,
    decision: Exclude<RadarDecision, 'failed'>,
    heatScore: number,
    chaosScore: number,
    overrides: {
      commentCount?: number;
      conversation?: RadarConversationSummary;
      pattern?: RadarPattern;
      suggestedAction?: string;
      velocity?: RadarVelocitySignal;
    } = {}
  ) => {
    await saveRadarSnapshot({
      postId: post.id,
      subredditName: post.subredditName,
      title: post.title,
      permalink: post.permalink,
      action: result.action,
      decision: radarDecisionForResult(result.action, decision),
      flairText: result.flairText,
      heatScore,
      heatThreshold: config.heatThreshold,
      chaosScore,
      chaosThreshold: config.chaoticThreshold,
      commentCount: overrides.commentCount ?? heatComments.length,
      checkedAt: Date.now(),
      reasons: result.reasons,
      pattern: overrides.pattern ?? pattern,
      suggestedAction:
        overrides.suggestedAction ??
        suggestModeratorAction(
          decision,
          heatScore,
          config.heatThreshold,
          chaosScore,
          config.chaoticThreshold
        ),
      workflowState: 'new',
      timeline: [],
      velocity: overrides.velocity ?? velocity.signal,
      conversation: overrides.conversation ?? conversation,
    });

    return result;
  };

  try {
    const idleClearResult = await clearIdleHeatFlair(
      post,
      config,
      runtimeConfig,
      comments
    );
    if (idleClearResult) {
      return persistResult(idleClearResult, 'clear', 0, 0, {
        commentCount: 0,
        conversation: summarizeConversation([], runtimeConfig),
        pattern: {
          kind: 'none',
          label: 'No dominant interaction pattern',
          count: 0,
        },
        suggestedAction: 'No action needed.',
        velocity: scoreVelocityAnomaly([], runtimeConfig).signal,
      });
    }
  } catch (error: unknown) {
    console.warn('Could not clear idle heat flair.', error);
  }

  console.info(
    `Classifier states heat=${heatTriggered} score=${effectiveScore}/${config.heatThreshold} chaos=${chaoticTriggered} score=${effectiveChaosScore}/${config.chaoticThreshold} post=${post.id}`
  );

  if (chaoticTriggered) {
    console.info(
      `Chaotic classifier triggered score=${effectiveChaosScore}/${config.chaoticThreshold} post=${post.id} reasons="${chaoticReasons.join('; ')}"`
    );

    try {
      const action = await applyChaoticFlair(post, config);
      const resultReasons = await withRageBaiterUserFlairReason(
        post,
        runtimeConfig,
        conversation,
        chaoticReasons
      );
      const result = withMessage({
        success: true,
        action,
        score: effectiveChaosScore,
        threshold: config.chaoticThreshold,
        postId: post.id,
        flairText: config.chaoticFlairText,
        reasons: resultReasons,
      });
      return persistResult(
        result,
        'chaotic',
        effectiveScore,
        effectiveChaosScore
      );
    } catch (error: unknown) {
      console.error('Could not apply chaotic flair.', error);
      const result = withMessage({
        success: false,
        action: 'flair-failed',
        score: effectiveChaosScore,
        threshold: config.chaoticThreshold,
        postId: post.id,
        flairText: config.chaoticFlairText,
        reasons: chaoticReasons,
      });
      return persistResult(
        result,
        'chaotic',
        effectiveScore,
        effectiveChaosScore
      );
    }
  }

  if (!heatTriggered) {
    const result = withMessage({
      success: true,
      action: 'below-threshold',
      score: effectiveScore,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons,
    });
    return persistResult(result, 'clear', effectiveScore, effectiveChaosScore);
  }

  try {
    const action = await applyHeatFlair(post, config);
    const resultReasons = await withRageBaiterUserFlairReason(
      post,
      runtimeConfig,
      conversation,
      reasons
    );
    const result = withMessage({
      success: true,
      action,
      score: effectiveScore,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons: resultReasons,
    });
    return persistResult(result, 'heated', effectiveScore, effectiveChaosScore);
  } catch (error: unknown) {
    console.error('Could not apply heat flair.', error);
    const result = withMessage({
      success: false,
      action: 'flair-failed',
      score: effectiveScore,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons,
    });
    return persistResult(result, 'heated', effectiveScore, effectiveChaosScore);
  }
};

export const handleCommentSubmitHeatCheck = async (
  request: OnCommentSubmitRequest | OnCommentCreateRequest
): Promise<HeatCheckResult> => {
  const config = await loadHeatSettings();
  const commentId = normalizeCommentId(request.comment?.id);
  const postId = normalizePostId(request.post?.id ?? request.comment?.postId);

  if (!commentId || !postId) {
    return missingTargetResult(config);
  }

  const [comment, post] = await Promise.all([
    reddit.getCommentById(commentId),
    reddit.getPostById(postId),
  ]);

  return evaluatePostHeat(post, config, comment);
};

const persistReportResult = async (
  post: Post,
  config: HeatSettings,
  result: HeatCheckResult,
  signal: Awaited<ReturnType<typeof recordPostReportSignal>>
) => {
  await saveRadarSnapshot({
    postId: post.id,
    subredditName: post.subredditName,
    title: post.title,
    permalink: post.permalink,
    action: result.action,
    decision: radarDecisionForResult(
      result.action,
      signal.triggered ? 'heated' : 'clear'
    ),
    flairText: result.flairText,
    heatScore: signal.triggered ? config.heatThreshold : signal.reportCount,
    heatThreshold: config.heatThreshold,
    chaosScore: 0,
    chaosThreshold: config.chaoticThreshold,
    commentCount: post.numberOfComments,
    checkedAt: Date.now(),
    reasons: result.reasons,
    pattern: signal.pattern,
    suggestedAction: signal.triggered
      ? 'Review reported content and check whether one user is being targeted.'
      : 'No action needed.',
    workflowState: 'new',
    timeline: [],
  });

  return result;
};

export const handlePostReportHeatCheck = async (
  request: PostReport
): Promise<HeatCheckResult> => {
  const config = await loadHeatSettings();
  const postId = normalizePostId(request.post?.id);

  if (!postId) {
    return missingTargetResult(config);
  }

  const post = await reddit.getPostById(postId);
  const signal = await recordPostReportSignal(
    post.subredditName,
    post.id,
    request.reason
  );

  if (!signal.triggered) {
    const result = withMessage({
      success: true,
      action: 'below-threshold',
      score: signal.reportCount,
      threshold: 3,
      postId: post.id,
      flairText: config.flairText,
      reasons: signal.reasons,
    });
    return persistReportResult(post, config, result, signal);
  }

  try {
    const action = await applyHeatFlair(post, config);
    const result = withMessage({
      success: true,
      action,
      score: config.heatThreshold,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons: signal.reasons,
    });
    return persistReportResult(post, config, result, signal);
  } catch (error: unknown) {
    console.error('Could not apply heat flair after report burst.', error);
    const result = withMessage({
      success: false,
      action: 'flair-failed',
      score: config.heatThreshold,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons: signal.reasons,
    });
    return persistReportResult(post, config, result, signal);
  }
};

export const handleCommentReportHeatCheck = async (
  request: CommentReport
): Promise<HeatCheckResult> => {
  const config = await loadHeatSettings();
  const commentId = normalizeCommentId(request.comment?.id);
  const postId = normalizePostId(request.comment?.postId);

  if (!commentId || !postId) {
    return missingTargetResult(config);
  }

  const [comment, post] = await Promise.all([
    reddit.getCommentById(commentId),
    reddit.getPostById(postId),
  ]);
  const signal = await recordCommentReportSignal(
    post.subredditName,
    post.id,
    comment.authorName,
    request.reason
  );

  if (!signal.triggered) {
    const result = withMessage({
      success: true,
      action: 'below-threshold',
      score: signal.reportCount,
      threshold: 3,
      postId: post.id,
      flairText: config.flairText,
      reasons: signal.reasons,
    });
    return persistReportResult(post, config, result, signal);
  }

  try {
    const action = await applyHeatFlair(post, config);
    const result = withMessage({
      success: true,
      action,
      score: config.heatThreshold,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons: signal.reasons,
    });
    return persistReportResult(post, config, result, signal);
  } catch (error: unknown) {
    console.error(
      'Could not apply heat flair after comment report burst.',
      error
    );
    const result = withMessage({
      success: false,
      action: 'flair-failed',
      score: config.heatThreshold,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons: signal.reasons,
    });
    return persistReportResult(post, config, result, signal);
  }
};

export const handleManualHeatCheck = async (
  targetId: string
): Promise<HeatCheckResult> => {
  const config = await loadHeatSettings();
  const postId = normalizePostId(targetId);

  if (postId) {
    const post = await reddit.getPostById(postId);
    return evaluatePostHeat(post, config);
  }

  const commentId = normalizeCommentId(targetId);
  if (!commentId) {
    return missingTargetResult(config);
  }

  const comment = await reddit.getCommentById(commentId);
  const post = await reddit.getPostById(comment.postId);

  return evaluatePostHeat(post, config, comment);
};

export const handleForceHeatFlair = async (
  targetId: string
): Promise<HeatCheckResult> => {
  const config = await loadHeatSettings();
  const postId = normalizePostId(targetId);

  let post: Post | undefined;
  if (postId) {
    post = await reddit.getPostById(postId);
  } else {
    const commentId = normalizeCommentId(targetId);
    if (!commentId) {
      return missingTargetResult(config);
    }

    const comment = await reddit.getCommentById(commentId);
    post = await reddit.getPostById(comment.postId);
  }

  try {
    const action = await applyHeatFlair(post, config, { force: true });
    return {
      success: true,
      action,
      score: 0,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons: [],
      message: `Reapplied "${config.flairText}" flair. Refresh the post; if it is still hidden, enable post flair display in subreddit settings.`,
    };
  } catch (error: unknown) {
    console.error('Could not force heat flair.', error);
    return {
      success: false,
      action: 'flair-failed',
      score: 0,
      threshold: config.heatThreshold,
      postId: post.id,
      flairText: config.flairText,
      reasons: [],
      message:
        'Could not set flair. Check that post flair is enabled for the subreddit and the app can manage flair.',
    };
  }
};

export const handleForceChaoticFlair = async (
  targetId: string
): Promise<HeatCheckResult> => {
  const config = await loadHeatSettings();
  const postId = normalizePostId(targetId);

  let post: Post | undefined;
  if (postId) {
    post = await reddit.getPostById(postId);
  } else {
    const commentId = normalizeCommentId(targetId);
    if (!commentId) {
      return missingTargetResult(config);
    }

    const comment = await reddit.getCommentById(commentId);
    post = await reddit.getPostById(comment.postId);
  }

  try {
    const action = await applyChaoticFlair(post, config, { force: true });
    return {
      success: true,
      action,
      score: 0,
      threshold: config.chaoticThreshold,
      postId: post.id,
      flairText: config.chaoticFlairText,
      reasons: [],
      message: `Reapplied "${config.chaoticFlairText}" flair. Refresh the post; if it is still hidden, enable post flair display in subreddit settings.`,
    };
  } catch (error: unknown) {
    console.error('Could not force chaotic flair.', error);
    return {
      success: false,
      action: 'flair-failed',
      score: 0,
      threshold: config.chaoticThreshold,
      postId: post.id,
      flairText: config.chaoticFlairText,
      reasons: [],
      message:
        'Could not set flair. Check that post flair is enabled for the subreddit and the app can manage flair.',
    };
  }
};

export const ensureHeatFlairOnInstall = async (
  request: OnAppInstallRequest
) => {
  const config = await loadHeatSettings();
  const subredditName = request.subreddit?.name;

  if (!subredditName || !config.autoCreateFlair) {
    return;
  }

  try {
    await Promise.all([
      ensurePostFlairTemplate(subredditName, {
        text: config.flairText,
        backgroundColor: HEATED_FLAIR_BACKGROUND,
        textColor: HEATED_FLAIR_TEXT_COLOR,
      }),
      ensurePostFlairTemplate(subredditName, {
        text: config.chaoticFlairText,
        backgroundColor: CHAOTIC_FLAIR_BACKGROUND,
        textColor: CHAOTIC_FLAIR_TEXT_COLOR,
      }),
    ]);
  } catch (error: unknown) {
    console.warn('Could not prepare flairs during app install.', error);
  }
};
