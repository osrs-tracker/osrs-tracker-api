import type { ResiliencePreset } from '@nestjs/resilience';

/** Largest image `sharp` decodes (e.g. 5000x5000): about 100 MB of raw RGBA. */
export const MAX_IMAGE_PIXELS = 25_000_000;

/**
 * Image conversions running at once per pod. Each can hold a `MAX_IMAGE_BYTES` (10 MB) download and a decode of up to
 * `MAX_IMAGE_PIXELS` (~100 MB): 2 x 110 MB plus the 50 MB image cache and the ~85 MB the pod uses anyway stays well
 * under its 512Mi memory limit (`osrs-tracker-api.yaml`).
 */
export const MAX_CONCURRENT_IMAGE_CONVERSIONS = 2;

/** Conversions waiting for a slot (they hold no image yet); beyond that a request gets 503 at once. */
export const MAX_QUEUED_IMAGE_CONVERSIONS = 10;

/** Longest a conversion waits for a slot before its request gets 503. */
export const IMAGE_QUEUE_TIMEOUT_MS = 10_000;

/** Name of the `@nestjs/resilience` preset every image fetch and conversion (not a cache hit) goes through. */
export const NEWS_IMAGES = 'news-images';

/** Only a bulkhead: caps the memory conversions of distinct images can take, whatever URLs are requested. */
export const NEWS_IMAGES_PRESET: ResiliencePreset = {
  bulkhead: {
    maxConcurrent: MAX_CONCURRENT_IMAGE_CONVERSIONS,
    maxQueue: MAX_QUEUED_IMAGE_CONVERSIONS,
    queueTimeout: IMAGE_QUEUE_TIMEOUT_MS,
  },
};
