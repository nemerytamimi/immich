import { AssetVisibility } from 'src/enum';

/** Two capture times this close are the same moment, whatever precision each side stored. */
const SAME_MOMENT_MS = 1000;

/** How far apart two coordinates can be and still be the same place. */
const SAME_PLACE_DEGREES = 1e-6;

/** How much two face boxes have to overlap to be taken as the same face, seen by both nodes. */
const SAME_FACE_OVERLAP = 0.5;

export type SyncSide = 'local' | 'remote';

/** One node's metadata for an asset both nodes hold, in a shape the two can be compared in. */
export type SyncedMetadata = {
  /**
   * When the photo was taken, falling back to when the file was created. This is
   * the date the timeline shows, so it is what gets compared and copied: a copy
   * with no EXIF date at all still carries its date in the file's creation time.
   */
  createdAt: Date | null;
  /** When the asset last changed on this node. */
  modifiedAt: Date | null;
  dateTimeOriginal: Date | null;
  timeZone: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  description: string | null;
  isFavorite: boolean;
  visibility: AssetVisibility;
  tags: string[];
  originalFileName: string;
};

/** What has to change on one node to bring it in line. Only what differs is present. */
export type MetadataChanges = {
  dateTimeOriginal?: { value: Date; timeZone: string | null };
  location?: { latitude: number; longitude: number };
  rating?: number;
  description?: string;
  isFavorite?: boolean;
  visibility?: AssetVisibility;
  /** Tags to add. Tags are never removed. */
  tags?: string[];
  /** Only ever applied locally: another node's API has no way to rename a file. */
  originalFileName?: string;
};

export type MetadataPlan = {
  /** The node whose values are kept where both nodes have one and they disagree. */
  winner: SyncSide;
  local: MetadataChanges;
  remote: MetadataChanges;
};

const hasMetadata = (side: SyncedMetadata) =>
  side.dateTimeOriginal !== null ||
  side.latitude !== null ||
  !!side.description ||
  side.rating !== null ||
  side.tags.length > 0;

/**
 * Which node's metadata to keep where the two disagree.
 *
 * Metadata goes missing far more often than it is deliberately rewritten: a
 * re-import, a lost sidecar or a restore from a bare file all leave an asset
 * with no capture date, or with the import time standing in for it. So a node
 * that has metadata beats one that has none, and between two that both have
 * some, the older capture date is the original and wins. Only when both were
 * taken at the same moment is the more recent edit taken as the intended one.
 */
export const pickMetadataWinner = (local: SyncedMetadata, remote: SyncedMetadata): SyncSide => {
  const localHasMetadata = hasMetadata(local);
  if (localHasMetadata !== hasMetadata(remote)) {
    return localHasMetadata ? 'local' : 'remote';
  }

  if (local.createdAt && remote.createdAt) {
    const difference = local.createdAt.getTime() - remote.createdAt.getTime();
    if (Math.abs(difference) >= SAME_MOMENT_MS) {
      return difference < 0 ? 'local' : 'remote';
    }
  }

  return (remote.modifiedAt?.getTime() ?? 0) > (local.modifiedAt?.getTime() ?? 0) ? 'remote' : 'local';
};

/**
 * Settle one field. A value on one node only is copied to the other, since an
 * empty field is taken as lost rather than cleared. Where both nodes have a
 * value and they differ, the winner's is kept.
 */
const settle = <T>(
  plan: MetadataPlan,
  local: T | null,
  remote: T | null,
  isSame: (a: T, b: T) => boolean,
  apply: (changes: MetadataChanges, value: T, source: SyncSide) => void,
) => {
  if (local === null) {
    if (remote !== null) {
      apply(plan.local, remote, 'remote');
    }
    return;
  }

  if (remote === null) {
    apply(plan.remote, local, 'local');
    return;
  }

  if (isSame(local, remote)) {
    return;
  }

  if (plan.winner === 'local') {
    apply(plan.remote, local, 'local');
  } else {
    apply(plan.local, remote, 'remote');
  }
};

/**
 * A file name that is only an id -- what an export keyed by asset id, or an
 * import of one, leaves behind. It says nothing about the photo, so it is treated
 * as missing and the other node's real name is taken instead.
 */
const GENERATED_NAME = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}(\.\w+)?$/i;

const asMeaningfulName = (name: string) => (!name || GENERATED_NAME.test(name) ? null : name);

const asLocation = ({ latitude, longitude }: SyncedMetadata) =>
  latitude === null || longitude === null ? null : { latitude, longitude };

/**
 * Only these can be set through another node's API. A locked asset is out of
 * reach of an API key altogether, and a hidden one is the video half of a live
 * photo, which follows its still rather than being set on its own.
 */
const isSyncableVisibility = (visibility: AssetVisibility) =>
  visibility === AssetVisibility.Timeline || visibility === AssetVisibility.Archive;

/** Work out what each node needs so both end up with the same metadata for a matched asset. */
export const planMetadataSync = (local: SyncedMetadata, remote: SyncedMetadata): MetadataPlan => {
  const plan: MetadataPlan = { winner: pickMetadataWinner(local, remote), local: {}, remote: {} };
  const sides = { local, remote };

  settle(
    plan,
    local.createdAt,
    remote.createdAt,
    (a, b) => Math.abs(a.getTime() - b.getTime()) < SAME_MOMENT_MS,
    (changes, value, source) => {
      changes.dateTimeOriginal = { value, timeZone: sides[source].timeZone };
    },
  );

  settle(
    plan,
    asLocation(local),
    asLocation(remote),
    (a, b) =>
      Math.abs(a.latitude - b.latitude) < SAME_PLACE_DEGREES &&
      Math.abs(a.longitude - b.longitude) < SAME_PLACE_DEGREES,
    (changes, value) => {
      changes.location = value;
    },
  );

  settle(
    plan,
    local.rating,
    remote.rating,
    (a, b) => a === b,
    (changes, value) => {
      changes.rating = value;
    },
  );

  settle(
    plan,
    local.description || null,
    remote.description || null,
    (a, b) => a === b,
    (changes, value) => {
      changes.description = value;
    },
  );

  // A favourite flag always has a value, so there is never anything to fill in:
  // where the two differ, the winner decides.
  settle(
    plan,
    local.isFavorite,
    remote.isFavorite,
    (a, b) => a === b,
    (changes, value) => {
      changes.isFavorite = value;
    },
  );

  if (isSyncableVisibility(local.visibility) && isSyncableVisibility(remote.visibility)) {
    settle(
      plan,
      local.visibility,
      remote.visibility,
      (a, b) => a === b,
      (changes, value) => {
        changes.visibility = value;
      },
    );
  }

  settle(
    plan,
    asMeaningfulName(local.originalFileName),
    asMeaningfulName(remote.originalFileName),
    (a, b) => a === b,
    (changes, value) => {
      changes.originalFileName = value;
    },
  );

  // A tag missing on one node is taken as lost, like any other empty field, so
  // tags only ever accumulate. Removing a tag on one node does not remove it from
  // the other.
  const missingLocally = remote.tags.filter((tag) => !local.tags.includes(tag));
  const missingRemotely = local.tags.filter((tag) => !remote.tags.includes(tag));

  if (missingLocally.length > 0) {
    plan.local.tags = missingLocally;
  }

  if (missingRemotely.length > 0) {
    plan.remote.tags = missingRemotely;
  }

  return plan;
};

export const hasMetadataChanges = (changes: MetadataChanges) => Object.keys(changes).length > 0;

/** A detected face, with its box as fractions of the image so both nodes' renders compare. */
export type SyncedFace = {
  id: string;
  box: { x1: number; y1: number; x2: number; y2: number };
  /** The person the face is assigned to, named or not. */
  personId: string | null;
  name: string;
};

/**
 * A face that should carry a name it only has on the other node. `personId` is
 * the unnamed person the face already belongs to, if any, which is named rather
 * than replaced so the rest of its cluster comes along.
 */
export type FaceNaming = {
  faceId: string;
  personId: string | null;
  name: string;
};

type FaceBox = {
  id: string;
  imageWidth: number;
  imageHeight: number;
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
};

/** Null for a face with no image size, whose box cannot be compared with anything. */
export const toSyncedFace = (
  face: FaceBox,
  person: { id: string; name: string | null } | null | undefined,
): SyncedFace | null => {
  if (!face.imageWidth || !face.imageHeight) {
    return null;
  }

  return {
    id: face.id,
    box: {
      x1: face.boundingBoxX1 / face.imageWidth,
      y1: face.boundingBoxY1 / face.imageHeight,
      x2: face.boundingBoxX2 / face.imageWidth,
      y2: face.boundingBoxY2 / face.imageHeight,
    },
    personId: person?.id ?? null,
    name: (person?.name ?? '').trim(),
  };
};

const area = (box: SyncedFace['box']) => Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);

/** Intersection over union: 1 for the same box, 0 for boxes that do not touch. */
const overlap = (a: SyncedFace['box'], b: SyncedFace['box']) => {
  const width = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const height = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const intersection = width * height;
  const union = area(a) + area(b) - intersection;
  return union <= 0 ? 0 : intersection / union;
};

/**
 * Carry names across onto faces both nodes have detected.
 *
 * Faces are matched by where they sit in the photo, closest overlap first, each
 * face used once. A name only ever fills in a face that has none: two nodes that
 * named the same face differently are left alone, because telling a correction
 * from a mistake is not something a sync can do.
 */
export const planFaceNames = (local: SyncedFace[], remote: SyncedFace[]) => {
  const candidates = local
    .flatMap((localFace) =>
      remote.map((remoteFace) => ({ localFace, remoteFace, score: overlap(localFace.box, remoteFace.box) })),
    )
    .filter(({ score }) => score >= SAME_FACE_OVERLAP)
    .toSorted((a, b) => b.score - a.score);

  const matchedLocal = new Set<string>();
  const matchedRemote = new Set<string>();
  const plan = { local: [] as FaceNaming[], remote: [] as FaceNaming[] };

  for (const { localFace, remoteFace } of candidates) {
    if (matchedLocal.has(localFace.id) || matchedRemote.has(remoteFace.id)) {
      continue;
    }

    matchedLocal.add(localFace.id);
    matchedRemote.add(remoteFace.id);

    if (!localFace.name && remoteFace.name) {
      plan.local.push({ faceId: localFace.id, personId: localFace.personId, name: remoteFace.name });
    } else if (localFace.name && !remoteFace.name) {
      plan.remote.push({ faceId: remoteFace.id, personId: remoteFace.personId, name: localFace.name });
    }
  }

  return plan;
};
