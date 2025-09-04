import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { BatchSyncResponse, SyncQueueItem } from '../types/index';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Trigger manual sync
  router.post('/sync', async (_req: Request, res: Response) => {
    const connect = await syncService.checkConnectivity();
    if (!connect) {
      return res.status(503).json({ error: 'No connectivity to remote server' });
    }
    try {
      const result = await syncService.sync();
      return res.json({ message: 'Sync completed', result });
    } catch (error: unknown) {
      if (error instanceof Error) {
        return res.status(500).json({ error: 'Sync failed', details: error.message });
      }
      return res.status(500).json({ error: 'Sync failed', details: 'Unknown error' });
    }
  });

  // Check sync status
  router.get('/status', async (_req: Request, res: Response) => {
    const row = await db.get<{ pending_count: number }>(
      `SELECT COUNT(*) as pending_count FROM sync_queue`
    );
    const pendingCount = row?.pending_count || 0;

    const lastSyncRow = await db.get<{ last_sync: string | null }>(
      `SELECT MAX(last_synced_at) as last_sync FROM tasks WHERE last_synced_at IS NOT NULL`
    );
    const lastSync = lastSyncRow?.last_sync || null;

    const connectivity = await syncService.checkConnectivity();

    return res.json({
      pending_count: pendingCount,
      last_sync: lastSync,
      connectivity,
    });
  });

  // Batch sync endpoint (for server-side)
 router.post('/batch', async (req: Request, res: Response) => {
  try {
    const items: SyncQueueItem[] = req.body?.items;
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Invalid batch payload' });
    }

    const processed_items: BatchSyncResponse['processed_items'] = [];

    for (const item of items) {
      try {
        if (item.operation === 'create') {
          await db.run(
            `INSERT INTO tasks (id, title, description, completed, updated_at, sync_status, server_id, last_synced_at)
             VALUES (?, ?, ?, ?, datetime('now'), 'synced', ?, datetime('now'))`,
            [
              item.data.id,
              item.data.title,
              item.data.description || null,
              item.data.completed ? 1 : 0,
              item.data.server_id || null,
            ]
          );
        } else if (item.operation === 'update') {
          await db.run(
            `UPDATE tasks
             SET title = ?, description = ?, completed = ?, updated_at = datetime('now'),
                 sync_status = 'synced', last_synced_at = datetime('now')
             WHERE id = ?`,
            [
              item.data.title,
              item.data.description || null,
              item.data.completed ? 1 : 0,
              item.task_id,
            ]
          );
        } else if (item.operation === 'delete') {
          await db.run(
            `UPDATE tasks
             SET is_deleted = 1, updated_at = datetime('now'),
                 sync_status = 'synced', last_synced_at = datetime('now')
             WHERE id = ?`,
            [item.task_id]
          );
        }

        processed_items.push({
          client_id: item.id, // <-- matches SyncService
          server_id: item.data?.server_id || '',
          status: 'success',
        });
      } catch (err: unknown) {
        processed_items.push({
          client_id: item.id,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          server_id: ''
        });
      }
    }

    return res.json({ processed_items });
  } catch (error: unknown) {
    return res.status(500).json({
      error: 'Batch sync failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

  // Health check endpoint
  router.get('/health', async (_req: Request, res: Response) => {
    return res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}
