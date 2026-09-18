import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ImportRow } from './import.parser';

export interface PreviewRow extends ImportRow {
  duplicate: boolean;
}

interface StoredImport {
  projectId: string;
  userId: string;
  rows: PreviewRow[];
  expiresAt: number;
}

/** Holds parsed previews between preview and confirm. In memory: the API runs as a single container. */
@Injectable()
export class ImportStore {
  private readonly ttlMs = 30 * 60 * 1000;
  private readonly entries = new Map<string, StoredImport>();

  save(projectId: string, userId: string, rows: PreviewRow[]): string {
    this.purgeExpired();
    const id = randomUUID();
    this.entries.set(id, { projectId, userId, rows, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  take(id: string, projectId: string, userId: string): PreviewRow[] {
    this.purgeExpired();
    const entry = this.entries.get(id);
    if (!entry || entry.projectId !== projectId || entry.userId !== userId) {
      throw new NotFoundException('Import preview expired or not found – upload the file again');
    }
    this.entries.delete(id);
    return entry.rows;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
}
