import { AssetVisibility } from 'src/enum.js';
import {
  SyncedFace,
  SyncedMetadata,
  pickMetadataWinner,
  planFaceNames,
  planMetadataSync,
  toSyncedFace,
} from 'src/utils/node-sync-metadata.js';

const empty: SyncedMetadata = {
  createdAt: new Date('2020-06-01T12:00:00.000Z'),
  modifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  dateTimeOriginal: null,
  timeZone: null,
  latitude: null,
  longitude: null,
  rating: null,
  description: null,
  isFavorite: false,
  visibility: AssetVisibility.Timeline,
  tags: [],
  originalFileName: 'IMG_0001.JPG',
};

const taken = new Date('2020-06-01T12:00:00.000Z');

const withMetadata = (overrides: Partial<SyncedMetadata> = {}): SyncedMetadata => ({
  ...empty,
  dateTimeOriginal: taken,
  createdAt: taken,
  timeZone: 'Asia/Jerusalem',
  latitude: 31.77,
  longitude: 35.21,
  rating: 4,
  description: 'Old city',
  tags: ['travel'],
  ...overrides,
});

const face = (id: string, box: [number, number, number, number], name = '', personId: string | null = null) =>
  ({ id, box: { x1: box[0], y1: box[1], x2: box[2], y2: box[3] }, personId, name }) satisfies SyncedFace;

describe('planMetadataSync', () => {
  it('should fill in what one node lost from the other', () => {
    const plan = planMetadataSync(withMetadata(), { ...empty, createdAt: new Date('2026-02-01T00:00:00.000Z') });

    expect(plan.winner).toBe('local');
    expect(plan.local).toEqual({});
    expect(plan.remote).toEqual({
      dateTimeOriginal: { value: taken, timeZone: 'Asia/Jerusalem' },
      location: { latitude: 31.77, longitude: 35.21 },
      rating: 4,
      description: 'Old city',
      tags: ['travel'],
    });
  });

  it('should keep the node with metadata even when its capture date is the newer one', () => {
    const plan = planMetadataSync(
      { ...empty, createdAt: new Date('2010-01-01T00:00:00.000Z'), isFavorite: false },
      withMetadata({ createdAt: new Date('2020-01-01T00:00:00.000Z'), isFavorite: true }),
    );

    expect(plan.winner).toBe('remote');
    expect(plan.local).toMatchObject({ isFavorite: true });
  });

  it('should keep the older capture date where both nodes have metadata that disagrees', () => {
    const original = withMetadata({ description: 'Original caption' });
    const reimported = withMetadata({
      dateTimeOriginal: new Date('2026-03-01T09:00:00.000Z'),
      createdAt: new Date('2026-03-01T09:00:00.000Z'),
      description: 'Imported',
      modifiedAt: new Date('2026-03-02T00:00:00.000Z'),
    });

    const plan = planMetadataSync(reimported, original);

    expect(plan.winner).toBe('remote');
    expect(plan.remote).toEqual({});
    expect(plan.local).toMatchObject({
      dateTimeOriginal: { value: taken, timeZone: 'Asia/Jerusalem' },
      description: 'Original caption',
    });
  });

  it('should keep the more recent edit when both were taken at the same moment', () => {
    const plan = planMetadataSync(
      withMetadata({ rating: 2, modifiedAt: new Date('2026-01-01T00:00:00.000Z') }),
      withMetadata({ rating: 5, modifiedAt: new Date('2026-05-01T00:00:00.000Z') }),
    );

    expect(plan.winner).toBe('remote');
    expect(plan.local).toEqual({ rating: 5 });
    expect(plan.remote).toEqual({});
  });

  it('should treat capture times within a second of each other as the same moment', () => {
    expect(
      pickMetadataWinner(
        withMetadata({ createdAt: new Date('2020-06-01T12:00:00.000Z'), modifiedAt: new Date('2026-05-01') }),
        withMetadata({ createdAt: new Date('2020-06-01T12:00:00.400Z'), modifiedAt: new Date('2026-01-01') }),
      ),
    ).toBe('local');
  });

  it('should add missing tags on both nodes and never remove any', () => {
    const plan = planMetadataSync(
      withMetadata({ tags: ['travel', 'family'] }),
      withMetadata({ tags: ['travel', 'sea'] }),
    );

    expect(plan.local.tags).toEqual(['sea']);
    expect(plan.remote.tags).toEqual(['family']);
  });

  it('should leave a locked asset where it is', () => {
    const plan = planMetadataSync(
      withMetadata({ visibility: AssetVisibility.Locked }),
      withMetadata({ visibility: AssetVisibility.Timeline }),
    );

    expect(plan.local.visibility).toBeUndefined();
    expect(plan.remote.visibility).toBeUndefined();
  });

  it('should carry an archived state across to the winner', () => {
    const plan = planMetadataSync(
      withMetadata({ visibility: AssetVisibility.Archive }),
      withMetadata({ visibility: AssetVisibility.Timeline, createdAt: new Date('2025-01-01T00:00:00.000Z') }),
    );

    expect(plan.remote.visibility).toBe(AssetVisibility.Archive);
  });

  it('should change nothing when both nodes already agree', () => {
    const plan = planMetadataSync(withMetadata(), withMetadata());

    expect(plan.local).toEqual({});
    expect(plan.remote).toEqual({});
  });
});

describe('planMetadataSync capture date and name', () => {
  it('should take the older capture date and real name from a copy with no EXIF date', () => {
    // A re-imported copy: named by id, dated when it was imported.
    const imported = {
      ...empty,
      createdAt: new Date('2026-09-14T05:13:26.000Z'),
      originalFileName: 'ffc6c5db-54c6-440b-9be4-ceb170b5710f.JPG',
    };
    const original = { ...empty, createdAt: new Date('2026-01-17T07:58:56.000Z'), originalFileName: 'IMG_0738.JPG' };

    const plan = planMetadataSync(imported, original);

    expect(plan.winner).toBe('remote');
    expect(plan.local).toEqual({
      dateTimeOriginal: { value: new Date('2026-01-17T07:58:56.000Z'), timeZone: null },
      originalFileName: 'IMG_0738.JPG',
    });
    expect(plan.remote).toEqual({});
  });

  it('should never give a real name up for a generated one', () => {
    const plan = planMetadataSync(
      { ...empty, originalFileName: 'IMG_0738.JPG' },
      { ...empty, originalFileName: '888b97be-e255-4837-89a0-05565d1c6e80.JPG' },
    );

    expect(plan.local.originalFileName).toBeUndefined();
  });
});

describe('planFaceNames', () => {
  it('should name a face that only the other node has named', () => {
    const plan = planFaceNames(
      [face('local-face', [0.1, 0.1, 0.3, 0.3], '', 'local-cluster')],
      [face('remote-face', [0.11, 0.1, 0.31, 0.3], 'Sara', 'remote-sara')],
    );

    expect(plan.local).toEqual([{ faceId: 'local-face', personId: 'local-cluster', name: 'Sara' }]);
    expect(plan.remote).toEqual([]);
  });

  it('should name the other node too', () => {
    const plan = planFaceNames(
      [face('local-face', [0.5, 0.5, 0.7, 0.8], 'Omar', 'local-omar')],
      [face('remote-face', [0.5, 0.5, 0.7, 0.8])],
    );

    expect(plan.remote).toEqual([{ faceId: 'remote-face', personId: null, name: 'Omar' }]);
  });

  it('should not match faces in different parts of the photo', () => {
    const plan = planFaceNames(
      [face('local-face', [0, 0, 0.2, 0.2])],
      [face('remote-face', [0.6, 0.6, 0.9, 0.9], 'Sara')],
    );

    expect(plan.local).toEqual([]);
  });

  it('should leave faces the two nodes named differently alone', () => {
    const plan = planFaceNames(
      [face('local-face', [0.1, 0.1, 0.3, 0.3], 'Sara')],
      [face('remote-face', [0.1, 0.1, 0.3, 0.3], 'Sarah')],
    );

    expect(plan.local).toEqual([]);
    expect(plan.remote).toEqual([]);
  });

  it('should use each face once, closest overlap first', () => {
    const plan = planFaceNames(
      [face('near', [0.1, 0.1, 0.3, 0.3]), face('far', [0.15, 0.1, 0.35, 0.3])],
      [face('remote-face', [0.1, 0.1, 0.3, 0.3], 'Sara')],
    );

    expect(plan.local).toEqual([{ faceId: 'near', personId: null, name: 'Sara' }]);
  });
});

describe('toSyncedFace', () => {
  it('should express the box as fractions of the image', () => {
    expect(
      toSyncedFace(
        {
          id: 'face-1',
          imageWidth: 1000,
          imageHeight: 500,
          boundingBoxX1: 100,
          boundingBoxY1: 50,
          boundingBoxX2: 300,
          boundingBoxY2: 250,
        },
        { id: 'person-1', name: ' Sara ' },
      ),
    ).toEqual({ id: 'face-1', box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.5 }, personId: 'person-1', name: 'Sara' });
  });

  it('should skip a face with no image size', () => {
    expect(
      toSyncedFace(
        {
          id: 'face-1',
          imageWidth: 0,
          imageHeight: 0,
          boundingBoxX1: 1,
          boundingBoxY1: 1,
          boundingBoxX2: 2,
          boundingBoxY2: 2,
        },
        null,
      ),
    ).toBeNull();
  });
});
