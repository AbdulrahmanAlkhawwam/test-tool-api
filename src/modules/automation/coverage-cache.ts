import { Injectable } from '@nestjs/common';
import { FileTags } from './coverage';

export interface FileScan {
  files: FileTags[];
  /** .ts/.js files inside testsPath that were over the 1 MB scan limit; their content was never downloaded. */
  skippedFiles: string[];
}

/**
 * Tag scans keyed by "<gitlabProjectId>:<commitSha>:<testsPath>". A commit's content never
 * changes, so entries never go stale; the least recently used entry is evicted beyond 100.
 */
@Injectable()
export class CoverageCache {
  private readonly maxEntries = 100;
  private readonly entries = new Map<string, FileScan>();

  get(key: string): FileScan | undefined {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: FileScan): void {
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
