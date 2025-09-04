import axios from 'axios';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

export class SyncService {
  private apiUrl: string;

  constructor(
    private readonly db: Database,
    private readonly taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
    this.taskService = taskService;
    this.db = db;
  }

  async sync(): Promise<SyncResult> {
    const items: SyncQueueItem[] = await this.db.all(`SELECT * FROM sync_queue ORDER BY created_at ASC`);
    if (items.length === 0) {
      return { success: true, synced_items: 0, failed_items: 0, errors: [] };
    }

    const batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '10', 10);
    let successful = 0;
    let failed = 0;

    const chunked = (arr: SyncQueueItem[], size: number) =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
        arr.slice(i * size, i * size + size)
      );

    const batches = chunked(items, batchSize);
    const errors: {
      task_id: string;
      operation: string;
      error: string;
      timestamp: Date;
    }[] = [];

    for (const batch of batches) {
      try {
        const response = await this.processBatch(batch);
        for (const result of response.processed_items) {
          if (result.status === 'success') {
            successful++;
            await this.updateSyncStatus(result.client_id, 'synced', result.resolved_data);
          } else if (result.status === 'conflict' && result.resolved_data) {
            successful++;
            await this.updateSyncStatus(result.client_id, 'synced', result.resolved_data);
          } else {
            failed++;
            errors.push({
              task_id: result.client_id,
              operation: 'unknown',
              error: result.error || 'Unknown error',
              timestamp: new Date(),
            });
            const item = batch.find(i => i.id === result.client_id);
            if (item) {
              await this.handleSyncError(item, new Error(result.error || 'Unknown error'));
            }
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        for (const item of batch) {
          failed++;
          errors.push({
            task_id: item.task_id,
            operation: item.operation,
            error: message,
            timestamp: new Date(),
          });
          await this.handleSyncError(item, new Error(message));
        }
      }
    }
    return { success: failed === 0, synced_items: successful, failed_items: failed, errors };
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const now = new Date();
    const syncItem: SyncQueueItem = {
      id: crypto.randomUUID(),
      task_id: taskId,
      operation,
      data,
      created_at: now,
      retry_count: 0,
    };
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [
        syncItem.id,
        syncItem.task_id,
        syncItem.operation,
        JSON.stringify(syncItem.data),
        now,
      ]
    );
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const batchRequest: BatchSyncRequest = {
      items: items.map(item => ({
        id: item.id,
        task_id: item.task_id,
        operation: item.operation,
        data: typeof item.data === 'string' ? JSON.parse(item.data) : item.data,
        created_at: item.created_at,
        retry_count: item.retry_count,
      })),
      client_timestamp: new Date(),
    };

    try {
      const response = await axios.post(`${this.apiUrl}/batch`, batchRequest);
      const batchResponse: BatchSyncResponse = response.data;

      for (const result of batchResponse.processed_items) {
        if (result.status === 'conflict' && result.resolved_data) {
          const resolved = await this.resolveConflict(
            await this.taskService.getTask(result.client_id) as Task,
            result.resolved_data
          );
          await this.db.run(
            `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ? WHERE id = ?`,
            [
              resolved.title,
              resolved.description,
              resolved.completed ? true : false,
              resolved.updated_at,
              'pending',
              resolved.id,
            ]
          );
          await this.addToSyncQueue(resolved.id, 'update', resolved);
        }
      }
      return batchResponse;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Batch sync failed: ${message}`);
    }
  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localUpdated = new Date(localTask.updated_at);
    const serverUpdated = new Date(serverTask.updated_at);

    const winner = localUpdated > serverUpdated ? localTask : serverTask;

    console.log(
      `[Conflict Resolution] Chose ${winner.id} (local updated_at=${localUpdated.toISOString()}, server updated_at=${serverUpdated.toISOString()})`
    );
    return winner;
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const now = new Date();
    const task = await this.taskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found for sync status update`);
    }
    const updateFields = ['sync_status = ?', 'last_synced_at = ?'];
    const params: (string | Date)[] = [status, now, taskId];

    if (serverData && serverData.server_id) {
      updateFields.push('server_id = ?');
      params.splice(2, 0, serverData.server_id);
    }

    const updateQuery = `UPDATE tasks SET ${updateFields.join(', ')} WHERE id = ?`;
    await this.db.run(updateQuery, params);

    if (status === 'synced') {
      await this.db.run(`DELETE FROM sync_queue WHERE task_id = ?`, [taskId]);
    }
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const maxRetries = parseInt(process.env.MAX_RETRY_COUNT || '5', 10);
    const newRetryCount = item.retry_count + 1;
    const errorMessage = error.message;

    if (newRetryCount >= maxRetries) {
      await this.db.run(
        `UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`,
        [newRetryCount, errorMessage, item.id]
      );
      await this.updateSyncStatus(item.task_id, 'error');
    } else {
      await this.db.run(
        `UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`,
        [newRetryCount, errorMessage, item.id]
      );
    }

    await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
    await this.db.run(`UPDATE tasks SET sync_status = 'error' WHERE id = ?`, [item.task_id]);

    console.error(`[Sync Error] Task ${item.task_id} operation ${item.operation} failed: ${errorMessage}`);
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      console.error('[Sync Service] Health check failed');
      return false;
    }
  }
}
