# Backend Interview Challenge - Task Sync API

This is a backend developer interview challenge focused on building a sync-enabled task management API. The challenge evaluates understanding of REST APIs, data synchronization, offline-first architecture, and conflict resolution.

**#Solving Strategy**
1) routes/tasks.ts
   i) GET : got all the tasks checked them by !task and task.length === 0, returned message of failure containing  timestamp and path (At first I had missed the timestamp and path in the error message but later fixed it after checking the API calls).
   ii) POST : Got the title and description from the req.body validated them through zod middleware (I used zod as I had more experience with it and it worked very well with express) , the zod validation checked for title and kept description for optional part. Then I added the function to sync the req.
   iii) PUT : Again got title and description and this time along with completed from req.body , validated it through zod, kept all fields as optional as no change is necessary, then finally added it to sync.
   iv) DELETE : Called the deleteTask function from the taskService.ts file, checked if the deleted element is actually deleted by !deleted, if true returned Error message of not finding the task, if deleted then synching the data with addToSyncQueue function.  

2) routes/sync.ts
   i) post('/sync') : Checked the connection with checkConnectivity, called the sync function of syncService to sync the data and showed the success message. Checked the error (Over here I was facing the typescript problem of type, I then asked chatGPT for possible solutions on each change from unknown to any to null etc a new error was coming up, so in the end I made it into "instaceof Error" and the problem was solved) and gave appropriate message.
   ii) get('/status') : Created the SQL querries for row, pendingCount and lastSyncRow (here also I was facing the type error), then I checked for connection and finally returned a success message.
   iii) post('/batch') : Got the items and validated them of being empty or not being iterable, iterated through the items and created the SQL querry with proper error messages and output for different operations mentioned.

3) services/taskService.ts
   i) createTask : created id with uuidv4(), created the new task, created the SQL querry with the values as array inputs and added them first to the local database of tasks and then added them to the sync database.
   ii) updateTask : gets the existing task by it's id and validates it, then does the two required SQL querry operations UPDATE and INSERT. It returns the updated task.
   iii) deleteTask : Similiary like updateTask it gets the existing task by it's id,validates it and then does the SQL operations DELETE and INSERT.
4) services/syncService.ts
   i) sync : gets all the items from sync in order of created_at, creates batch based on the required size as per the .env file, chunks the data with the required batchsize. Then we iterate through the batch and as per the status either "success", "conflict" or else any other thing resolve it through respective methods. In case of success we update the data to the sync database and in case of conflict we call the resolve conflict function.
   ii) addToSyncQueue: Inserts data into the sync database based on it's operation type.
   iii) processBatch : It iterates over the processed batch of tasks and resolves them based on their status.
   iv) resolveConflict : Resolves conflict based on the server and the local update time.
   v) handleSyncError : handles retries based on max retry count and new retry count and updates the sync database.
   
## Project Structure

```
backend-interview-challenge/
├── src/
│   ├── db/             # Database setup and configuration
│   ├── models/         # Data models (if needed)
│   ├── services/       # Business logic (TO BE IMPLEMENTED)
│   ├── routes/         # API endpoints (TO BE IMPLEMENTED)
│   ├── middleware/     # Express middleware
│   ├── types/          # TypeScript interfaces
│   └── server.ts       # Express server setup
├── tests/              # Test files
├── docs/               # Documentation
└── package.json        # Dependencies and scripts
```

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn

### Setup
1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
4. Run the development server:
   ```bash
   npm run dev
   ```

## License

This project is for interview purposes only.
