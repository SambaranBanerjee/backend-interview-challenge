import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';

export class TaskService {

  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const id = uuidv4();
    const now = new Date();

    const newTask: Task = {
      id,
      title: taskData.title || '',
      description: taskData.description || undefined,
      completed: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
      server_id: null,
      last_synced_at: null,
    };

    await this.db.run(
      `INSERT INTO tasks 
        (id, title, description, completed, created_at, updated_at, is_deleted, sync_status, server_id, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newTask.id,
        newTask.title,
        newTask.description,
        newTask.completed ? true : false,
        newTask.created_at, 
        newTask.updated_at,
        newTask.is_deleted ? true : false,
        newTask.sync_status,
        newTask.server_id,
        newTask.last_synced_at,
      ]
    );

    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
      VALUES (?, ?, ?, ?, ?, 0)`,
      [
        uuidv4(),
        newTask.id,
        'create',
        JSON.stringify(newTask),
        now,
      ]
    );

    return newTask;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existing = await this.db.get(`SELECT * FROM tasks WHERE id = ? AND is_deleted = 0`, [id]);
    if (!existing) {
      return null;
    }
    const now = new Date();
    const updatedTask: Task = {
      ...(existing as Task),
      ...updates,
      updated_at: now,
      sync_status: 'pending',
    };
    await this.db.run(
    `UPDATE tasks 
       SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ?
     WHERE id = ?`,
    [
      updatedTask.title,
      updatedTask.description,
      updatedTask.completed ? true : false,
      updatedTask.updated_at,
      updatedTask.sync_status,
      id,
    ]
  );
  await this.db.run(
    `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [
      uuidv4(),
      id,
      'update',
      JSON.stringify(updatedTask),
      now,
    ]
  );

  return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    const existing = await this.db.get(`SELECT * FROM tasks WHERE id = ? AND is_deleted = 0`, [id]);
    if (!existing) {
      return false;
    }
    const now = new Date();
    await this.db.run(
      `UPDATE tasks 
         SET is_deleted = 1, updated_at = ?, sync_status = ?
       WHERE id = ?`,
      [
        now,
        'pending',
        id,
      ]
    );

    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [
        uuidv4(),
        id,
        'delete',
        JSON.stringify(existing),
        now,
      ]
    );

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const getTaskQuery = `SELECT * FROM tasks WHERE id = ? AND is_deleted = 0`;
    const task = await this.db.get(getTaskQuery, [id]);
    if (!task) {
      return null;
    }
    return task as Task;
  }

  async getAllTasks(): Promise<Task[]> {
    const getAllTasksQuery = `SELECT * FROM tasks WHERE is_deleted = 0`;
    const tasks = await this.db.all(getAllTasksQuery);
    return tasks as Task[];
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const getTasksNeedingSyncQuery = `SELECT * FROM tasks WHERE sync_status IN ('pending', 'error')`;
    const tasks = await this.db.all(getTasksNeedingSyncQuery);
    return tasks as Task[];
  }
}