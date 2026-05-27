import './styles.css';
import type {
  RadarDashboardData,
  RadarDecision,
  RadarRuntimeConfig,
  RadarThreadSnapshot,
  RadarWorkflowState,
} from '../shared/dashboard';

type DevvitGlobal = {
  context?: {
    subredditName?: string;
  };
};

type DashboardTab = 'overview' | 'threads' | 'settings';

const devvitGlobal = (
  globalThis as typeof globalThis & { devvit?: DevvitGlobal }
).devvit;
const subredditName = devvitGlobal?.context?.subredditName ?? '';
const state: {
  dashboard?: RadarDashboardData;
  filter: 'flagged' | 'all';
  selectedPostIds: Set<string>;
  tab: DashboardTab;
} = {
  filter: 'flagged',
  selectedPostIds: new Set<string>(),
  tab: 'overview',
};

const getElement = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }

  return element as T;
};

const elements = {
  subredditName: getElement('subredditName'),
  refreshButton: getElement<HTMLButtonElement>('refreshButton'),
  overviewTab: getElement<HTMLButtonElement>('overviewTab'),
  threadsTab: getElement<HTMLButtonElement>('threadsTab'),
  settingsTab: getElement<HTMLButtonElement>('settingsTab'),
  overviewPanel: getElement('overviewPanel'),
  threadsPanel: getElement('threadsPanel'),
  settingsPanel: getElement('settingsPanel'),
  chaoticCount: getElement('chaoticCount'),
  heatedCount: getElement('heatedCount'),
  clearCount: getElement('clearCount'),
  totalCount: getElement('totalCount'),
  replyLoopCount: getElement('replyLoopCount'),
  activeChainsCount: getElement('activeChainsCount'),
  rageBaiterCount: getElement('rageBaiterCount'),
  velocitySpikeCount: getElement('velocitySpikeCount'),
  decisionTotalLabel: getElement('decisionTotalLabel'),
  decisionMixChart: getElement('decisionMixChart'),
  workflowChart: getElement('workflowChart'),
  signalChart: getElement('signalChart'),
  patternChart: getElement('patternChart'),
  incidentList: getElement('incidentList'),
  statusLine: getElement('statusLine'),
  flaggedFilter: getElement<HTMLButtonElement>('flaggedFilter'),
  allFilter: getElement<HTMLButtonElement>('allFilter'),
  bulkSelectAll: getElement<HTMLInputElement>('bulkSelectAll'),
  bulkSelectedCount: getElement('bulkSelectedCount'),
  bulkAcknowledgeButton: getElement<HTMLButtonElement>('bulkAcknowledgeButton'),
  bulkResolveButton: getElement<HTMLButtonElement>('bulkResolveButton'),
  bulkIgnoreButton: getElement<HTMLButtonElement>('bulkIgnoreButton'),
  bulkReopenButton: getElement<HTMLButtonElement>('bulkReopenButton'),
  bulkClearSelectionButton: getElement<HTMLButtonElement>(
    'bulkClearSelectionButton'
  ),
  saveConfigButton: getElement<HTMLButtonElement>('saveConfigButton'),
  velocityWindowMinutes: getElement<HTMLInputElement>('velocityWindowMinutes'),
  baselineWindowMinutes: getElement<HTMLInputElement>('baselineWindowMinutes'),
  velocityZThreshold: getElement<HTMLInputElement>('velocityZThreshold'),
  minimumCommentsInWindow: getElement<HTMLInputElement>(
    'minimumCommentsInWindow'
  ),
  uniqueCommenterThreshold: getElement<HTMLInputElement>(
    'uniqueCommenterThreshold'
  ),
  flairTtlMinutes: getElement<HTMLInputElement>('flairTtlMinutes'),
  rageBaitReplyThreshold: getElement<HTMLInputElement>(
    'rageBaitReplyThreshold'
  ),
  rageBaiterUserFlairEnabled: getElement<HTMLInputElement>(
    'rageBaiterUserFlairEnabled'
  ),
  rageBaiterUserFlairText: getElement<HTMLInputElement>(
    'rageBaiterUserFlairText'
  ),
};

const decisionLabel: Record<RadarDecision, string> = {
  chaotic: 'Chaotic',
  heated: 'Heated',
  clear: 'Clear',
  failed: 'Failed',
};

const workflowLabel: Record<RadarWorkflowState, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

const workflowActionDescription: Record<RadarWorkflowState, string> = {
  new: 'Move this incident back into the active triage queue.',
  acknowledged:
    'Mark this incident as seen so other moderators know it is being handled.',
  resolved:
    'Mark this incident as handled and remove it from active flagged triage.',
  ignored: 'Mute this incident from active flagged triage for one hour.',
};

const tabConfig: Record<
  DashboardTab,
  { button: HTMLButtonElement; panel: HTMLElement }
> = {
  overview: {
    button: elements.overviewTab,
    panel: elements.overviewPanel,
  },
  threads: {
    button: elements.threadsTab,
    panel: elements.threadsPanel,
  },
  settings: {
    button: elements.settingsTab,
    panel: elements.settingsPanel,
  },
};

const setText = (element: HTMLElement, text: string | number) => {
  element.textContent = String(text);
};

const setInputValue = (element: HTMLInputElement, value: number) => {
  element.value = String(value);
};

const setTextInputValue = (element: HTMLInputElement, value: string) => {
  element.value = value;
};

const setCheckboxValue = (element: HTMLInputElement, value: boolean) => {
  element.checked = value;
};

const formatScore = (score: number, threshold: number) =>
  `${score.toFixed(1).replace(/\.0$/, '')}/${threshold}`;

const formatRelativeTime = (time: number) => {
  const seconds = Math.max(1, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
};

const createMetaItem = (label: string, value: string) => {
  const item = document.createElement('span');
  item.className = 'meta-item';
  item.textContent = `${label}: ${value}`;
  return item;
};

const renderConfig = (config: RadarRuntimeConfig) => {
  setInputValue(elements.velocityWindowMinutes, config.velocityWindowMinutes);
  setInputValue(elements.baselineWindowMinutes, config.baselineWindowMinutes);
  setInputValue(elements.velocityZThreshold, config.velocityZThreshold);
  setInputValue(
    elements.minimumCommentsInWindow,
    config.minimumCommentsInWindow
  );
  setInputValue(
    elements.uniqueCommenterThreshold,
    config.uniqueCommenterThreshold
  );
  setInputValue(elements.flairTtlMinutes, config.flairTtlMinutes);
  setInputValue(elements.rageBaitReplyThreshold, config.rageBaitReplyThreshold);
  setCheckboxValue(
    elements.rageBaiterUserFlairEnabled,
    config.rageBaiterUserFlairEnabled
  );
  setTextInputValue(
    elements.rageBaiterUserFlairText,
    config.rageBaiterUserFlairText
  );
};

const readConfig = (): RadarRuntimeConfig => ({
  velocityWindowMinutes: Number(elements.velocityWindowMinutes.value),
  baselineWindowMinutes: Number(elements.baselineWindowMinutes.value),
  velocityZThreshold: Number(elements.velocityZThreshold.value),
  minimumCommentsInWindow: Number(elements.minimumCommentsInWindow.value),
  uniqueCommenterThreshold: Number(elements.uniqueCommenterThreshold.value),
  flairTtlMinutes: Number(elements.flairTtlMinutes.value),
  rageBaitReplyThreshold: Number(elements.rageBaitReplyThreshold.value),
  rageBaiterUserFlairEnabled: elements.rageBaiterUserFlairEnabled.checked,
  rageBaiterUserFlairText: elements.rageBaiterUserFlairText.value,
});

const createEmptyDashboard = (): RadarDashboardData => ({
  subredditName: subredditName || 'unknown',
  generatedAt: Date.now(),
  totals: {
    total: 0,
    chaotic: 0,
    heated: 0,
    clear: 0,
    failed: 0,
  },
  config: {
    velocityWindowMinutes: 5,
    baselineWindowMinutes: 30,
    velocityZThreshold: 2.5,
    minimumCommentsInWindow: 4,
    uniqueCommenterThreshold: 3,
    flairTtlMinutes: 60,
    rageBaitReplyThreshold: 4,
    rageBaiterUserFlairEnabled: true,
    rageBaiterUserFlairText: 'Rage baiter',
  },
  incidents: [],
});

const setTab = (tab: DashboardTab) => {
  state.tab = tab;

  for (const key of Object.keys(tabConfig) as DashboardTab[]) {
    const active = key === tab;
    tabConfig[key].button.classList.toggle('nav-tab--active', active);
    tabConfig[key].button.setAttribute('aria-selected', String(active));
    tabConfig[key].panel.classList.toggle('tab-panel--active', active);
    tabConfig[key].panel.hidden = !active;
  }
};

const getWorkflowState = (incident: RadarThreadSnapshot): RadarWorkflowState =>
  incident.workflowState ?? 'new';

const getPatternLabel = (incident: RadarThreadSnapshot) =>
  incident.pattern?.label ?? 'No dominant interaction pattern';

const getPatternKind = (incident: RadarThreadSnapshot) =>
  incident.pattern?.kind ?? 'none';

const getSuggestedAction = (incident: RadarThreadSnapshot) =>
  incident.suggestedAction ?? 'No action needed.';

const createTimelineNode = (incident: RadarThreadSnapshot) => {
  const timeline = incident.timeline?.slice(-8) ?? [];
  const wrapper = document.createElement('div');
  wrapper.className = 'timeline';

  const label = document.createElement('span');
  label.className = 'timeline__label';
  label.textContent = 'Score trend';

  const bars = document.createElement('div');
  bars.className = 'timeline__bars';

  if (timeline.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'timeline__empty';
    empty.textContent = 'No history yet';
    bars.append(empty);
  } else {
    for (const point of timeline) {
      const bar = document.createElement('span');
      const relativeScore = Math.max(
        point.heatScore / Math.max(incident.heatThreshold, 1),
        point.chaosScore / Math.max(incident.chaosThreshold, 1)
      );
      bar.className = `timeline__bar timeline__bar--${point.decision}`;
      bar.style.height = `${Math.max(18, Math.min(100, relativeScore * 100))}%`;
      bar.title = `${formatRelativeTime(point.checkedAt)} heat ${point.heatScore}, chaos ${point.chaosScore}`;
      bars.append(bar);
    }
  }

  wrapper.append(label, bars);
  return wrapper;
};

const createBarMetric = (
  label: string,
  value: number,
  max: number,
  options: { suffix?: string; modifier?: string } = {}
) => {
  const item = document.createElement('div');
  item.className = `conversation-bar${
    options.modifier ? ` conversation-bar--${options.modifier}` : ''
  }`;

  const header = document.createElement('div');
  header.className = 'conversation-bar__header';

  const labelNode = document.createElement('span');
  labelNode.textContent = label;

  const valueNode = document.createElement('strong');
  valueNode.textContent = `${value}${options.suffix ?? ''}`;

  const track = document.createElement('div');
  track.className = 'conversation-bar__track';

  const fill = document.createElement('span');
  fill.className = 'conversation-bar__fill';
  fill.style.width = `${Math.max(8, Math.min(100, (value / max) * 100))}%`;

  header.append(labelNode, valueNode);
  track.append(fill);
  item.append(header, track);
  return item;
};

const createPairGraph = (incident: RadarThreadSnapshot) => {
  const topPair = incident.conversation?.topPair;
  if (!topPair) {
    return undefined;
  }

  const graph = document.createElement('div');
  graph.className = 'pair-graph';

  const actorA = document.createElement('span');
  actorA.className = 'pair-graph__actor';
  actorA.textContent = topPair.labelA;

  const connector = document.createElement('span');
  connector.className = 'pair-graph__connector';
  connector.textContent = `${topPair.replyCount} replies`;

  const actorB = document.createElement('span');
  actorB.className = 'pair-graph__actor';
  actorB.textContent = topPair.labelB;

  graph.append(actorA, connector, actorB);
  return graph;
};

const createConversationNode = (incident: RadarThreadSnapshot) => {
  const conversation = incident.conversation;
  if (!conversation) {
    return undefined;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'conversation';

  const header = document.createElement('div');
  header.className = 'conversation__header';

  const title = document.createElement('span');
  title.className = 'conversation__title';
  title.textContent = 'Interaction graph';

  const summary = document.createElement('span');
  summary.className = 'conversation__summary';
  summary.textContent = `${conversation.participantCount} users, ${conversation.replyCount} cross-user replies`;
  header.append(title, summary);

  const bars = document.createElement('div');
  bars.className = 'conversation__bars';
  bars.append(
    createBarMetric(
      'Participants',
      conversation.participantCount,
      Math.max(6, conversation.participantCount),
      { modifier: 'participants' }
    ),
    createBarMetric(
      'Cross-replies',
      conversation.replyCount,
      Math.max(6, conversation.replyCount),
      { modifier: 'replies' }
    ),
    createBarMetric(
      'Heated comments',
      conversation.heatedCommentCount,
      Math.max(4, conversation.heatedCommentCount),
      { modifier: 'heated' }
    )
  );

  const topAuthor = conversation.topAuthor;
  if (topAuthor) {
    bars.append(
      createBarMetric(
        `${topAuthor.label} share`,
        Math.round(topAuthor.commentShare),
        100,
        { suffix: '%', modifier: 'share' }
      )
    );
  }

  const pairGraph = createPairGraph(incident);
  const details = document.createElement('div');
  details.className = 'conversation__details';
  if (pairGraph) {
    details.append(pairGraph);
  }

  if (conversation.rageBaiter) {
    const baiter = document.createElement('div');
    baiter.className = 'baiter-signal';

    const label = document.createElement('strong');
    label.textContent = `Possible rage baiter: ${conversation.rageBaiter.label}`;

    const reasons = document.createElement('span');
    reasons.textContent = `${conversation.rageBaiter.reasons.join(', ')}; score ${conversation.rageBaiter.score}`;

    baiter.append(label, reasons);
    details.append(baiter);
  }

  if (conversation.rageBaitComment) {
    const baitComment = conversation.rageBaitComment;
    const baiter = document.createElement('div');
    baiter.className = 'baiter-signal';

    const label = document.createElement('strong');
    label.textContent = `Possible rage-bait comment: ${baitComment.label} by ${baitComment.authorLabel}`;

    const reasons = document.createElement('span');
    reasons.textContent = `${baitComment.replyCount} replies from ${baitComment.uniqueRepliers} users; ${baitComment.reasons.join(', ')}; score ${baitComment.score}`;

    const excerpt = document.createElement('span');
    excerpt.textContent = baitComment.excerpt;

    baiter.append(label, reasons, excerpt);
    details.append(baiter);
  }

  wrapper.append(header, bars);
  if (details.childElementCount > 0) {
    wrapper.append(details);
  }

  return wrapper;
};

const updateIncidentState = async (
  postId: string,
  workflowState: RadarWorkflowState,
  options: { reload?: boolean } = {}
) => {
  const response = await fetch('/api/incident-state', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subredditName,
      postId,
      workflowState,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `Workflow update failed: ${response.status}`);
  }

  state.selectedPostIds.delete(postId);

  if (options.reload ?? true) {
    await loadDashboard();
  }
};

const updateSelectedIncidentsState = async (
  workflowState: RadarWorkflowState
) => {
  const selectedPostIds = getVisibleSelectedPostIds();
  if (selectedPostIds.length === 0) {
    return;
  }

  setBulkActionsDisabled(true);
  elements.bulkSelectAll.disabled = true;
  setText(
    elements.statusLine,
    `Updating ${selectedPostIds.length} selected thread${
      selectedPostIds.length === 1 ? '' : 's'
    }...`
  );

  try {
    for (const postId of selectedPostIds) {
      await updateIncidentState(postId, workflowState, { reload: false });
      state.selectedPostIds.delete(postId);
    }

    await loadDashboard();
    setText(
      elements.statusLine,
      `Updated ${selectedPostIds.length} selected thread${
        selectedPostIds.length === 1 ? '' : 's'
      }.`
    );
  } catch (error: unknown) {
    setText(
      elements.statusLine,
      error instanceof Error ? error.message : 'Bulk workflow update failed.'
    );
    updateBulkToolbar();
  }
};

const createActionButton = (
  label: string,
  postId: string,
  workflowState: RadarWorkflowState
) => {
  const button = document.createElement('button');
  button.className = 'action-button';
  button.type = 'button';
  button.textContent = label;
  button.title = workflowActionDescription[workflowState];
  button.ariaLabel = `${label}: ${workflowActionDescription[workflowState]}`;
  button.addEventListener('click', () => {
    button.disabled = true;
    void updateIncidentState(postId, workflowState).catch((error: unknown) => {
      setText(
        elements.statusLine,
        error instanceof Error ? error.message : 'Workflow update failed.'
      );
      button.disabled = false;
    });
  });

  return button;
};

const createWorkflowActions = (incident: RadarThreadSnapshot) => {
  const actions = document.createElement('div');
  actions.className = 'incident-actions';
  const workflowState = getWorkflowState(incident);

  if (workflowState !== 'acknowledged' && workflowState !== 'resolved') {
    actions.append(
      createActionButton('Acknowledge', incident.postId, 'acknowledged')
    );
  }

  if (workflowState !== 'resolved') {
    actions.append(createActionButton('Resolve', incident.postId, 'resolved'));
  }

  actions.append(createActionButton('Ignore 1h', incident.postId, 'ignored'));

  if (workflowState !== 'new') {
    actions.append(createActionButton('Reopen', incident.postId, 'new'));
  }

  return actions;
};

const createIncidentNode = (incident: RadarThreadSnapshot) => {
  const article = document.createElement('article');
  const workflowState = getWorkflowState(incident);
  const selected = state.selectedPostIds.has(incident.postId);
  article.className = `incident incident--${incident.decision} incident--${workflowState}`;
  article.classList.toggle('incident--selected', selected);

  const header = document.createElement('div');
  header.className = 'incident__header';

  const titleBlock = document.createElement('div');
  titleBlock.className = 'incident__title-block';

  const selectorLabel = document.createElement('label');
  selectorLabel.className = 'incident-select';
  selectorLabel.title = 'Select thread';

  const selector = document.createElement('input');
  selector.type = 'checkbox';
  selector.checked = selected;
  selector.ariaLabel = `Select ${incident.title}`;
  selector.addEventListener('change', () => {
    if (selector.checked) {
      state.selectedPostIds.add(incident.postId);
    } else {
      state.selectedPostIds.delete(incident.postId);
    }

    article.classList.toggle('incident--selected', selector.checked);
    updateBulkToolbar();
  });
  selectorLabel.append(selector);

  const status = document.createElement('span');
  status.className = 'badge';
  status.textContent = decisionLabel[incident.decision];

  const workflow = document.createElement('span');
  workflow.className = 'workflow-badge';
  workflow.textContent = workflowLabel[workflowState];

  const title = document.createElement('a');
  title.className = 'incident__title';
  title.href = `https://www.reddit.com${incident.permalink}`;
  title.textContent = incident.title;
  title.target = '_blank';
  title.rel = 'noreferrer';

  titleBlock.append(selectorLabel, status, workflow, title);

  const checkedAt = document.createElement('span');
  checkedAt.className = 'checked-at';
  checkedAt.textContent = formatRelativeTime(incident.checkedAt);

  header.append(titleBlock, checkedAt);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(
    createMetaItem(
      'Heat',
      formatScore(incident.heatScore, incident.heatThreshold)
    ),
    createMetaItem(
      'Chaos',
      formatScore(incident.chaosScore, incident.chaosThreshold)
    ),
    createMetaItem('Comments', String(incident.commentCount)),
    createMetaItem('Action', incident.action),
    createMetaItem('Pattern', getPatternLabel(incident)),
    ...(incident.velocity
      ? [
          createMetaItem(
            'Velocity',
            `z=${incident.velocity.zScore} now=${incident.velocity.currentCount} users=${incident.velocity.uniqueCommenters}`
          ),
        ]
      : [])
  );

  const recommendation = document.createElement('div');
  recommendation.className = 'recommendation';
  recommendation.textContent = getSuggestedAction(incident);

  const reasons = document.createElement('div');
  reasons.className = 'reasons';

  if (incident.reasons.length === 0) {
    const emptyReason = document.createElement('span');
    emptyReason.className = 'reason';
    emptyReason.textContent = 'No classifier reason recorded';
    reasons.append(emptyReason);
  } else {
    for (const reason of incident.reasons) {
      const item = document.createElement('span');
      item.className = 'reason';
      item.textContent = reason;
      reasons.append(item);
    }
  }

  const conversation = createConversationNode(incident);
  const nodes = [
    header,
    meta,
    recommendation,
    reasons,
    ...(conversation ? [conversation] : []),
    createTimelineNode(incident),
    createWorkflowActions(incident),
  ];

  article.append(...nodes);
  return article;
};

const isTemporarilyIgnored = (incident: RadarThreadSnapshot) =>
  getWorkflowState(incident) === 'ignored' &&
  (incident.ignoredUntil ?? 0) > Date.now();

const isHiddenFromFlagged = (incident: RadarThreadSnapshot) =>
  getWorkflowState(incident) === 'resolved' || isTemporarilyIgnored(incident);

const getFlaggedIncidents = (dashboard: RadarDashboardData) =>
  dashboard.incidents.filter(
    (incident) =>
      incident.decision !== 'clear' && !isHiddenFromFlagged(incident)
  );

const getVisibleIncidents = (dashboard: RadarDashboardData) =>
  state.filter === 'flagged'
    ? getFlaggedIncidents(dashboard)
    : dashboard.incidents;

const pruneSelectedPostIds = (dashboard: RadarDashboardData) => {
  const postIds = new Set(
    dashboard.incidents.map((incident) => incident.postId)
  );
  for (const postId of state.selectedPostIds) {
    if (!postIds.has(postId)) {
      state.selectedPostIds.delete(postId);
    }
  }
};

const getVisibleSelectedPostIds = () => {
  if (!state.dashboard) {
    return [];
  }

  const visibleIds = new Set(
    getVisibleIncidents(state.dashboard).map((incident) => incident.postId)
  );
  return [...state.selectedPostIds].filter((postId) => visibleIds.has(postId));
};

const setBulkActionsDisabled = (disabled: boolean) => {
  elements.bulkAcknowledgeButton.disabled = disabled;
  elements.bulkResolveButton.disabled = disabled;
  elements.bulkIgnoreButton.disabled = disabled;
  elements.bulkReopenButton.disabled = disabled;
  elements.bulkClearSelectionButton.disabled = disabled;
};

const updateBulkToolbar = () => {
  const visibleSelectedPostIds = getVisibleSelectedPostIds();
  const selectedCount = visibleSelectedPostIds.length;
  const visibleCount = state.dashboard
    ? getVisibleIncidents(state.dashboard).length
    : 0;

  setText(
    elements.bulkSelectedCount,
    `${selectedCount} selected${visibleCount > 0 ? ` of ${visibleCount}` : ''}`
  );
  elements.bulkSelectAll.checked =
    visibleCount > 0 && selectedCount === visibleCount;
  elements.bulkSelectAll.indeterminate =
    selectedCount > 0 && selectedCount < visibleCount;
  elements.bulkSelectAll.disabled = visibleCount === 0;
  setBulkActionsDisabled(selectedCount === 0);
};

const clearSelection = () => {
  state.selectedPostIds.clear();
  if (state.dashboard) {
    renderIncidents(state.dashboard);
  } else {
    updateBulkToolbar();
  }
};

const setVisibleSelection = (selected: boolean) => {
  if (!state.dashboard) {
    updateBulkToolbar();
    return;
  }

  for (const incident of getVisibleIncidents(state.dashboard)) {
    if (selected) {
      state.selectedPostIds.add(incident.postId);
    } else {
      state.selectedPostIds.delete(incident.postId);
    }
  }

  renderIncidents(state.dashboard);
};

type ChartMetric = {
  label: string;
  value: number;
  modifier: string;
  note?: string;
};

const createChartRow = (metric: ChartMetric, max: number) => {
  const row = document.createElement('div');
  row.className = `chart-row chart-row--${metric.modifier}`;

  const header = document.createElement('div');
  header.className = 'chart-row__header';

  const label = document.createElement('span');
  label.textContent = metric.label;

  const value = document.createElement('strong');
  value.textContent = String(metric.value);

  const track = document.createElement('div');
  track.className = 'chart-row__track';

  const fill = document.createElement('span');
  fill.className = 'chart-row__fill';
  fill.style.width =
    metric.value === 0
      ? '0%'
      : `${Math.max(8, Math.min(100, (metric.value / max) * 100))}%`;

  header.append(label, value);
  track.append(fill);
  row.append(header, track);

  if (metric.note) {
    const note = document.createElement('span');
    note.className = 'chart-row__note';
    note.textContent = metric.note;
    row.append(note);
  }

  return row;
};

const renderChartRows = (
  container: HTMLElement,
  metrics: ChartMetric[],
  emptyText: string
) => {
  if (metrics.length === 0 || metrics.every((metric) => metric.value === 0)) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = emptyText;
    container.replaceChildren(empty);
    return;
  }

  const max = Math.max(1, ...metrics.map((metric) => metric.value));
  container.replaceChildren(
    ...metrics.map((metric) => createChartRow(metric, max))
  );
};

const getConversationMetrics = (incidents: RadarThreadSnapshot[]) => {
  const replyLoops = incidents.reduce(
    (total, incident) =>
      total + (incident.conversation?.topPair?.replyCount ?? 0),
    0
  );
  const activeChains = incidents.filter(
    (incident) =>
      getPatternKind(incident) === 'two-user-back-and-forth' ||
      (incident.conversation?.replyCount ?? 0) >= 3
  ).length;
  const rageBaiters = incidents.filter((incident) =>
    Boolean(
      incident.conversation?.rageBaiter ||
      incident.conversation?.rageBaitComment
    )
  ).length;
  const velocitySpikes = incidents.filter((incident) =>
    Boolean(incident.velocity?.triggered)
  ).length;

  return {
    replyLoops,
    activeChains,
    rageBaiters,
    velocitySpikes,
  };
};

const renderConversationSummary = (dashboard: RadarDashboardData) => {
  const { replyLoops, activeChains, rageBaiters, velocitySpikes } =
    getConversationMetrics(dashboard.incidents);

  setText(elements.replyLoopCount, replyLoops);
  setText(elements.activeChainsCount, activeChains);
  setText(elements.rageBaiterCount, rageBaiters);
  setText(elements.velocitySpikeCount, velocitySpikes);
};

const renderDecisionMixChart = (dashboard: RadarDashboardData) => {
  const decisionMetrics: ChartMetric[] = [
    {
      label: 'Chaotic',
      value: dashboard.totals.chaotic,
      modifier: 'chaotic',
    },
    {
      label: 'Heated',
      value: dashboard.totals.heated,
      modifier: 'heated',
    },
    {
      label: 'Clear',
      value: dashboard.totals.clear,
      modifier: 'clear',
    },
    {
      label: 'Failed',
      value: dashboard.totals.failed,
      modifier: 'failed',
    },
  ];
  const total = Math.max(0, dashboard.totals.total);
  const bar = document.createElement('div');
  bar.className = 'stacked-chart__bar';
  const legend = document.createElement('div');
  legend.className = 'stacked-chart__legend';

  for (const metric of decisionMetrics) {
    const segment = document.createElement('span');
    segment.className = `stacked-chart__segment stacked-chart__segment--${metric.modifier}`;
    segment.style.width =
      total === 0 ? '0%' : `${Math.max(4, (metric.value / total) * 100)}%`;
    segment.title = `${metric.label}: ${metric.value}`;
    bar.append(segment);

    const item = document.createElement('span');
    item.className = `stacked-chart__legend-item stacked-chart__legend-item--${metric.modifier}`;
    item.textContent = `${metric.label} ${metric.value}`;
    legend.append(item);
  }

  setText(
    elements.decisionTotalLabel,
    `${total} tracked thread${total === 1 ? '' : 's'}`
  );
  elements.decisionMixChart.replaceChildren(bar, legend);
};

const renderWorkflowChart = (dashboard: RadarDashboardData) => {
  const workflowCounts: Record<RadarWorkflowState, number> = {
    new: 0,
    acknowledged: 0,
    resolved: 0,
    ignored: 0,
  };

  for (const incident of dashboard.incidents) {
    workflowCounts[getWorkflowState(incident)] += 1;
  }

  renderChartRows(
    elements.workflowChart,
    [
      {
        label: 'New',
        value: workflowCounts.new,
        modifier: 'new',
        note: 'waiting for triage',
      },
      {
        label: 'Acknowledged',
        value: workflowCounts.acknowledged,
        modifier: 'acknowledged',
        note: 'seen by a mod',
      },
      {
        label: 'Resolved',
        value: workflowCounts.resolved,
        modifier: 'resolved',
        note: 'handled',
      },
      {
        label: 'Ignored',
        value: workflowCounts.ignored,
        modifier: 'ignored',
        note: 'muted temporarily',
      },
    ],
    'No workflow activity yet.'
  );
};

const renderSignalChart = (dashboard: RadarDashboardData) => {
  const { replyLoops, activeChains, rageBaiters, velocitySpikes } =
    getConversationMetrics(dashboard.incidents);

  renderChartRows(
    elements.signalChart,
    [
      {
        label: 'Reply loops',
        value: replyLoops,
        modifier: 'loops',
        note: 'cross-user replies in dominant pairs',
      },
      {
        label: 'Active chains',
        value: activeChains,
        modifier: 'chains',
        note: 'threads with back-and-forth pressure',
      },
      {
        label: 'Rage signals',
        value: rageBaiters,
        modifier: 'baiters',
        note: 'users or comments pulling heat',
      },
      {
        label: 'Velocity spikes',
        value: velocitySpikes,
        modifier: 'velocity',
        note: 'bursting faster than baseline',
      },
    ],
    'No conversation pressure recorded yet.'
  );
};

const patternLabel: Record<string, string> = {
  'single-user-flood': 'Single-user flood',
  'two-user-back-and-forth': 'Two-user back-and-forth',
  'velocity-anomaly': 'Velocity anomaly',
  'report-burst': 'Report burst',
  'targeted-reports': 'Targeted reports',
  'comment-burst': 'Comment burst',
  'high-volume': 'High volume',
  none: 'No dominant pattern',
};

const renderPatternChart = (dashboard: RadarDashboardData) => {
  const patternCounts = new Map<string, number>();
  for (const incident of dashboard.incidents) {
    const kind = getPatternKind(incident);
    patternCounts.set(kind, (patternCounts.get(kind) ?? 0) + 1);
  }

  const metrics = [...patternCounts.entries()]
    .filter(([kind]) => kind !== 'none')
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([kind, value]) => ({
      label: patternLabel[kind] ?? kind,
      value,
      modifier: kind.replace(/[^a-z0-9]+/g, '-'),
    }));

  renderChartRows(elements.patternChart, metrics, 'No dominant patterns yet.');
};

const renderOverviewCharts = (dashboard: RadarDashboardData) => {
  renderDecisionMixChart(dashboard);
  renderWorkflowChart(dashboard);
  renderSignalChart(dashboard);
  renderPatternChart(dashboard);
};

const renderIncidents = (dashboard: RadarDashboardData) => {
  const incidents = getVisibleIncidents(dashboard);

  if (incidents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      state.filter === 'flagged'
        ? 'No flagged threads yet.'
        : 'No thread checks stored yet.';
    elements.incidentList.replaceChildren(empty);
    updateBulkToolbar();
    return;
  }

  elements.incidentList.replaceChildren(...incidents.map(createIncidentNode));
  updateBulkToolbar();
};

const renderDashboard = (dashboard: RadarDashboardData) => {
  pruneSelectedPostIds(dashboard);
  setText(elements.subredditName, dashboard.subredditName);
  renderConfig(dashboard.config);
  setText(elements.chaoticCount, dashboard.totals.chaotic);
  setText(elements.heatedCount, dashboard.totals.heated);
  setText(elements.clearCount, dashboard.totals.clear);
  setText(elements.totalCount, dashboard.totals.total);
  renderConversationSummary(dashboard);
  renderOverviewCharts(dashboard);
  renderIncidents(dashboard);
  setText(
    elements.statusLine,
    `Updated ${new Date(dashboard.generatedAt).toLocaleTimeString()}`
  );
};

const saveConfig = async () => {
  if (!subredditName) {
    setText(elements.statusLine, 'Subreddit context was not available.');
    return;
  }

  elements.saveConfigButton.disabled = true;
  setText(elements.statusLine, 'Saving detection settings...');

  try {
    const response = await fetch('/api/dashboard-config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subredditName,
        config: readConfig(),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(body.error ?? `Config update failed: ${response.status}`);
    }

    await loadDashboard();
    setText(elements.statusLine, 'Detection settings saved.');
  } catch (error: unknown) {
    setText(
      elements.statusLine,
      error instanceof Error ? error.message : 'Could not save settings.'
    );
  } finally {
    elements.saveConfigButton.disabled = false;
  }
};

const setFilter = (filter: 'flagged' | 'all') => {
  state.filter = filter;
  elements.flaggedFilter.classList.toggle(
    'segment--active',
    filter === 'flagged'
  );
  elements.allFilter.classList.toggle('segment--active', filter === 'all');

  if (state.dashboard) {
    renderIncidents(state.dashboard);
  }
};

const loadDashboard = async () => {
  if (!subredditName) {
    state.dashboard = createEmptyDashboard();
    renderDashboard(state.dashboard);
    setText(elements.statusLine, 'Subreddit context was not available.');
    return;
  }

  elements.refreshButton.disabled = true;
  setText(elements.statusLine, 'Refreshing dashboard data...');

  try {
    const response = await fetch(
      `/api/dashboard?subredditName=${encodeURIComponent(subredditName)}`
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(
        body.error ?? `Dashboard request failed: ${response.status}`
      );
    }

    state.dashboard = (await response.json()) as RadarDashboardData;
    renderDashboard(state.dashboard);
  } catch (error: unknown) {
    setText(
      elements.statusLine,
      error instanceof Error ? error.message : 'Could not load dashboard.'
    );
  } finally {
    elements.refreshButton.disabled = false;
  }
};

elements.refreshButton.addEventListener('click', () => {
  void loadDashboard();
});
elements.overviewTab.addEventListener('click', () => setTab('overview'));
elements.threadsTab.addEventListener('click', () => setTab('threads'));
elements.settingsTab.addEventListener('click', () => setTab('settings'));
elements.flaggedFilter.addEventListener('click', () => setFilter('flagged'));
elements.allFilter.addEventListener('click', () => setFilter('all'));
elements.bulkSelectAll.addEventListener('change', () => {
  setVisibleSelection(elements.bulkSelectAll.checked);
});
elements.bulkAcknowledgeButton.addEventListener('click', () => {
  void updateSelectedIncidentsState('acknowledged');
});
elements.bulkResolveButton.addEventListener('click', () => {
  void updateSelectedIncidentsState('resolved');
});
elements.bulkIgnoreButton.addEventListener('click', () => {
  void updateSelectedIncidentsState('ignored');
});
elements.bulkReopenButton.addEventListener('click', () => {
  void updateSelectedIncidentsState('new');
});
elements.bulkClearSelectionButton.addEventListener('click', clearSelection);
elements.saveConfigButton.addEventListener('click', () => {
  void saveConfig();
});

setText(elements.subredditName, subredditName || 'unknown');
void loadDashboard();
window.setInterval(() => {
  void loadDashboard();
}, 30_000);
