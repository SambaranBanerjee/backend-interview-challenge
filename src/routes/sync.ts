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
      is_online: connectivity,
      sync_queue_size: pendingCount
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
        let serverId: string | null = null;
        let resolvedData: any = null;

        if (item.operation === 'create') {
          // Generate a server ID if not provided
          serverId = item.data.server_id || `srv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          await db.run(
            `INSERT INTO tasks (id, title, description, completed, created_at, updated_at, sync_status, server_id, last_synced_at)
             VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 'synced', ?, datetime('now'))`,
            [
              item.data.id,
              item.data.title,
              item.data.description || null,
              item.data.completed ? 1 : 0,
              serverId,
            ]
          );

          // Get the complete task data to return as resolved_data
          const createdTask = await db.get<{
            id: string;
            server_id: string;
            title: string;
            description: string | null;
            completed: number;
            created_at: string;
            updated_at: string;
          }>(
            `SELECT id, server_id, title, description, completed, created_at, updated_at 
             FROM tasks WHERE id = ?`,
            [item.data.id]
          );

          if (createdTask) {
            resolvedData = {
              id: createdTask.server_id, // Return server_id as the main ID
              title: createdTask.title,
              description: createdTask.description,
              completed: Boolean(createdTask.completed),
              created_at: createdTask.created_at,
              updated_at: createdTask.updated_at
            };
          }

        } else if (item.operation === 'update') {
          // Get the current server_id before updating
          const existingTask = await db.get<{ server_id: string }>(
            `SELECT server_id FROM tasks WHERE id = ?`,
            [item.task_id]
          );
          
          serverId = existingTask?.server_id || null;

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

          // Get the updated task data
          const updatedTask = await db.get<{
            server_id: string;
            title: string;
            description: string | null;
            completed: number;
            created_at: string;
            updated_at: string;
          }>(
            `SELECT server_id, title, description, completed, created_at, updated_at 
             FROM tasks WHERE id = ?`,
            [item.task_id]
          );

          if (updatedTask) {
            resolvedData = {
              id: updatedTask.server_id,
              title: updatedTask.title,
              description: updatedTask.description,
              completed: Boolean(updatedTask.completed),
              created_at: updatedTask.created_at,
              updated_at: updatedTask.updated_at
            };
          }

        } else if (item.operation === 'delete') {
          // Get the server_id before marking as deleted
          const existingTask = await db.get<{ server_id: string }>(
            `SELECT server_id FROM tasks WHERE id = ?`,
            [item.task_id]
          );
          
          serverId = existingTask?.server_id || null;

          await db.run(
            `UPDATE tasks
             SET is_deleted = 1, updated_at = datetime('now'),
                 sync_status = 'synced', last_synced_at = datetime('now')
             WHERE id = ?`,
            [item.task_id]
          );

          resolvedData = { id: serverId, deleted: true };
        }

        processed_items.push({
          client_id: item.task_id,
          server_id: serverId || '',
          status: 'success',
          resolved_data: resolvedData || item.data
        });

      } catch (err: unknown) {
        processed_items.push({
          client_id: item.task_id,
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
