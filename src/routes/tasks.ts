import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { createTaskSchema, updateTaskSchema } from '../validation/taskSchema';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';
import { validate } from '../middleware/validate';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Get all tasks
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      if (!tasks || tasks.length === 0) {
        return res.status(404).json({ error: 'No task found',
          timestamp: new Date().toISOString(),
          path: "/api/tasks"
         });
      }
      return res.json(tasks);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found',
          timestamp: new Date().toISOString(),
          path: "/api/tasks/invalid-id"
         });
      }
      return res.json(task);
    } catch (error) {
      console.error('Error fetching task:', error);
      return res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // Create task
  router.post('/', validate(createTaskSchema), async (req: Request, res: Response) => {
    const { title, description } = req.body;
    try {
      const newTask = await taskService.createTask({ title, description });
      await syncService.addToSyncQueue(newTask.id, 'create', newTask);
      return res.status(201).json(newTask);
    } catch (error) {
      console.error('Error creating task:', error);
      return res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Update task
  router.put('/:id', validate(updateTaskSchema), async (req: Request, res: Response) => {
    const { title, description, completed } = req.body;
    try {
      const updatedTask = await taskService.updateTask(req.params.id, { title, description, completed });
      if (!updatedTask) {
        return res.status(404).json({ error: 'Task not found' });
      }
      await syncService.addToSyncQueue(updatedTask.id, 'update', updatedTask);
      return res.json(updatedTask);
    } catch (error) {
      console.error('Error updating task:', error);
      return res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const deleted = await taskService.deleteTask(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Task not found' });
      }
      await syncService.addToSyncQueue(req.params.id, 'delete', { id: req.params.id });
      return res.status(204).send();
    } catch (error) {
      console.error('Error deleting task:', error);
      return res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  return router;
}