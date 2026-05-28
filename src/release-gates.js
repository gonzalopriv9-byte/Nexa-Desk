export const RELEASE_CONTROL_VERSION = '2026-05-owner-gated-rollouts';

export const NEXT_RELEASE_FEATURES = [
  {
    id: 'owner-release-center',
    title: 'Centro privado de lanzamientos',
    description: 'Panel /owner para preparar cambios, probarlos como owner y publicarlos cuando esten listos.',
    type: 'dashboard',
    dashboardPaths: ['/owner'],
    commands: [],
    defaultReleased: true,
    createdAt: '2026-05-28'
  },
  {
    id: 'v15-launch-pack',
    title: 'NexaDesk V1.5 Launch Pack',
    description: 'Seccion visual V1.5 en dashboard y comando /novedades para anunciar la release con funciones listas para video.',
    type: 'release',
    dashboardViews: ['v15'],
    commands: ['novedades'],
    defaultReleased: false,
    createdAt: '2026-05-28'
  }
];

export function normalizeReleaseControl(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled !== false,
    releasedFeatureIds: normalizeStringList(source.releasedFeatureIds),
    manualPendingItems: normalizeManualPendingItems(source.manualPendingItems),
    launchHistory: normalizeLaunchHistory(source.launchHistory),
    lastLaunchAt: normalizeString(source.lastLaunchAt),
    lastLaunchBy: normalizeString(source.lastLaunchBy),
    updatedAt: normalizeString(source.updatedAt)
  };
}

export function buildReleaseState(value = {}, { isOwner = false } = {}) {
  const control = normalizeReleaseControl(value);
  const releasedIds = new Set([
    ...NEXT_RELEASE_FEATURES.filter((feature) => feature.defaultReleased).map((feature) => feature.id),
    ...control.releasedFeatureIds
  ]);

  const features = NEXT_RELEASE_FEATURES.map((feature) => ({
    ...feature,
    released: releasedIds.has(feature.id),
    ownerPreview: isOwner && !releasedIds.has(feature.id)
  }));

  const pendingFeatures = features.filter((feature) => !feature.released);
  const releasedFeatureIds = [...new Set([...control.releasedFeatureIds, ...features.filter((feature) => feature.defaultReleased).map((feature) => feature.id)])];

  return {
    version: RELEASE_CONTROL_VERSION,
    enabled: control.enabled,
    isOwner,
    features,
    pendingFeatures,
    manualPendingItems: control.manualPendingItems,
    releasedFeatureIds,
    lastLaunchAt: control.lastLaunchAt,
    lastLaunchBy: control.lastLaunchBy,
    launchHistory: control.launchHistory,
    hasPending: pendingFeatures.length > 0 || control.manualPendingItems.length > 0,
    updatedAt: control.updatedAt
  };
}

export function findPendingFeatureByCommand(releaseState, commandName) {
  const normalizedCommand = normalizeString(commandName).toLowerCase();
  if (!normalizedCommand || !releaseState?.enabled) return null;
  return (releaseState.features ?? []).find((feature) => {
    if (feature.released) return false;
    return normalizeStringList(feature.commands).map((item) => item.toLowerCase()).includes(normalizedCommand);
  }) ?? null;
}

export function buildLaunchPatch(currentValue = {}, { launchedBy = 'owner' } = {}) {
  const current = normalizeReleaseControl(currentValue);
  const state = buildReleaseState(current);
  const now = new Date().toISOString();
  const launchedFeatureIds = state.pendingFeatures.map((feature) => feature.id);
  const releasedFeatureIds = [...new Set([
    ...current.releasedFeatureIds,
    ...NEXT_RELEASE_FEATURES.filter((feature) => feature.defaultReleased).map((feature) => feature.id),
    ...launchedFeatureIds
  ])];
  const historyEntry = {
    id: `launch-${Date.now()}`,
    launchedAt: now,
    launchedBy: normalizeString(launchedBy) || 'owner',
    featureIds: launchedFeatureIds,
    manualItems: current.manualPendingItems,
    title: launchedFeatureIds.length || current.manualPendingItems.length
      ? `Lanzamiento de ${launchedFeatureIds.length + current.manualPendingItems.length} cambio(s)`
      : 'Lanzamiento sin cambios pendientes'
  };

  return {
    ...current,
    releasedFeatureIds,
    manualPendingItems: [],
    lastLaunchAt: now,
    lastLaunchBy: historyEntry.launchedBy,
    launchHistory: [historyEntry, ...current.launchHistory].slice(0, 30),
    updatedAt: now
  };
}

export function addManualPendingItem(currentValue = {}, item = {}, { createdBy = 'owner' } = {}) {
  const current = normalizeReleaseControl(currentValue);
  const now = new Date().toISOString();
  const title = normalizeString(item.title).slice(0, 90);
  const description = normalizeString(item.description).slice(0, 500);
  if (!title) throw new Error('Pon un titulo para la actualizacion pendiente.');
  return {
    ...current,
    manualPendingItems: [
      {
        id: `manual-${Date.now()}`,
        title,
        description,
        type: normalizeString(item.type).slice(0, 40) || 'nota',
        createdBy: normalizeString(createdBy) || 'owner',
        createdAt: now
      },
      ...current.manualPendingItems
    ].slice(0, 100),
    updatedAt: now
  };
}

function normalizeManualPendingItems(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      id: normalizeString(item?.id) || `manual-${Date.now()}`,
      title: normalizeString(item?.title).slice(0, 90),
      description: normalizeString(item?.description).slice(0, 500),
      type: normalizeString(item?.type).slice(0, 40) || 'nota',
      createdBy: normalizeString(item?.createdBy) || 'owner',
      createdAt: normalizeString(item?.createdAt) || new Date().toISOString()
    }))
    .filter((item) => item.title)
    .slice(0, 100);
}

function normalizeLaunchHistory(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      id: normalizeString(item?.id) || `launch-${Date.now()}`,
      title: normalizeString(item?.title).slice(0, 120) || 'Lanzamiento',
      launchedAt: normalizeString(item?.launchedAt),
      launchedBy: normalizeString(item?.launchedBy) || 'owner',
      featureIds: normalizeStringList(item?.featureIds),
      manualItems: normalizeManualPendingItems(item?.manualItems)
    }))
    .slice(0, 30);
}

function normalizeStringList(value = []) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeString(item)).filter(Boolean))];
}

function normalizeString(value = '') {
  return String(value ?? '').trim();
}
