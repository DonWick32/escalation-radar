export type RadarDecision = 'chaotic' | 'heated' | 'clear' | 'failed';

export type RadarWorkflowState =
  | 'new'
  | 'acknowledged'
  | 'resolved'
  | 'ignored';

export type RadarPattern = {
  kind:
    | 'single-user-flood'
    | 'two-user-back-and-forth'
    | 'velocity-anomaly'
    | 'report-burst'
    | 'targeted-reports'
    | 'comment-burst'
    | 'high-volume'
    | 'none';
  label: string;
  count: number;
};

export type RadarScorePoint = {
  checkedAt: number;
  decision: RadarDecision;
  heatScore: number;
  chaosScore: number;
};

export type RadarRuntimeConfig = {
  velocityWindowMinutes: number;
  baselineWindowMinutes: number;
  velocityZThreshold: number;
  minimumCommentsInWindow: number;
  uniqueCommenterThreshold: number;
  flairTtlMinutes: number;
  rageBaitReplyThreshold: number;
  rageBaiterUserFlairEnabled: boolean;
  rageBaiterUserFlairText: string;
};

export type RadarVelocitySignal = {
  triggered: boolean;
  currentCount: number;
  uniqueCommenters: number;
  baselineMean: number;
  baselineStdDev: number;
  zScore: number;
};

export type RadarConversationActor = {
  label: string;
  commentCount: number;
  heatedCommentCount: number;
  replyCount: number;
  heatScore: number;
  commentShare: number;
};

export type RadarConversationPair = {
  labelA: string;
  labelB: string;
  replyCount: number;
  commentCount: number;
  heatedCommentCount: number;
};

export type RadarRageBaiterSignal = RadarConversationActor & {
  username: string;
  score: number;
  reasons: string[];
};

export type RadarRageBaitCommentSignal = {
  label: string;
  authorLabel: string;
  authorName: string;
  replyCount: number;
  uniqueRepliers: number;
  heatedReplyCount: number;
  score: number;
  excerpt: string;
  reasons: string[];
};

export type RadarConversationSummary = {
  participantCount: number;
  replyCount: number;
  heatedCommentCount: number;
  topAuthor?: RadarConversationActor;
  topPair?: RadarConversationPair;
  rageBaiter?: RadarRageBaiterSignal;
  rageBaitComment?: RadarRageBaitCommentSignal;
};

export type RadarThreadSnapshot = {
  postId: string;
  subredditName: string;
  title: string;
  permalink: string;
  action: string;
  decision: RadarDecision;
  flairText: string;
  heatScore: number;
  heatThreshold: number;
  chaosScore: number;
  chaosThreshold: number;
  commentCount: number;
  checkedAt: number;
  reasons: string[];
  pattern: RadarPattern;
  suggestedAction: string;
  workflowState: RadarWorkflowState;
  workflowUpdatedAt?: number;
  ignoredUntil?: number;
  timeline: RadarScorePoint[];
  velocity?: RadarVelocitySignal;
  conversation?: RadarConversationSummary;
};

export type RadarDashboardData = {
  subredditName: string;
  generatedAt: number;
  totals: {
    total: number;
    chaotic: number;
    heated: number;
    clear: number;
    failed: number;
  };
  config: RadarRuntimeConfig;
  incidents: RadarThreadSnapshot[];
};
